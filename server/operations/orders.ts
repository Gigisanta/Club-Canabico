import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { registerCommand, OperationError, json, objectId, evidence, decimal, currency, minor, positiveMinor, requireDelivery, requireCapability, capabilities, touchAggregate, audit, type CommandContext } from "./core.js";
import { parseDecimal, parseQuantity, formatDecimal, roundHalfUp, canonicalJson } from "../../shared/operations/exact.js";
import { appsheetInvoiceInput, isAppSheetInvoiceTotalPending, type AppSheetInvoiceInput } from "../../shared/operations/appsheet.js";
import { APPSHEET_INVOICE_RULE_VERSION, APPSHEET_INVOICE_SOURCE_EXPRESSIONS, calculateAppSheetInvoiceFinancials } from "../../shared/operations/appsheet-invoice-rules.js";
import { quoteInput, quoteOrder, authorizeQuoteAdjustments } from "./commercial.js";
import { commercialAddress } from "./member-fields.js";
import { reserveOrder, prepareOrder, releaseOrderReservations, cancelOrderLines, dispatchOrder, deliverOrder, inspectOrderReturn } from "./stock.js";
import { postLedger, accountBalance } from "./finance.js";
import { applyAppSheetInvoiceSequenceSeed, reserveNewAppSheetInvoiceNumber, verifyExistingAppSheetInvoiceReservation } from "./appsheet-invoice-sequence.js";
const today=(now:Date)=>new Intl.DateTimeFormat("en-CA",{timeZone:"America/Argentina/Buenos_Aires"}).format(now);
async function draft(ctx:CommandContext){const order=await ctx.tx.operationOrder.findUniqueOrThrow({where:{id:ctx.envelope.targetId}});if(!["draft","preorder"].includes(order.commercialState))throw new OperationError(409,"CONFIRMED_QUOTE_FROZEN","La cotización confirmada requiere una revisión aceptada");return order;}

type StoredOrder = NonNullable<Awaited<ReturnType<CommandContext["tx"]["operationOrder"]["findUnique"]>>>;
async function confirmOrderSnapshot(ctx:CommandContext,order:StoredOrder,quote:Record<string,unknown>,options:{deliveryAddress?:Record<string,unknown>;acceptance?:Record<string,unknown>;financialState?:"paid"|"unpaid"}={}){
 const permission=await ctx.tx.memberPermission.findFirst({where:{memberId:order.memberId,kind:"operations",status:"verified",validFrom:{lte:today(ctx.now)},validUntil:{gte:today(ctx.now)}}});
 if(!permission)throw new OperationError(423,"MEMBER_PERMISSION_PENDING","El socio requiere un permiso operativo verificado y vigente");
 const reservations=await reserveOrder(ctx,order.id);
 await ctx.tx.operationOrder.update({where:{id:order.id},data:{commercialState:"confirmed",confirmedAt:ctx.now,quote:json({...quote,...(options.acceptance?{acceptance:options.acceptance}:{}),confirmedBy:ctx.actor.id,confirmedAt:ctx.now.toISOString()}),financialState:options.financialState??(order.totalMinor===0n?"paid":"unpaid")}});
 let deliveryId:string|null=null;
 if(order.channel==="delivery"){
  const existing=await ctx.tx.deliveryAssignment.count({where:{orderId:order.id}});
  if(existing)throw new OperationError(409,"ORDER_DELIVERY_EXISTS","El pedido ya tiene una entrega asociada");
  deliveryId=randomUUID();
  await ctx.tx.deliveryAssignment.create({data:{id:deliveryId,orderId:order.id,address:json(options.deliveryAddress??order.address as Record<string,unknown>),incidents:[]}});
  await ctx.tx.operationObject.create({data:{id:deliveryId,kind:"delivery",version:1,createdBy:ctx.actor.id}});
 }
 return {orderId:order.id,commercialState:"confirmed",reservations,deliveryId,quoteFrozen:true};
}

function checkInvoiceMinor(amount:bigint){
 if(!minor.safeParse(amount.toString()).success)throw new OperationError(422,"MONEY_RANGE","La factura excede el rango de importes cerrados");
 return amount;
}

// Unknown formula outputs stay null on the wire; omit only those placeholders
// when canonicalizing because the exact-money serializer accepts strings only.
const pendingAppSheetMinorFields=new Set(["subtotalMinor","productTransferMinor","totalMinor","transferMinor"]);
function appSheetQuoteCanonical(value:unknown):string{
 const omitPendingAmounts=(current:unknown):unknown=>{
  if(Array.isArray(current))return current.map(omitPendingAmounts);
  if(!current||typeof current!=="object")return current;
  return Object.fromEntries(Object.entries(current as Record<string,unknown>)
   .filter(([key,entry])=>!(entry===null&&pendingAppSheetMinorFields.has(key)))
   .map(([key,entry])=>[key,omitPendingAmounts(entry)]));
 };
 return canonicalJson(omitPendingAmounts(value));
}
function appSheetQuoteHash(quote:Record<string,unknown>){return createHash("sha256").update(appSheetQuoteCanonical(quote)).digest("hex");}

