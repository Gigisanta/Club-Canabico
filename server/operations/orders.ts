import { randomUUID } from "node:crypto";
import { z } from "zod";
import { registerCommand, OperationError, json, objectId, evidence, decimal, currency, minor, positiveMinor, requireDelivery, requireCapability, capabilities, touchAggregate, audit, type CommandContext } from "./core.js";
import { parseDecimal, roundHalfUp, canonicalJson } from "../../shared/operations/exact.js";
import { quoteInput, quoteOrder, authorizeQuoteAdjustments } from "./commercial.js";
import { commercialAddress } from "./member-fields.js";
import { reserveOrder, prepareOrder, releaseOrderReservations, cancelOrderLines, dispatchOrder, deliverOrder, inspectOrderReturn } from "./stock.js";
import { postLedger, accountBalance } from "./finance.js";
const today=(now:Date)=>new Intl.DateTimeFormat("en-CA",{timeZone:"America/Argentina/Buenos_Aires"}).format(now);
async function draft(ctx:CommandContext){const order=await ctx.tx.operationOrder.findUniqueOrThrow({where:{id:ctx.envelope.targetId}});if(!["draft","preorder"].includes(order.commercialState))throw new OperationError(409,"CONFIRMED_QUOTE_FROZEN","La cotización confirmada requiere una revisión aceptada");return order;}
registerCommand("OrderCreated",{kind:"order",capability:"orders.write",create:true,schema:z.strictObject({memberId:objectId,channel:z.enum(["local","delivery"]),currency,address:commercialAddress.default({}),preorder:z.boolean().default(false)}),execute:async ctx=>{
 const v=ctx.envelope.data as {memberId:string;channel:string;currency:string;address:Record<string,unknown>;preorder:boolean};
 if(!await ctx.tx.operationMember.findUnique({where:{id:v.memberId}}))throw new OperationError(422,"MEMBER_REQUIRED","Elegí un socio identificado");
 return {order:await ctx.tx.operationOrder.create({data:{id:ctx.envelope.targetId,memberId:v.memberId,channel:v.channel,currency:v.currency,address:json(v.address),quote:{},createdBy:ctx.actor.id,commercialState:v.preorder?"preorder":"draft"}})};
}});
registerCommand("OrderQuoted",{kind:"order",capability:"orders.write",schema:quoteInput,authorize:authorizeQuoteAdjustments,execute:async ctx=>{
 const order=await draft(ctx);const input=ctx.envelope.data as z.infer<typeof quoteInput>;
 if(order.currency!==input.currency)throw new OperationError(422,"QUOTE_CURRENCY","La cotización debe conservar la moneda del pedido");
 const quote=await quoteOrder(ctx.tx,input,today(ctx.now),ctx.actor.id);
 await ctx.tx.operationOrderLine.deleteMany({where:{orderId:order.id}});
 for(const line of quote.lines)await ctx.tx.operationOrderLine.create({data:{...line,id:line.id,orderId:order.id,requested:line.requested,referenceMinor:BigInt(line.referenceMinor),discountMinor:BigInt(line.discountMinor),revenueMinor:BigInt(line.revenueMinor)}});
 await ctx.tx.operationOrder.update({where:{id:order.id},data:{quote:json(quote),quoteVersion:{increment:1},subtotalMinor:BigInt(quote.subtotalMinor),discountMinor:BigInt(quote.discountMinor),deliveryMinor:BigInt(quote.deliveryMinor),deliveryDiscountMinor:BigInt(quote.deliveryDiscountMinor),surchargeMinor:BigInt(quote.surchargeMinor),totalMinor:BigInt(quote.totalMinor)}});
 return {quote};
}});
registerCommand("OrderConfirmed",{kind:"order",capability:"orders.write",schema:z.strictObject({quoteVersion:z.number().int().positive(),acceptance:evidence}),execute:async ctx=>{
 const order=await draft(ctx);const quote=order.quote as {lines?:unknown[];quotedDate?:string};
 if(order.quoteVersion!==ctx.envelope.data.quoteVersion||!quote.lines?.length)throw new OperationError(409,"QUOTE_VERSION","Revisá la cotización vigente");
 const permission=await ctx.tx.memberPermission.findFirst({where:{memberId:order.memberId,kind:"operations",status:"verified",validFrom:{lte:today(ctx.now)},validUntil:{gte:today(ctx.now)}}});
 if(!permission)throw new OperationError(423,"MEMBER_PERMISSION_PENDING","El socio requiere un permiso operativo verificado y vigente");
 // Approval belongs to the stored quote, not to the operator accepting it.
 // Recheck validity without recomputing prices or issuing another approval.
 const original=order.quote as unknown as {input:z.infer<typeof quoteInput>;quotedBy:string;lines:Array<{skuId:string;unit:string;policyId?:string;policyVersion?:number;packId?:string}>;promotionApplication?:{id:string;version:number}|null};
 const receipt=await ctx.tx.commandReceipt.findFirst({where:{targetId:order.id,command:"OrderQuoted"},orderBy:{resultingVersion:"desc"}});
 const recordedQuote=(receipt?.response as unknown as {result?:{quote?:unknown}}|undefined)?.result?.quote;
 if(!receipt||receipt.actorId!==original.quotedBy||!recordedQuote||canonicalJson(recordedQuote)!==canonicalJson(order.quote))throw new OperationError(423,"QUOTE_APPROVAL_PENDING","La cotización necesita una aprobación registrada que corresponda a esta versión");
 const date=today(ctx.now);
 for(const line of original.lines){
  const sku=await ctx.tx.catalogSku.findUnique({where:{id:line.skuId}});
  if(!sku?.active||sku.unit!==line.unit)throw new OperationError(422,"SKU_NOT_AVAILABLE","Producto no disponible");
  if(line.policyId){
   const policy=await ctx.tx.pricePolicy.findUnique({where:{id:line.policyId}});
   if(!policy||policy.status!=="approved"||policy.version!==line.policyVersion||policy.currency!==order.currency||policy.validFrom>date||policy.validUntil&&policy.validUntil<date)throw new OperationError(422,"POLICY_NOT_ACTIVE","Tarifa no aprobada o fuera de vigencia");
  }
  if(line.packId){
   const pack=await ctx.tx.commercialPack.findUnique({where:{id:line.packId}});
   if(!pack||pack.status!=="approved"||pack.version!==line.policyVersion||pack.currency!==order.currency||pack.validFrom>date||pack.validUntil&&pack.validUntil<date)throw new OperationError(422,"PACK_NOT_ACTIVE","Pack no aprobado o fuera de vigencia");
  }
 }
 if(original.promotionApplication){
  const promotion=await ctx.tx.commercialPromotion.findUnique({where:{id:original.promotionApplication.id}});
  if(!promotion||promotion.status!=="approved"||promotion.version!==original.promotionApplication.version||promotion.validFrom>date||promotion.validUntil<date)throw new OperationError(422,"PROMOTION_NOT_ACTIVE","Promoción no aprobada o fuera de vigencia");
 }
 const reservations=await reserveOrder(ctx,order.id);
 await ctx.tx.operationOrder.update({where:{id:order.id},data:{commercialState:"confirmed",confirmedAt:ctx.now,quote:json({...order.quote as object,acceptance:ctx.envelope.data.acceptance,confirmedBy:ctx.actor.id}),financialState:order.totalMinor===0n?"paid":"unpaid"}});
 let deliveryId:string|null=null;
 if(order.channel==="delivery"){
  deliveryId=randomUUID();await ctx.tx.deliveryAssignment.create({data:{id:deliveryId,orderId:order.id,address:order.address as object,incidents:[]}});
  await ctx.tx.operationObject.create({data:{id:deliveryId,kind:"delivery",version:1,createdBy:ctx.actor.id}});
 }
 return {orderId:order.id,commercialState:"confirmed",reservations,deliveryId,quoteFrozen:true};
}});
const allocation=z.strictObject({lineId:objectId,lotId:objectId,balanceId:objectId,requestedQuantity:decimal,actualQuantity:decimal});
registerCommand("OrderPrepared",{kind:"order",capability:"stock.prepare",schema:z.strictObject({allocations:z.array(allocation).min(1).max(500),evidence}),execute:async ctx=>{
 const order=await ctx.tx.operationOrder.findUniqueOrThrow({where:{id:ctx.envelope.targetId}});
 if(order.commercialState!=="confirmed")throw new OperationError(409,"ORDER_NOT_CONFIRMED","Confirmá el pedido antes de preparar");
 const result=await prepareOrder(ctx,order.id,ctx.envelope.data.allocations as z.infer<typeof allocation>[]);
 return {orderId:order.id,result};
}});
registerCommand("OrderLinesCancelled",{kind:"order",capability:"orders.write",schema:z.strictObject({lines:z.array(z.strictObject({lineId:objectId,quantity:decimal})).min(1).max(200),evidence}),execute:async ctx=>{
 const result=await cancelOrderLines(ctx,ctx.envelope.targetId,ctx.envelope.data.lines as Array<{lineId:string;quantity:string}>);
 await audit(ctx,"OrderLinesCancelled",{lines:ctx.envelope.data.lines,evidence:ctx.envelope.data.evidence});
 return {orderId:ctx.envelope.targetId,result};
}});
registerCommand("OrderReturnInspected",{kind:"order",capability:"stock.receive",schema:z.strictObject({returns:z.array(z.strictObject({lineId:objectId,allocationId:objectId,quantity:decimal,origin:z.enum(["customer","undelivered"]),disposition:z.enum(["restock","merma"]),locationId:objectId.optional(),custodianId:objectId.optional(),evidence})).min(1).max(200),evidence}),execute:async ctx=>{
 const result=await inspectOrderReturn(ctx,ctx.envelope.targetId,ctx.envelope.data.returns as Array<{lineId:string;allocationId:string;quantity:string;origin:"customer"|"undelivered";disposition:"restock"|"merma";locationId?:string;custodianId?:string;evidence:Record<string,unknown>}>);
 await audit(ctx,"OrderReturnInspected",{returns:ctx.envelope.data.returns,evidence:ctx.envelope.data.evidence});
 return {orderId:ctx.envelope.targetId,result,inspectedBy:ctx.actor.id,inspectedAt:ctx.now};
}});
registerCommand("OrderCancelled",{kind:"order",capability:"orders.write",schema:z.strictObject({reason:z.string().min(1).max(1000),evidence}),execute:async ctx=>{
 const order=await ctx.tx.operationOrder.findUniqueOrThrow({where:{id:ctx.envelope.targetId},include:{lines:true}});
 if(order.commercialState==="cancelled")throw new OperationError(409,"ORDER_ALREADY_CANCELLED","El pedido ya está cancelado");
 const dispatched=await ctx.tx.preparationAllocation.count({where:{orderId:order.id,state:{in:["dispatched","delivered","partially_delivered","partially_returned"]}}});
 if(dispatched||order.lines.some(l=>l.delivered.gt(0)))throw new OperationError(409,"PHYSICAL_RETURN_REQUIRED","Después del despacho, registrá devolución física e inspección");
 await releaseOrderReservations(ctx,order.id);
 await ctx.tx.operationOrder.update({where:{id:order.id},data:{commercialState:"cancelled",fulfillmentState:"cancelled"}});
 for(const line of order.lines)await ctx.tx.operationOrderLine.update({where:{id:line.id},data:{cancelled:line.requested}});
 await ctx.tx.deliveryAssignment.updateMany({where:{orderId:order.id},data:{status:"cancelled"}});
 return {orderId:order.id,status:"cancelled",refundRequired:order.verifiedMinor>order.refundedMinor};
}});
registerCommand("OrderQuoteRevisionAccepted",{kind:"order",capability:"orders.write",schema:z.strictObject({quote:quoteInput,acceptance:evidence,reason:z.string().min(1).max(1000)}),authorize:authorizeQuoteAdjustments,execute:async ctx=>{
 const order=await ctx.tx.operationOrder.findUniqueOrThrow({where:{id:ctx.envelope.targetId}});
 if(order.commercialState!=="confirmed"||order.fulfillmentState!=="unprepared")throw new OperationError(409,"QUOTE_REVISION_STATE","La revisión necesita un pedido confirmado todavía sin preparar");
 if(order.verifiedMinor!==0n)throw new OperationError(409,"QUOTE_REVISION_COLLECTION","El pedido tiene cobros; resolvé las diferencias financieras explícitamente");
 const quote=await quoteOrder(ctx.tx,ctx.envelope.data.quote as z.infer<typeof quoteInput>,today(ctx.now),ctx.actor.id);
 if(quote.currency!==order.currency)throw new OperationError(422,"QUOTE_CURRENCY","La revisión conserva la moneda");
 await releaseOrderReservations(ctx,order.id);await ctx.tx.operationOrderLine.deleteMany({where:{orderId:order.id}});
 for(const l of quote.lines)await ctx.tx.operationOrderLine.create({data:{...l,orderId:order.id,requested:l.requested,referenceMinor:BigInt(l.referenceMinor),discountMinor:BigInt(l.discountMinor),revenueMinor:BigInt(l.revenueMinor)}});
 await ctx.tx.operationOrder.update({where:{id:order.id},data:{quote:json({...quote,previousQuote:order.quote,acceptance:ctx.envelope.data.acceptance,reason:ctx.envelope.data.reason}),quoteVersion:{increment:1},subtotalMinor:BigInt(quote.subtotalMinor),discountMinor:BigInt(quote.discountMinor),deliveryMinor:BigInt(quote.deliveryMinor),deliveryDiscountMinor:BigInt(quote.deliveryDiscountMinor),surchargeMinor:BigInt(quote.surchargeMinor),totalMinor:BigInt(quote.totalMinor)}});
 await reserveOrder(ctx,order.id);
 return {orderId:order.id,oldTotalMinor:order.totalMinor,newTotalMinor:quote.totalMinor,differenceMinor:BigInt(quote.totalMinor)-order.totalMinor,acceptanceRecorded:true};
}});
registerCommand("RouteCreated",{kind:"route",capability:"logistics.write",create:true,schema:z.strictObject({driverId:objectId,shiftDate:z.iso.date(),custodianAccountId:objectId.optional()}),execute:async ctx=>{
 const v=ctx.envelope.data as {driverId:string;shiftDate:string;custodianAccountId?:string};const user=await ctx.tx.user.findUnique({where:{id:v.driverId}});
 if(!user?.active||!(await capabilities(ctx.tx,user)).includes("delivery.report"))throw new OperationError(422,"DRIVER_NOT_AUTHORIZED","El repartidor necesita autorización explícita");
 return {route:await ctx.tx.deliveryRoute.create({data:{id:ctx.envelope.targetId,...v}})};
}});
registerCommand("DeliveryAssigned",{kind:"delivery",capability:"logistics.write",schema:z.strictObject({routeId:objectId,driverId:objectId,stopSequence:z.number().int().min(0),windowStart:z.string().max(80).optional(),windowEnd:z.string().max(80).optional(),eta:z.string().max(100).optional(),evidence}),execute:async ctx=>{
 const v=ctx.envelope.data as {routeId:string;driverId:string;stopSequence:number;windowStart?:string;windowEnd?:string;eta?:string};
 const d=await ctx.tx.deliveryAssignment.findUniqueOrThrow({where:{id:ctx.envelope.targetId}}),r=await ctx.tx.deliveryRoute.findUniqueOrThrow({where:{id:v.routeId}});
 if(r.driverId!==v.driverId||!["pending","assigned"].includes(d.status))throw new OperationError(409,"DELIVERY_ASSIGNMENT_STATE","La ruta o entrega no permite la asignación");
 await audit(ctx,"delivery.assignment_evidence",{evidence:ctx.envelope.data.evidence});
 return {delivery:await ctx.tx.deliveryAssignment.update({where:{id:d.id},data:{routeId:v.routeId,driverId:v.driverId,stopSequence:v.stopSequence,windowStart:v.windowStart,windowEnd:v.windowEnd,eta:v.eta,status:"assigned",etaIsEstimate:true}})};
}});
registerCommand("DeliveryDispatched",{kind:"delivery",capability:"logistics.write",schema:z.strictObject({evidence}),execute:async ctx=>{
 const d=await ctx.tx.deliveryAssignment.findUniqueOrThrow({where:{id:ctx.envelope.targetId}});
 if(d.status!=="assigned"||!d.driverId)throw new OperationError(409,"DELIVERY_DISPATCH_STATE","La entrega requiere turno y repartidor asignados");
 const result=await dispatchOrder(ctx,d.orderId,d.driverId);
 await touchAggregate(ctx,d.orderId);
 return {delivery:await ctx.tx.deliveryAssignment.update({where:{id:d.id},data:{status:"dispatched",dispatchedAt:ctx.now}}),result};
}});
const fulfillment=z.strictObject({lineId:objectId,quantity:decimal,actualQuantity:decimal.optional()});
registerCommand("DeliveryRecorded",{kind:"delivery",capability:"delivery.report",schema:z.strictObject({lines:z.array(fulfillment).min(1).max(200),evidence}),authorize:async ctx=>{await requireDelivery(ctx,ctx.envelope.targetId);},execute:async ctx=>{
 const d=await requireDelivery(ctx,ctx.envelope.targetId);
 if(!["dispatched","partially_delivered"].includes(d.status))throw new OperationError(409,"DELIVERY_NOT_DISPATCHED","La entrega todavía no está bajo custodia de reparto");
 const result=await deliverOrder(ctx,d.orderId,ctx.envelope.data.lines as z.infer<typeof fulfillment>[]);
 const order=await ctx.tx.operationOrder.findUniqueOrThrow({where:{id:d.orderId}});
 const complete=order.fulfillmentState==="delivered";
 await ctx.tx.deliveryAssignment.update({where:{id:d.id},data:{status:complete?"delivered":"partially_delivered",deliveredAt:complete?ctx.now:undefined}});
 await touchAggregate(ctx,d.orderId);
 return {deliveryId:d.id,status:complete?"delivered":"partially_delivered",result};
}});
registerCommand("LocalPickupCompleted",{kind:"order",capability:"orders.write",schema:z.strictObject({lines:z.array(fulfillment).min(1).max(200),evidence}),execute:async ctx=>{
 const order=await ctx.tx.operationOrder.findUniqueOrThrow({where:{id:ctx.envelope.targetId}});
 if(order.channel!=="local")throw new OperationError(422,"LOCAL_PICKUP_CHANNEL","Este pedido corresponde a reparto");
 if(!["dispatched","partially_delivered"].includes(order.fulfillmentState))await dispatchOrder(ctx,order.id);
 return {result:await deliverOrder(ctx,order.id,ctx.envelope.data.lines as z.infer<typeof fulfillment>[])};
}});
registerCommand("DeliveryIncident",{kind:"delivery",capability:"delivery.report",schema:z.strictObject({kind:z.enum(["absent","late","address","damaged","other"]),note:z.string().min(1).max(2000),evidence}),authorize:async ctx=>{await requireDelivery(ctx,ctx.envelope.targetId);},execute:async ctx=>{
 const d=await requireDelivery(ctx,ctx.envelope.targetId);
 if(["cancelled","delivered"].includes(d.status))throw new OperationError(409,"DELIVERY_INCIDENT_STATE","La entrega ya está cerrada");
 const incidents=Array.isArray(d.incidents)?d.incidents:[];
 return {delivery:await ctx.tx.deliveryAssignment.update({where:{id:d.id},data:{incidents:json([...incidents,{...ctx.envelope.data,requestId:ctx.envelope.requestId,actorId:ctx.actor.id,reportedAt:ctx.now.toISOString(),occurredAt:ctx.envelope.occurredAt}])}})};
}});
registerCommand("RouteReordered",{kind:"route",capability:"logistics.write",schema:z.strictObject({deliveryIds:z.array(objectId).min(1).max(500),evidence}),execute:async ctx=>{
 const ids=ctx.envelope.data.deliveryIds as string[];if(new Set(ids).size!==ids.length)throw new OperationError(400,"ROUTE_DUPLICATES","Paradas repetidas");
 const assigned=await ctx.tx.deliveryAssignment.findMany({where:{routeId:ctx.envelope.targetId,status:{not:"cancelled"}}});
 if(assigned.length!==ids.length||assigned.some(d=>!ids.includes(d.id)))throw new OperationError(422,"ROUTE_SCOPE","Incluí todas las paradas asignadas");
 for(const [i,id] of ids.entries()){await ctx.tx.deliveryAssignment.update({where:{id},data:{stopSequence:i}});await ctx.tx.operationObject.update({where:{id},data:{version:{increment:1}}});}
 return {routeId:ctx.envelope.targetId,deliveryIds:ids,etaIsEstimate:true};
}});
registerCommand("RouteClosedWithPending",{kind:"route",capability:"logistics.write",schema:z.strictObject({backupId:z.uuid(),restorationEvidence:evidence}),execute:async ctx=>{
 const r=await ctx.tx.deliveryRoute.findUniqueOrThrow({where:{id:ctx.envelope.targetId}}),backup=await ctx.tx.offlineBackup.findUniqueOrThrow({where:{id:ctx.envelope.data.backupId as string}});
 if(backup.userId!==r.driverId)throw new OperationError(422,"ROUTE_BACKUP_SCOPE","La copia pertenece a otro repartidor");
 return {route:await ctx.tx.deliveryRoute.update({where:{id:r.id},data:{status:"closed_with_pending",closedWithPending:true,exportBackupId:backup.id}}),financiallySettled:false};
}});
registerCommand("ReturnedFulfillmentCancelled",{kind:"order",capability:"logistics.write",schema:z.strictObject({lines:z.array(z.strictObject({lineId:objectId,quantity:decimal})).min(1).max(200),reason:z.string().min(1).max(1000),evidence}),execute:async ctx=>{
 const order=await ctx.tx.operationOrder.findUniqueOrThrow({where:{id:ctx.envelope.targetId},include:{lines:true}}),allocations=await ctx.tx.preparationAllocation.findMany({where:{orderId:ctx.envelope.targetId}});
 const input=ctx.envelope.data.lines as {lineId:string;quantity:string}[];
 if(new Set(input.map(i=>i.lineId)).size!==input.length)throw new OperationError(422,"CANCELLATION_LINES","Las líneas deben ser únicas");
 for(const entry of input){
  const line=order.lines.find(l=>l.id===entry.lineId);if(!line)throw new OperationError(422,"CANCELLATION_LINE_SCOPE","La línea pertenece a otro pedido");
  const scale=line.unit==="g"?3:0,quantity=parseDecimal(entry.quantity,scale)*10n**BigInt(12-scale);
  const requested=parseDecimal(line.requested.toString(),12),cancelled=parseDecimal(line.cancelled.toString(),12),delivered=parseDecimal(line.delivered.toString(),12);
  const rows=allocations.filter(a=>a.lineId===line.id),prepared=rows.reduce((n,a)=>n+parseDecimal(a.requestedQuantity.toString(),12),0n);
  const returned=rows.reduce((n,a)=>{const actual=parseDecimal(a.actualQuantity.toString(),12);return n+(actual>0n?parseDecimal(a.requestedQuantity.toString(),12)*(parseDecimal(a.returnedQuantity.toString(),12)-parseDecimal(a.returnedDeliveredQuantity.toString(),12))/actual:0n);},0n);
  if(quantity<=0n||quantity>requested-delivered-cancelled||quantity>requested-prepared+returned-cancelled)throw new OperationError(422,"PHYSICAL_CANCELLATION_LIMIT","La cancelación está limitada a cantidades no preparadas o físicamente devueltas sin entregar");
  // Unprepared quantities use the stock cancellation command to release reservations.
  if(quantity>returned)throw new OperationError(422,"RESERVATION_CANCELLATION_REQUIRED","Cancelá las cantidades sin preparar con el comando de reservas");
  await ctx.tx.operationOrderLine.update({where:{id:line.id},data:{cancelled:{increment:entry.quantity}}});
 }
 const lines=await ctx.tx.operationOrderLine.findMany({where:{orderId:order.id}}),complete=lines.every(l=>l.delivered.add(l.cancelled).gte(l.requested));
 if(complete)await ctx.tx.operationOrder.update({where:{id:order.id},data:{fulfillmentState:"delivered"}});
 return {orderId:order.id,lines,cancelledOnlyAfterPhysicalInspection:true};
}});
registerCommand("OrderRefunded",{kind:"order",capability:"collections.verify",schema:z.strictObject({accountId:objectId,amountMinor:positiveMinor,lines:z.array(z.strictObject({lineId:objectId,amountMinor:positiveMinor})).max(200),deliveryMinor:minor.default("0"),surchargeMinor:minor.default("0"),reason:z.string().min(1).max(1000),evidence}),execute:async ctx=>{
 const order=await ctx.tx.operationOrder.findUniqueOrThrow({where:{id:ctx.envelope.targetId},include:{lines:true}}),account=await ctx.tx.operationAccount.findUniqueOrThrow({where:{id:ctx.envelope.data.accountId as string}}),amount=BigInt(ctx.envelope.data.amountMinor as string);
 if(account.currency!==order.currency||amount>order.verifiedMinor-order.refundedMinor)throw new OperationError(422,"REFUND_VERIFIED_LIMIT","El reintegro debe limitarse al importe verificado todavía reversible");
 if(await accountBalance(ctx.tx,account.id)<amount)throw new OperationError(422,"ACCOUNT_FUNDS","Saldo insuficiente");
 const selections=ctx.envelope.data.lines as {lineId:string;amountMinor:string}[],delivery=BigInt(ctx.envelope.data.deliveryMinor as string),surcharge=BigInt(ctx.envelope.data.surchargeMinor as string);
 if(new Set(selections.map(s=>s.lineId)).size!==selections.length||selections.reduce((n,l)=>n+BigInt(l.amountMinor),delivery+surcharge)!==amount)throw new OperationError(422,"REFUND_COMPONENTS","Las asignaciones sin duplicados deben explicar exactamente el reintegro");
 const allocations=await ctx.tx.preparationAllocation.findMany({where:{orderId:order.id}});
 for(const selection of selections){
  const line=order.lines.find(l=>l.id===selection.lineId);if(!line)throw new OperationError(422,"REFUND_LINE_SCOPE","La línea pertenece a otro pedido");
  let limit=line.revenueMinor;
  if(order.commercialState!=="cancelled"){
   const relevant=allocations.filter(a=>a.lineId===line.id);
   const returnedBilled=relevant.reduce((n,a)=>{const physical=parseDecimal(a.actualQuantity.toString(),12);return n+(physical>0n?parseDecimal(a.requestedQuantity.toString(),12)*parseDecimal(a.returnedDeliveredQuantity.toString(),12)/physical:0n);},0n);
   const eligible=returnedBilled+parseDecimal(line.cancelled.toString(),12),requested=parseDecimal(line.requested.toString(),12);
   limit=requested>0n?roundHalfUp(line.revenueMinor*(eligible>requested?requested:eligible),requested):0n;
  }
  if(BigInt(selection.amountMinor)>limit-line.refundedMinor)throw new OperationError(422,"REFUND_LINE_LIMIT","El importe supera la parte devuelta todavía reversible de la cotización congelada");
  await ctx.tx.operationOrderLine.update({where:{id:line.id},data:{refundedMinor:{increment:BigInt(selection.amountMinor)}}});
 }
 if(delivery>order.deliveryMinor-order.deliveryDiscountMinor-order.refundedDeliveryMinor||surcharge>order.surchargeMinor-order.refundedSurchargeMinor)throw new OperationError(422,"REFUND_CHARGE_LIMIT","El reintegro supera los cargos originales todavía reversibles");
 if((delivery>0n||surcharge>0n)&&order.commercialState!=="cancelled")await requireCapability(ctx.tx,ctx.actor,"prices.approve");
 const event=await postLedger(ctx,"refund",order.id,[{accountId:account.id,currency:account.currency,amountMinor:-amount}],{reason:ctx.envelope.data.reason,evidence:ctx.envelope.data.evidence,lines:selections,deliveryMinor:delivery.toString(),surchargeMinor:surcharge.toString()});
 await ctx.tx.operationOrder.update({where:{id:order.id},data:{refundedMinor:{increment:amount},refundedDeliveryMinor:{increment:delivery},refundedSurchargeMinor:{increment:surcharge},financialState:order.refundedMinor+amount===order.verifiedMinor?"refunded":"partially_refunded"}});
 return {event,amountMinor:amount};
}});