type InvoiceSku={id:string;unit:string;active:boolean;appSheet:unknown};
type AppSheetInvoiceCalculationOptions={replacement?:boolean;invoiceNumber?:string|null;evaluatedAt?:Date;numbering?:{captureId:string;id:bigint;year:number}};
function buildAppSheetInvoiceSnapshot(input:AppSheetInvoiceInput,skuById:Map<string,InvoiceSku>,options:AppSheetInvoiceCalculationOptions={}){
 const lines=input.lines.map(line=>{
  const sku=skuById.get(line.skuId);
  const appSheet=sku?.appSheet&&typeof sku.appSheet==="object"&&!Array.isArray(sku.appSheet)?sku.appSheet as {availability?:unknown}:{};
  if(!sku?.active||appSheet.availability==="NO"||sku.unit!=="g")throw new OperationError(422,"ORDER_SKU_UNAVAILABLE","El producto de la factura debe estar activo, disponible y expresado en gramos");
  let quantity:bigint;
  try{quantity=parseQuantity(line.quantity,sku.unit);}catch{throw new OperationError(422,"QUOTE_QUANTITY","La cantidad debe respetar la precisión de la unidad seleccionada");}
  if(quantity<=0n)throw new OperationError(422,"QUOTE_QUANTITY","La cantidad de la línea debe ser positiva");
  const total=checkInvoiceMinor(BigInt(line.totalMinor));
  // unitPrice is required by the shared order-line table for historical consumers;
  // reference/revenueMinor remain the authoritative entered total even if this
  // technical display price cannot reproduce every cent when multiplied back.
  const quantityScaled=parseDecimal(line.quantity,3);
  const unitPriceScaled=quantityScaled===0n?0n:roundHalfUp(total*10n**15n,quantityScaled*100n);
  return {
   id:line.id,skuId:sku.id,unit:sku.unit,requested:line.quantity,unitPrice:formatDecimal(unitPriceScaled,12),
   referenceMinor:total.toString(),discountMinor:"0",revenueMinor:total.toString(),
   appsheet:{date:line.date,scale:line.scale,explicitTotalMinor:total.toString()},
  };
 });
 const productTotal=lines.reduce((sum,line)=>sum+BigInt(line.revenueMinor),0n);
 const clientTariff=BigInt(input.moto?.clientTariffMinor??"0");
 const capturedBase=checkInvoiceMinor(productTotal+clientTariff);
 checkInvoiceMinor(productTotal);checkInvoiceMinor(clientTariff);
 const financials=options.replacement?calculateAppSheetInvoiceFinancials({
  subtotalMinor:productTotal,clientTariffMinor:clientTariff,paymentMethod:input.productPaymentMethod,currency:input.currency,
 }):null;
 if(financials){checkInvoiceMinor(financials.transferMinor);checkInvoiceMinor(financials.transferTotalMinor);checkInvoiceMinor(financials.totalMinor);}
 const effectiveInvoiceNumber=options.replacement?(options.invoiceNumber??input.invoiceNumber??null):(input.invoiceNumber??null);
 const effectiveInput=options.replacement?{...input,invoiceNumber:effectiveInvoiceNumber??undefined}:input;
 const formulaEvidence=financials?{
 schemaVersion:"appsheet-invoice-calculation/v1",ruleVersion:APPSHEET_INVOICE_RULE_VERSION,
  evaluatedAt:(options.evaluatedAt??new Date()).toISOString(),phase:"Form Saved · Recalcular_Factura",
  sourceExpressions:APPSHEET_INVOICE_SOURCE_EXPRESSIONS,
  numbering:options.numbering?{captureId:options.numbering.captureId,sequenceId:options.numbering.id.toString(),year:options.numbering.year,allocation:"transactional_sequence_reservation"}:null,
  results:{Cantidad_Gr:lines.reduce((sum,line)=>sum+parseQuantity(line.requested,"g"),0n).toString(),Subtotal_Venta:productTotal.toString(),
   Tarifa_Moto_Cliente:clientTariff.toString(),Transferencia:financials.transferMinor.toString(),
   Total_venta_Transferencia:financials.transferTotalMinor.toString(),Total_Facturado:financials.totalMinor.toString()},
  transfer:financials.transferCalculation,
 }:null;
 const quote={
  source:"appsheet-invoice",currency:input.currency,invoiceNumber:effectiveInvoiceNumber,invoiceDate:input.invoiceDate,note:input.note,
  lines:lines.map(({appsheet,...line})=>({...line,...appsheet})),
  subtotalMinor:financials?productTotal.toString():null,capturedProductMinor:productTotal.toString(),subtotalCalculationState:financials?"defined":"pending_definition",discountMinor:"0",deliveryMinor:clientTariff.toString(),deliveryDiscountMinor:"0",
  surchargeMinor:financials?financials.transferMinor.toString():"0",productTransferMinor:financials?financials.transferMinor.toString():null,capturedBaseMinor:capturedBase.toString(),totalMinor:financials?financials.totalMinor.toString():null,
  totalCalculationState:financials?"defined":"pending_definition",...(financials?{totalCalculationSource:"appsheet_recalculation_action",appSheetFormula:formulaEvidence}:{}),
  paymentComponents:{
   products:{paymentMethod:input.productPaymentMethod,transferMinor:financials?financials.transferMinor.toString():null,transferCalculationState:financials?"defined":"pending_definition",totalMinor:financials?financials.transferTotalMinor.toString():productTotal.toString()},
   moto:input.moto?{paymentMethod:input.moto.paymentMethod,transferMinor:null,transferCalculationState:"pending_definition",clientTariffMinor:input.moto.clientTariffMinor,totalTariffMinor:input.moto.totalTariffMinor,adminTariffMinor:input.moto.adminTariffMinor}:null,
  },
  moto:input.moto??null,quotedBy:null,quotedDate:input.invoiceDate,input:effectiveInput,
 };
 const deliveryAddress=input.moto?{
  ...input.address,motoDestination:input.moto.destination,motoDeliveryDate:input.moto.deliveryDate,motoServiceType:input.moto.serviceType,
 }:input.address;
 return {lines,quote,capturedBase,productTotal,clientTariff,surcharge:financials?.transferMinor??0n,total:financials?.totalMinor??capturedBase,deliveryAddress};
}

async function currentInvoiceAuthority(ctx:CommandContext){
 return ctx.tx.operationAuthority.findUnique({where:{id:"operations"},select:{cutoverProfile:true,captureManifestId:true}});
}

function invoiceNumberFromQuote(quote:Record<string,unknown>):string|null{
 return typeof quote.invoiceNumber==="string"?quote.invoiceNumber:null;
}

async function verifiedAppSheetSnapshot(ctx:CommandContext,order:StoredOrder,quote:Record<string,unknown>){
 const parsed=appsheetInvoiceInput.safeParse(quote.input);
 if(!parsed.success)throw new OperationError(409,"INVOICE_SNAPSHOT_INVALID","La factura pendiente no conserva un formulario AppSheet válido");
 const skuIds=[...new Set(parsed.data.lines.map(line=>line.skuId))];
 const skus=skuIds.length?await ctx.tx.catalogSku.findMany({where:{id:{in:skuIds}}}):[];
 const formulaEvidence=quote.appSheetFormula&&typeof quote.appSheetFormula==="object"&&!Array.isArray(quote.appSheetFormula)?quote.appSheetFormula as Record<string,unknown>:null;
 const replacement=Boolean(formulaEvidence?.ruleVersion===APPSHEET_INVOICE_RULE_VERSION);
 const authority=await currentInvoiceAuthority(ctx);
 if(replacement){
  const evaluatedAt=typeof formulaEvidence?.evaluatedAt==="string"?new Date(formulaEvidence.evaluatedAt):new Date(Number.NaN);
  if(!Number.isFinite(evaluatedAt.getTime()))throw new OperationError(409,"INVOICE_SNAPSHOT_INVALID","La instantánea no conserva el momento de cálculo de sus reglas AppSheet");
  const numbering=formulaEvidence?.numbering&&typeof formulaEvidence.numbering==="object"&&!Array.isArray(formulaEvidence.numbering)?formulaEvidence.numbering as Record<string,unknown>:null;
  const sequenceId=typeof numbering?.sequenceId==="string"&&/^[1-9]\d*$/.test(numbering.sequenceId)?BigInt(numbering.sequenceId):null;
  const sequenceYear=typeof numbering?.year==="number"&&Number.isInteger(numbering.year)?numbering.year:null;
  const sequenceCaptureId=typeof numbering?.captureId==="string"?numbering.captureId:null;
  if(sequenceId===null||sequenceYear===null||sequenceCaptureId===null)throw new OperationError(409,"INVOICE_SNAPSHOT_INVALID","La instantánea no conserva la reserva transaccional de su número.");
  if(authority?.cutoverProfile==="appsheet-replacement"&&authority.captureManifestId!==sequenceCaptureId)throw new OperationError(409,"INVOICE_SEQUENCE_CAPTURE_MISMATCH","La reserva no corresponde a la captura activa.");
  await verifyExistingAppSheetInvoiceReservation(ctx.tx,{captureId:sequenceCaptureId,orderId:order.id,invoiceNumber:invoiceNumberFromQuote(quote),generatedId:sequenceId,generatedYear:sequenceYear});
  const built=buildAppSheetInvoiceSnapshot(parsed.data,new Map(skus.map(sku=>[sku.id,sku])),{replacement:true,invoiceNumber:invoiceNumberFromQuote(quote),evaluatedAt,numbering:{captureId:sequenceCaptureId,id:sequenceId,year:sequenceYear}});
  if(appSheetQuoteCanonical(built.quote)!==appSheetQuoteCanonical(quote))throw new OperationError(409,"INVOICE_SNAPSHOT_CHANGED","La confirmación debe partir de la última factura AppSheet guardada");
  const [object,receipt]=await Promise.all([
   ctx.tx.operationObject.findUnique({where:{id:order.id},select:{version:true}}),
   ctx.tx.commandReceipt.findFirst({where:{targetId:order.id,command:{in:["InvoiceSaved","InvoiceUpdated"]}},orderBy:{resultingVersion:"desc"}}),
  ]);
  const result=(receipt?.response as {result?:{snapshotHash?:unknown;quoteVersion?:unknown}}|undefined)?.result;
  if(!object||!receipt||receipt.resultingVersion!==object.version||result?.quoteVersion!==order.quoteVersion||result?.snapshotHash!==appSheetQuoteHash(quote))
   throw new OperationError(409,"INVOICE_SNAPSHOT_CHANGED","La confirmación debe partir de la última factura AppSheet guardada");
  return built;
 }
 const built=buildAppSheetInvoiceSnapshot(parsed.data,new Map(skus.map(sku=>[sku.id,sku])));
 if(appSheetQuoteCanonical(built.quote)!==appSheetQuoteCanonical(quote))throw new OperationError(409,"INVOICE_SNAPSHOT_CHANGED","La instantánea de la factura cambió después de guardarse");
 const [object,receipt]=await Promise.all([
  ctx.tx.operationObject.findUnique({where:{id:order.id},select:{version:true}}),
  ctx.tx.commandReceipt.findFirst({where:{targetId:order.id,command:{in:["InvoiceSaved","InvoiceUpdated"]}},orderBy:{resultingVersion:"desc"}}),
 ]);
 const result=(receipt?.response as {result?:{snapshotHash?:unknown;quoteVersion?:unknown}}|undefined)?.result;
 if(!object||!receipt||receipt.resultingVersion!==object.version||result?.quoteVersion!==order.quoteVersion||result?.snapshotHash!==appSheetQuoteHash(quote))
  throw new OperationError(409,"INVOICE_SNAPSHOT_CHANGED","La confirmación debe partir de la última factura AppSheet guardada");
 return built;
}

registerCommand("InvoiceSaved",{kind:"order",capability:"orders.write",create:true,schema:appsheetInvoiceInput,execute:async ctx=>{
 const v=ctx.envelope.data as AppSheetInvoiceInput,authority=await currentInvoiceAuthority(ctx),replacement=authority?.cutoverProfile==="appsheet-replacement";
 if(await ctx.tx.operationOrder.findUnique({where:{id:ctx.envelope.targetId},select:{id:true}}))throw new OperationError(409,"INVOICE_ALREADY_EXISTS","La factura ya existe");
 if(replacement&&v.invoiceNumber?.trim())throw new OperationError(422,"APP_SHEET_MANUAL_INVOICE_NUMBER_REJECTED","En el perfil de reemplazo, el servidor asigna el número de factura al guardar.");
 if(replacement&&!authority?.captureManifestId)throw new OperationError(423,"APP_SHEET_INVOICE_SEQUENCE_CAPTURE_REQUIRED","La numeración requiere una captura verificada vinculada a la autoridad actual.");
 const member=await ctx.tx.operationMember.findUnique({where:{id:v.memberId}});
 if(!member)throw new OperationError(422,"MEMBER_REQUIRED","Elegí un socio identificado");
 const skuIds=[...new Set(v.lines.map(line=>line.skuId))],skus=await ctx.tx.catalogSku.findMany({where:{id:{in:skuIds}}});
 const skuById=new Map(skus.map(sku=>[sku.id,sku]));
 let effectiveInput=v,built:ReturnType<typeof buildAppSheetInvoiceSnapshot>;
 if(replacement){
  // The order FK exists before reservation; both the counter bump and this row
  // roll back if calculation, stock reservation, or confirmation later fails.
  await ctx.tx.operationOrder.create({data:{
   id:ctx.envelope.targetId,memberId:v.memberId,channel:v.moto?"delivery":"local",currency:v.currency,address:json(v.address),quote:{source:"appsheet-invoice",sequenceAssignment:"pending"},
   quoteVersion:1,subtotalMinor:0n,discountMinor:0n,deliveryMinor:0n,surchargeMinor:0n,totalMinor:0n,
   createdBy:ctx.actor.id,commercialState:v.preorder?"preorder":"draft",financialState:"unpaid",
  }});
  const assigned=await reserveNewAppSheetInvoiceNumber(ctx.tx,{captureId:authority!.captureManifestId!,orderId:ctx.envelope.targetId,now:ctx.now,actorId:ctx.actor.id});
  effectiveInput={...v,invoiceNumber:assigned.invoiceNumber};
  built=buildAppSheetInvoiceSnapshot(effectiveInput,skuById,{replacement:true,invoiceNumber:assigned.invoiceNumber,evaluatedAt:ctx.now,numbering:{captureId:authority!.captureManifestId!,id:assigned.id,year:assigned.year}});
  await ctx.tx.operationOrder.update({where:{id:ctx.envelope.targetId},data:{
   quote:json(built.quote),subtotalMinor:built.productTotal,discountMinor:0n,deliveryMinor:built.clientTariff,surchargeMinor:built.surcharge,totalMinor:built.total,
  }});
 }else{
  built=buildAppSheetInvoiceSnapshot(v,skuById);
  await ctx.tx.operationOrder.create({data:{
   id:ctx.envelope.targetId,memberId:v.memberId,channel:v.moto?"delivery":"local",currency:v.currency,address:json(v.address),quote:json(built.quote),
   quoteVersion:1,subtotalMinor:built.productTotal,discountMinor:0n,deliveryMinor:built.clientTariff,surchargeMinor:0n,totalMinor:built.capturedBase,
   createdBy:ctx.actor.id,commercialState:v.preorder?"preorder":"draft",financialState:"unpaid",
  }});
 }
 for(const line of built.lines)await ctx.tx.operationOrderLine.create({data:{
  id:line.id,orderId:ctx.envelope.targetId,skuId:line.skuId,unit:line.unit,requested:line.requested,unitPrice:line.unitPrice,
  referenceMinor:BigInt(line.referenceMinor),discountMinor:0n,revenueMinor:BigInt(line.revenueMinor),
 }});
 if(effectiveInput.preorder)return {orderId:ctx.envelope.targetId,commercialState:"preorder",deliveryId:null,reservations:null,quoteFrozen:false,quoteVersion:1,snapshotHash:appSheetQuoteHash(built.quote),invoiceNumber:built.quote.invoiceNumber};
 const order=await ctx.tx.operationOrder.findUniqueOrThrow({where:{id:ctx.envelope.targetId}});
 const result=await confirmOrderSnapshot(ctx,order,built.quote,{deliveryAddress:built.deliveryAddress,financialState:"unpaid"});
 return {...result,invoiceNumber:built.quote.invoiceNumber};
}});

registerCommand("InvoiceUpdated",{kind:"order",capability:"orders.write",schema:appsheetInvoiceInput,execute:async ctx=>{
 const v=ctx.envelope.data as AppSheetInvoiceInput,order=await ctx.tx.operationOrder.findUnique({where:{id:ctx.envelope.targetId}});
 if(!order||order.commercialState!=="preorder"||(order.quote as {source?:unknown}).source!=="appsheet-invoice")throw new OperationError(409,"INVOICE_NOT_EDITABLE","Sólo se puede modificar una factura pendiente de AppSheet");
 if(v.memberId!==order.memberId)throw new OperationError(403,"INVOICE_MEMBER_FROZEN","La preventa conserva el socio autorizado al crearla");
 const authority=await currentInvoiceAuthority(ctx),replacement=authority?.cutoverProfile==="appsheet-replacement";
 const previousQuote=order.quote as Record<string,unknown>,storedInvoiceNumber=invoiceNumberFromQuote(previousQuote);
 const priorReservation=await ctx.tx.appSheetInvoiceNumberReservation.findUnique({where:{orderId:order.id},select:{id:true}});
 const invoiceNumberLocked=replacement||Boolean(priorReservation);
 if(invoiceNumberLocked&&v.invoiceNumber!==undefined&&v.invoiceNumber!==storedInvoiceNumber)
  throw new OperationError(409,"INVOICE_NUMBER_IMMUTABLE","El número de factura queda fijado al crearla y no se puede editar.");
 if(replacement){
  if(!authority?.captureManifestId)throw new OperationError(423,"APP_SHEET_INVOICE_SEQUENCE_CAPTURE_REQUIRED","La numeración requiere una captura verificada vinculada a la autoridad actual.");
 }
 const effectiveInput=invoiceNumberLocked?{...v,invoiceNumber:storedInvoiceNumber??undefined}:v;
 const skuIds=[...new Set(v.lines.map(line=>line.skuId))],skus=skuIds.length?await ctx.tx.catalogSku.findMany({where:{id:{in:skuIds}}}):[];
 const formulaEvidence=previousQuote.appSheetFormula&&typeof previousQuote.appSheetFormula==="object"&&!Array.isArray(previousQuote.appSheetFormula)?previousQuote.appSheetFormula as Record<string,unknown>:null;
 const numbering=formulaEvidence?.numbering&&typeof formulaEvidence.numbering==="object"&&!Array.isArray(formulaEvidence.numbering)?formulaEvidence.numbering as Record<string,unknown>:null;
 const sequenceId=typeof numbering?.sequenceId==="string"&&/^[1-9]\d*$/.test(numbering.sequenceId)?BigInt(numbering.sequenceId):null;
 const sequenceYear=typeof numbering?.year==="number"&&Number.isInteger(numbering.year)?numbering.year:null;
 const sequenceCaptureId=typeof numbering?.captureId==="string"?numbering.captureId:null;
 if(replacement&&(sequenceId===null||sequenceYear===null||sequenceCaptureId!==authority?.captureManifestId))throw new OperationError(409,"INVOICE_SNAPSHOT_INVALID","La preventa no conserva la reserva y el momento de numeración necesarios para editarla.");
 if(invoiceNumberLocked){
  if(sequenceId===null||sequenceYear===null||sequenceCaptureId===null)throw new OperationError(409,"INVOICE_SNAPSHOT_INVALID","La factura numerada no conserva la identidad de su reserva.");
  await verifyExistingAppSheetInvoiceReservation(ctx.tx,{captureId:replacement?authority?.captureManifestId:sequenceCaptureId,orderId:order.id,invoiceNumber:storedInvoiceNumber,generatedId:sequenceId,generatedYear:sequenceYear});
 }
 const built=buildAppSheetInvoiceSnapshot(effectiveInput,new Map(skus.map(sku=>[sku.id,sku])),replacement?{replacement:true,invoiceNumber:storedInvoiceNumber,evaluatedAt:ctx.now,numbering:{captureId:sequenceCaptureId!,id:sequenceId!,year:sequenceYear!}}:{});
 await ctx.tx.operationOrderLine.deleteMany({where:{orderId:order.id}});
 for(const line of built.lines)await ctx.tx.operationOrderLine.create({data:{
  id:line.id,orderId:order.id,skuId:line.skuId,unit:line.unit,requested:line.requested,unitPrice:line.unitPrice,
  referenceMinor:BigInt(line.referenceMinor),discountMinor:0n,revenueMinor:BigInt(line.revenueMinor),
 }});
 const updated=await ctx.tx.operationOrder.update({where:{id:order.id},data:{
  currency:v.currency,address:json(v.address),quote:json(built.quote),quoteVersion:{increment:1},subtotalMinor:built.productTotal,discountMinor:0n,
  deliveryMinor:built.clientTariff,deliveryDiscountMinor:0n,surchargeMinor:built.surcharge,totalMinor:built.total,
  channel:v.moto?"delivery":"local",commercialState:"preorder",financialState:"unpaid",
 }});
 if(v.preorder)return {orderId:order.id,commercialState:"preorder",deliveryId:null,reservations:null,quoteFrozen:false,quoteVersion:updated.quoteVersion,snapshotHash:appSheetQuoteHash(built.quote),invoiceNumber:built.quote.invoiceNumber};
 const result=await confirmOrderSnapshot(ctx,updated,built.quote,{deliveryAddress:built.deliveryAddress,financialState:"unpaid"});
 return {...result,invoiceNumber:built.quote.invoiceNumber};
}});

const appSheetInvoiceSequenceSeedSchema=z.strictObject({captureId:z.string().regex(/^appsreal-[a-f0-9]{16}$/),snapshotId:z.string().min(1).max(120),previewDigest:z.string().regex(/^[a-f0-9]{64}$/),evidence:z.strictObject({note:z.string().trim().min(1).max(1000)})});
registerCommand("AppSheetInvoiceSequenceSeeded",{kind:"invoiceSequence",capability:"cutover.approve",create:true,administrative:true,schema:appSheetInvoiceSequenceSeedSchema,execute:async ctx=>{
 const value=ctx.envelope.data as z.infer<typeof appSheetInvoiceSequenceSeedSchema>;
 if(ctx.envelope.targetId!==value.captureId)throw new OperationError(409,"APP_SHEET_SEQUENCE_TARGET_MISMATCH","La identidad del comando debe ser la captura que se está sembrando.");
 return applyAppSheetInvoiceSequenceSeed(ctx.tx,value,ctx.actor,ctx.now);
}});

registerCommand("InvoiceConfirmed",{kind:"order",capability:"orders.write",schema:z.strictObject({acceptance:evidence}),execute:async ctx=>{
 const order=await ctx.tx.operationOrder.findUniqueOrThrow({where:{id:ctx.envelope.targetId}});
 if(order.commercialState!=="preorder")throw new OperationError(409,"INVOICE_NOT_PREORDER","Sólo se puede confirmar una factura pendiente");
 const quote=order.quote as Record<string,unknown>;
 if(quote.source!=="appsheet-invoice"||!Array.isArray(quote.lines)||!quote.lines.length)throw new OperationError(409,"INVOICE_SNAPSHOT_INVALID","La factura no contiene una instantánea AppSheet completa");
 await verifiedAppSheetSnapshot(ctx,order,quote);
 const snapshot=quote as typeof quote & {moto?:AppSheetInvoiceInput["moto"]};
 const deliveryAddress=snapshot.moto?{
  ...order.address as Record<string,unknown>,motoDestination:snapshot.moto.destination,motoDeliveryDate:snapshot.moto.deliveryDate,motoServiceType:snapshot.moto.serviceType,
 }:order.address as Record<string,unknown>;
 return confirmOrderSnapshot(ctx,order,quote,{deliveryAddress,acceptance:ctx.envelope.data.acceptance as Record<string,unknown>,financialState:"unpaid"});
}});

const invoiceTotalConfirmationSchema=z.strictObject({
 currency:z.enum(["ARS","USD"]),
 productsTotalMinor:positiveMinor,
 motoClientTotalMinor:minor,
 evidence:z.strictObject({note:z.string().trim().min(1).max(1000)}),
});
registerCommand("InvoiceTotalsConfirmed",{kind:"order",capability:"orders.write",schema:invoiceTotalConfirmationSchema,execute:async ctx=>{
 const order=await ctx.tx.operationOrder.findUnique({where:{id:ctx.envelope.targetId}});
 if(!order)throw new OperationError(404,"INVOICE_ORDER_NOT_FOUND","No se encontró la factura AppSheet");
 const rawQuote=order.quote;
 if(!rawQuote||typeof rawQuote!=="object"||Array.isArray(rawQuote))throw new OperationError(409,"INVOICE_SNAPSHOT_INVALID","La orden no conserva una instantánea de factura válida");
 const quote=rawQuote as Record<string,unknown>;
 if(quote.source!=="appsheet-invoice")throw new OperationError(409,"INVOICE_COMMAND_MISMATCH","El cierre manual sólo corresponde a facturas AppSheet");
 if(order.commercialState!=="confirmed")throw new OperationError(409,"INVOICE_NOT_CONFIRMED","Confirmá la factura antes de cerrar su total");
 if(quote.totalCalculationState!=="pending_definition"){
  if(quote.totalCalculationState==="defined"||quote.totalCalculationState==="staff_confirmed")
   throw new OperationError(409,"INVOICE_TOTAL_ALREADY_RESOLVED","La factura ya tiene un total conocido");
  throw new OperationError(409,"INVOICE_TOTAL_STATE_INVALID","La factura no está en un estado de total pendiente reconocido");
 }
 if(quote.financialResolution!==undefined&&quote.financialResolution!==null)
  throw new OperationError(409,"INVOICE_TOTAL_STATE_INVALID","La factura pendiente ya conserva un cierre financiero previo");
 const v=ctx.envelope.data as z.infer<typeof invoiceTotalConfirmationSchema>;
 if(order.currency!==v.currency||quote.currency!==v.currency)
  throw new OperationError(422,"INVOICE_TOTAL_CURRENCY","La moneda debe coincidir con la factura original");
 const hasMoto=quote.moto!==null&&quote.moto!==undefined;
 if(!hasMoto&&v.motoClientTotalMinor!=="0")
  throw new OperationError(422,"INVOICE_MOTO_TOTAL_WITHOUT_MOTO","Una factura sin moto debe confirmar cero para ese componente");
 const components=quote.paymentComponents;
 if(!components||typeof components!=="object"||Array.isArray(components))
  throw new OperationError(409,"INVOICE_SNAPSHOT_INVALID","La factura no conserva sus componentes de pago AppSheet");
 const paymentComponents=components as Record<string,unknown>;
 const products=paymentComponents.products;
 if(!products||typeof products!=="object"||Array.isArray(products))
  throw new OperationError(409,"INVOICE_SNAPSHOT_INVALID","La factura no conserva el componente de productos AppSheet");
 const moto=paymentComponents.moto;
 if(hasMoto&&(!moto||typeof moto!=="object"||Array.isArray(moto)))
  throw new OperationError(409,"INVOICE_SNAPSHOT_INVALID","La factura no conserva el componente de moto AppSheet");
 if(!hasMoto&&moto!==null)
  throw new OperationError(409,"INVOICE_SNAPSHOT_INVALID","Los componentes de pago no coinciden con la factura AppSheet");
 const productsTotal=BigInt(v.productsTotalMinor),motoClientTotal=BigInt(v.motoClientTotalMinor);
 const total=checkInvoiceMinor(productsTotal+motoClientTotal);
 const snapshotHash=appSheetQuoteHash(quote);
 const confirmedAt=ctx.now.toISOString();
 const financialResolution={
  kind:"staff_confirmation",currency:v.currency,productsTotalMinor:productsTotal.toString(),
  motoClientTotalMinor:motoClientTotal.toString(),totalMinor:total.toString(),evidence:v.evidence,
  actorId:ctx.actor.id,confirmedAt,quoteVersion:order.quoteVersion,snapshotHash,
 };
 const resolvedQuote={
  ...quote,totalMinor:total.toString(),totalCalculationState:"staff_confirmed",totalCalculationSource:"staff_confirmation",
  financialResolution,
  paymentComponents:{
   ...paymentComponents,
   products:{...(products as Record<string,unknown>),totalMinor:productsTotal.toString()},
   moto:hasMoto?{...(moto as Record<string,unknown>),clientTotalMinor:motoClientTotal.toString()}:moto,
  },
 };
 await ctx.tx.operationOrder.update({where:{id:order.id},data:{quote:json(resolvedQuote),totalMinor:total,financialState:"unpaid"}});
 return {orderId:order.id,commercialState:order.commercialState,currency:v.currency,totalMinor:total.toString(),totalCalculationState:"staff_confirmed",totalCalculationSource:"staff_confirmation",financialResolution};
}});

registerCommand("OrderCreated",{kind:"order",capability:"orders.write",create:true,schema:z.strictObject({memberId:objectId,channel:z.enum(["local","delivery"]),currency,address:commercialAddress.default({}),preorder:z.boolean().default(false)}),execute:async ctx=>{
 const v=ctx.envelope.data as {memberId:string;channel:string;currency:string;address:Record<string,unknown>;preorder:boolean};
 if(!await ctx.tx.operationMember.findUnique({where:{id:v.memberId}}))throw new OperationError(422,"MEMBER_REQUIRED","Elegí un socio identificado");
 return {order:await ctx.tx.operationOrder.create({data:{id:ctx.envelope.targetId,memberId:v.memberId,channel:v.channel,currency:v.currency,address:json(v.address),quote:{},createdBy:ctx.actor.id,commercialState:v.preorder?"preorder":"draft"}})};
}});
registerCommand("OrderQuoted",{kind:"order",capability:"orders.write",schema:quoteInput,authorize:authorizeQuoteAdjustments,execute:async ctx=>{
 const order=await draft(ctx);if((order.quote as {source?:unknown}).source==="appsheet-invoice")throw new OperationError(409,"INVOICE_COMMAND_MISMATCH","La factura AppSheet conserva sus importes explícitos; editála con InvoiceUpdated");const input=ctx.envelope.data as z.infer<typeof quoteInput>;
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
 if((order.quote as {source?:unknown}).source==="appsheet-invoice")throw new OperationError(409,"INVOICE_COMMAND_MISMATCH","La factura AppSheet conserva sus importes explícitos y no admite revisión genérica de cotización");
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
 if(r.status!=="planned"||r.closedWithPending)throw new OperationError(409,"DELIVERY_ROUTE_STATE","Sólo se pueden asignar entregas a una ruta programada y abierta");
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
 const route=await ctx.tx.deliveryRoute.findUniqueOrThrow({where:{id:ctx.envelope.targetId}});
 if(route.status!=="planned"||route.closedWithPending)throw new OperationError(409,"ROUTE_REORDER_STATE","Sólo se pueden reordenar las paradas de una ruta programada y abierta");
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
 const order=await ctx.tx.operationOrder.findUniqueOrThrow({where:{id:ctx.envelope.targetId},include:{lines:true}});
 if(isAppSheetInvoiceTotalPending(order.quote))throw new OperationError(423,"INVOICE_TOTAL_DEFINITION_PENDING","El total de factura AppSheet depende de fórmulas pendientes de cotejo");
 const account=await ctx.tx.operationAccount.findUniqueOrThrow({where:{id:ctx.envelope.data.accountId as string}}),amount=BigInt(ctx.envelope.data.amountMinor as string);
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
