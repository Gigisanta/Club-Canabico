import { Router } from "express";
import { Prisma, type AccountReconciliation } from "@prisma/client";
import { z } from "zod";
import { db } from "../db.js";
import { capabilities, requireCapability, executeCommand, commandSpecs, envelopeSchema, wire, OperationError, requireMemberScope, requireAccountScope, objectScope } from "./core.js";
import "./access.js";
import { projectAppSheetCatalogue } from "./appsheet-catalogue.js";
import { projectInvoiceAmount } from "./invoice-projection.js";
import "./commercial.js";
import "./finance.js";
import "./period-coverage.js";
import "./orders.js";
import { memberHistory } from "./member-history.js";
import { productHistory } from "./product-history.js";
import { resolveStockAvailability } from "./stock-availability.js";
import { manualReferenceDataRoutes } from "./reference-data.js";
import { buildOperationAccessSnapshot } from "./access-snapshot.js";
export const operationsRoutes=Router();
operationsRoutes.use(manualReferenceDataRoutes);
const areas:Record<string,string[]>={members:["member"],policies:["pricePolicy","pack","promotion"],packs:["pack"],promotions:["promotion"],tasks:["task"],accounts:["account","accountBootstrap","fx"],collections:["collection"],settlements:["rendition"],payables:["payable"],purchases:["purchase"],receipts:["receipt"],stock:["sku","stock","stockCount","lot"],orders:["order"],deliveries:["delivery"],routes:["route"],access:["access","device"],authority:["authority","cutover"],documents:["document","template"]};
operationsRoutes.get("/context",async(req,res)=>{
 const [grant,authority]=await Promise.all([
  db.operationAccess.findUnique({where:{userId:req.user.id}}),
  db.operationAuthority.findUnique({where:{id:"operations"}}),
 ]);
 const snapshot=buildOperationAccessSnapshot(req.user,grant,authority),caps=snapshot.capabilities;
 res.json({userId:req.user.id,profile:snapshot.profile,isOwner:snapshot.isOwner,canManageDecisionInputs:snapshot.canManageDecisionInputs,operationalApprovalConfigured:process.env.CLUB_OPERATIONS_APPROVED==="true",capabilities:caps,rehearsal:process.env.DEMO_MODE==="true"||process.env.NODE_ENV==="test"||process.env.OPERATIONAL_REHEARSAL==="true",authority:{mode:authority?.mode??"shadow",cutoverProfile:snapshot.cutoverProfile,epoch:authority?.epoch??1,firstRealWriteAt:authority?.firstRealWriteAt??null},timeZone:"America/Argentina/Buenos_Aires",commands:[...commandSpecs].filter(([,s])=>!s.internal&&caps.includes(s.capability)).map(([command,s])=>({command,kind:s.kind,create:Boolean(s.create)}))});
});
operationsRoutes.post("/commands",async(req,res)=>{
 const envelope=envelopeSchema.parse(req.body);
 if(commandSpecs.get(envelope.command)?.internal)throw new OperationError(403,"INTERNAL_COMMAND","Usá el lector del servidor para importar el archivo fuente.");
 res.json(await executeCommand(req.user,envelope));
});
operationsRoutes.get("/changes",async(req,res)=>{await requireCapability(db,req.user,"operations.read").catch(async()=>requireCapability(db,req.user,"delivery.report"));const states=await db.operationObject.findMany({where:{id:{in:[`readEpoch:${req.user.id}`,"readEpoch:operations"]}},select:{version:true,updatedAt:true}});res.json({version:states.reduce((sum,s)=>sum+s.version,0),updatedAt:states.sort((a,b)=>b.updatedAt.getTime()-a.updatedAt.getTime())[0]?.updatedAt??null});});
operationsRoutes.post("/:area/:id/commands",async(req,res)=>{
 const e=envelopeSchema.parse(req.body),area=String(req.params.area),id=String(req.params.id),spec=commandSpecs.get(e.command);
 if(spec?.internal)throw new OperationError(403,"INTERNAL_COMMAND","Usá el lector del servidor para importar el archivo fuente.");
 if(e.targetId!==id||!spec||!areas[area]?.includes(spec.kind))throw new OperationError(400,"COMMAND_TARGET_MISMATCH","El comando y la ruta no corresponden al mismo objeto");
 res.json(await executeCommand(req.user,e));
});
const pageSize=(query:unknown)=>z.coerce.number().int().min(1).max(200).parse(query??100);
const pageCursor=(query:unknown)=>z.string().min(1).max(100).optional().parse(query);
async function versions(ids:string[]){return Object.fromEntries((await db.operationObject.findMany({where:{id:{in:ids}},select:{id:true,version:true}})).map(o=>[o.id,o.version]));}
async function skuNamesForOrderLines(lines:Array<{skuId:string}>){
 const skuIds=[...new Set(lines.map(line=>line.skuId).filter(Boolean))];
 if(!skuIds.length)return new Map<string,string>();
 const skus=await db.catalogSku.findMany({where:{id:{in:skuIds}},select:{id:true,name:true}});
 return new Map(skus.map(sku=>[sku.id,sku.name] as const));
}
operationsRoutes.get("/members",async(req,res)=>{
 await requireCapability(db,req.user,"members.read");
 const q=z.string().max(120).parse(req.query.q??"");
 const scope=await objectScope(db,req.user);
 const limit=pageSize(req.query.limit),cursor=pageCursor(req.query.cursor);
 const where:Prisma.OperationMemberWhereInput={...(scope.memberIds?{id:{in:scope.memberIds}}:{}),...(q?{OR:[{name:{contains:q,mode:"insensitive"}},{email:{contains:q,mode:"insensitive"}},{phone:{contains:q}}]}:{})};
 if(cursor&&!await db.operationMember.findFirst({where:{AND:[where,{id:cursor}]},select:{id:true}}))throw new OperationError(400,"PAGE_CURSOR","La página debe reiniciarse con sus filtros actuales");
 const rows=await db.operationMember.findMany({where,orderBy:[{name:"asc"},{id:"asc"}],take:limit+1,...(cursor?{cursor:{id:cursor},skip:1}:{})});
 const hasMore=rows.length>limit,members=rows.slice(0,limit);
 res.json(wire({items:members,versions:await versions(members.map(m=>m.id)),hasMore,nextCursor:hasMore?members.at(-1)!.id:null}));
});
operationsRoutes.get("/members/:id",async(req,res)=>{
 await requireCapability(db,req.user,"members.read");const id=String(req.params.id);
 await requireMemberScope(db,req.user,id);
 const member=await db.operationMember.findUnique({where:{id}});if(!member)throw new OperationError(404,"MEMBER_NOT_FOUND","Socio no encontrado");
 const permissions=await db.memberPermission.findMany({where:{memberId:id},select:{id:true,kind:true,status:true,validFrom:true,validUntil:true,reviewerId:true,reviewedAt:true}});
 res.json(wire({member,permissions,version:(await versions([id]))[id]}));
});
operationsRoutes.get("/members/:id/history",async(req,res)=>{
 await requireCapability(db,req.user,"members.read");const id=String(req.params.id);await requireMemberScope(db,req.user,id);
 const limit=pageSize(req.query.limit),cursor=pageCursor(req.query.cursor);
 if(!await db.operationMember.findUnique({where:{id},select:{id:true}}))throw new OperationError(404,"MEMBER_NOT_FOUND","Socio no encontrado");
 if(cursor&&!await db.operationOrder.findFirst({where:{id:cursor,memberId:id},select:{id:true}}))throw new OperationError(400,"PAGE_CURSOR","La página debe reiniciarse en este socio");
 const historicalCursor=z.string().max(4096).optional().parse(req.query.historicalCursor);
 res.json(wire(await memberHistory(id,limit,cursor,historicalCursor)));
});
operationsRoutes.get("/people",async(req,res)=>{
 await requireCapability(db,req.user,"operations.read");
 const scope=await objectScope(db,req.user);
 const users=await db.user.findMany({where:{active:true,...(scope.custodianIds?{id:{in:scope.custodianIds}}:{})},select:{id:true,name:true,role:true},orderBy:[{name:"asc"},{id:"asc"}]});
 const grants=await db.operationAccess.findMany({where:{userId:{in:users.map(user=>user.id)}},select:{userId:true,profile:true,capabilities:true,enabled:true}});
 const byUser=new Map(grants.map(grant=>[grant.userId,grant]));
 res.json({items:users.map(user=>({id:user.id,name:user.name,profile:byUser.get(user.id)?.profile??user.role,canDeliver:Boolean(byUser.get(user.id)?.enabled&&Array.isArray(byUser.get(user.id)?.capabilities)&&(byUser.get(user.id)!.capabilities as string[]).includes("delivery.report"))}))});
});
operationsRoutes.get("/accounts/:id/reconciliations",async(req,res)=>{
 await requireCapability(db,req.user,"finance.read");const id=String(req.params.id);await requireAccountScope(db,req.user,[id]);
 if(!await db.operationAccount.findUnique({where:{id},select:{id:true}}))throw new OperationError(404,"ACCOUNT_NOT_FOUND","Cuenta no encontrada");
 const limit=pageSize(req.query.limit),cursor=pageCursor(req.query.cursor);
 if(cursor&&!await db.accountReconciliation.findFirst({where:{id:cursor,accountId:id},select:{id:true}}))throw new OperationError(400,"PAGE_CURSOR","El cursor no pertenece a esta cuenta");
 const rows=await db.accountReconciliation.findMany({where:{accountId:id},orderBy:[{createdAt:"desc"},{id:"desc"}],take:limit+1,...(cursor?{cursor:{id:cursor},skip:1}:{})});
 const items=rows.slice(0,limit);res.json(wire({items,nextCursor:rows.length>limit?items.at(-1)!.id:null,hasMore:rows.length>limit}));
});
operationsRoutes.get("/members/:id/clinical",async(req,res)=>{
 await requireCapability(db,req.user,"clinical.read");const id=String(req.params.id);
 await requireMemberScope(db,req.user,id);
 const clinical=await db.memberClinicalRecord.findUnique({where:{memberId:id}});
 await db.operationAudit.create({data:{actorId:req.user.id,action:"clinical.read",objectId:id,details:{}}});
 res.json({clinical});
});
operationsRoutes.get("/catalog",async(req,res)=>{
 await requireCapability(db,req.user,"stock.read").catch(async()=>requireCapability(db,req.user,"orders.write"));
 const scope=await objectScope(db,req.user),channel=z.enum(["local","delivery"]).parse(req.query.channel??"local");
 const limit=z.coerce.number().int().min(1).max(500).parse(req.query.limit??500),cursor=pageCursor(req.query.cursor),q=z.string().max(120).parse(req.query.q??"");
 const where:Prisma.CatalogSkuWhereInput={active:true,...(q?{OR:[{name:{contains:q,mode:"insensitive"}},{code:{contains:q,mode:"insensitive"}},{category:{contains:q,mode:"insensitive"}}]}:{})};
 if(cursor&&!await db.catalogSku.findFirst({where:{AND:[where,{id:cursor}]},select:{id:true}}))throw new OperationError(400,"PAGE_CURSOR","Reiniciá el catálogo con sus filtros actuales");
 const balanceScope:Prisma.StockBalanceWhereInput={...(scope.locationIds?{locationId:{in:scope.locationIds}}:{}),...(scope.custodianIds?{custodianId:{in:scope.custodianIds}}:{})};
 const skus=await db.catalogSku.findMany({where,orderBy:[{category:"asc"},{name:"asc"},{id:"asc"}],include:{lots:{where:{balances:{some:{...balanceScope,OR:[{quantity:{gt:0}},{reserved:{gt:0}}]}}},include:{balances:{where:balanceScope}}}},take:limit+1,...(cursor?{cursor:{id:cursor},skip:1}:{})});
 const visible=skus.slice(0,limit),caps=await capabilities(db,req.user);
 const asOf=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Argentina/Buenos_Aires"}).format(new Date());
 const availability=await resolveStockAvailability(db,{balances:visible.flatMap(s=>s.lots.flatMap(l=>l.balances.map(b=>({...b,lot:{skuId:s.id}})))),channel,asOf,rehearsal:process.env.DEMO_MODE==="true"||process.env.NODE_ENV==="test"||process.env.OPERATIONAL_REHEARSAL==="true"});
 const byBalance=new Map(availability.balances.map(b=>[b.balanceId,b]));
 const items=visible.map(s=>({...s,lots:s.lots.map(l=>({...l,unitCost:caps.includes("finance.read")||caps.includes("stock.read")?l.unitCost:null,balances:l.balances.map(b=>{const a=byBalance.get(b.id);return {...b,availableQuantity:a?.availableQuantity??"0",availabilityState:a?.state??"pending",availabilityReason:a?.reason??"Falta cobertura",availabilityVersion:a?.version??null};})}))}));
 res.json(wire({items,versions:await versions(visible.map(s=>s.id)),hasMore:skus.length>limit,nextCursor:skus.length>limit?visible.at(-1)!.id:null,channel,availabilityCoverage:availability.coverage,availability:"approved-location-custody-channel-minus-reservations"}));
});
operationsRoutes.get("/catalogue-sheets",async(req,res)=>{
 try{await requireCapability(db,req.user,"prices.propose");}
 catch(error){if(!(error instanceof OperationError)||error.code!=="CAPABILITY_REQUIRED")throw error;await requireCapability(db,req.user,"stock.adjust");}
 const q=z.string().max(120).parse(req.query.q??"");
 const limit=z.coerce.number().int().min(1).max(200).parse(req.query.limit??200),cursor=pageCursor(req.query.cursor);
 const where:Prisma.CatalogSkuWhereInput=q?{OR:[{code:{contains:q,mode:"insensitive"}},{name:{contains:q,mode:"insensitive"}},{variety:{contains:q,mode:"insensitive"}},{category:{contains:q,mode:"insensitive"}}]}:{};
 if(cursor&&!await db.catalogSku.findFirst({where:{AND:[where,{id:cursor}]},select:{id:true}}))throw new OperationError(400,"PAGE_CURSOR","Reiniciá el catálogo con la búsqueda actual");
 const found=await db.catalogSku.findMany({where,select:{id:true,code:true,name:true,variety:true,category:true,unit:true,active:true,appSheet:true},orderBy:[{category:"asc"},{name:"asc"},{id:"asc"}],take:limit+1,...(cursor?{cursor:{id:cursor},skip:1}:{})});
 const items=found.slice(0,limit).map(sku=>({...sku,appSheet:projectAppSheetCatalogue(sku.appSheet)}));
 res.json(wire({items,versions:await versions(items.map(sku=>sku.id)),hasMore:found.length>limit,nextCursor:found.length>limit?items.at(-1)!.id:null}));
});
operationsRoutes.get("/catalog/:id/history",async(req,res)=>{
 await requireCapability(db,req.user,"stock.read");
 const historicalCursor=z.string().max(4096).optional().parse(req.query.historicalCursor);
 res.json(wire(await productHistory(String(req.params.id),pageSize(req.query.limit),await objectScope(db,req.user),(await capabilities(db,req.user)).includes("finance.read"),pageCursor(req.query.cursor),historicalCursor)));
});
operationsRoutes.get("/orders",async(req,res)=>{
 await requireCapability(db,req.user,"operations.read");const state=z.string().max(30).optional().parse(req.query.state);
 const scope=await objectScope(db,req.user);
 const limit=pageSize(req.query.limit??200),cursor=pageCursor(req.query.cursor);
 const where:Prisma.OperationOrderWhereInput={...(state?{commercialState:state}:{}),...(scope.memberIds?{memberId:{in:scope.memberIds}}:{})};
 if(cursor&&!await db.operationOrder.findFirst({where:{AND:[where,{id:cursor}]},select:{id:true}}))throw new OperationError(400,"PAGE_CURSOR","Reiniciá los pedidos con sus filtros actuales");
 const rows=await db.operationOrder.findMany({where,include:{lines:true},orderBy:[{createdAt:"desc"},{id:"desc"}],take:limit+1,...(cursor?{cursor:{id:cursor},skip:1}:{})});
 const orders=rows.slice(0,limit);
 const skuNameById=await skuNamesForOrderLines(orders.flatMap(order=>order.lines));
 const financial=(await capabilities(db,req.user)).includes("finance.read");
 const items=orders.map(o=>({...projectInvoiceAmount(o),lines:o.lines.map(l=>({...l,skuName:skuNameById.get(l.skuId)??null,costMinor:financial?l.costMinor:null}))}));
 res.json(wire({items,versions:await versions(orders.map(o=>o.id)),hasMore:rows.length>limit,nextCursor:rows.length>limit?orders.at(-1)!.id:null}));
});
operationsRoutes.get("/orders/:id",async(req,res)=>{
 await requireCapability(db,req.user,"operations.read");const id=String(req.params.id);
 const order=await db.operationOrder.findUnique({where:{id},include:{lines:true}});if(!order)throw new OperationError(404,"ORDER_NOT_FOUND","Pedido no encontrado");
 await requireMemberScope(db,req.user,order.memberId);
 const skuNameById=await skuNamesForOrderLines(order.lines);
 const caps=await capabilities(db,req.user),financial=caps.includes("finance.read"),scope=await objectScope(db,req.user);
 const balanceScope:Prisma.StockBalanceWhereInput={...(scope.locationIds?{locationId:{in:scope.locationIds}}:{}),...(scope.custodianIds?{custodianId:{in:scope.custodianIds}}:{})};
 const visibleBalances=scope.locationIds||scope.custodianIds?await db.stockBalance.findMany({where:balanceScope,select:{id:true}}):null;
 const reservations=caps.includes("stock.prepare")?await db.stockReservation.findMany({where:{orderId:id,status:"active",...(visibleBalances?{balanceId:{in:visibleBalances.map(balance=>balance.id)}}:{})},select:{id:true,lineId:true,balanceId:true,quantity:true,consumed:true}}):[];
 const reservationBalanceIds=[...new Set(reservations.map(reservation=>reservation.balanceId))];
 const reservationBalances=reservationBalanceIds.length?await db.stockBalance.findMany({where:{id:{in:reservationBalanceIds},...balanceScope},select:{id:true,lotId:true,unit:true,lot:{select:{label:true,skuId:true,sku:{select:{name:true}}}}}}):[];
 const reservationBalanceById=new Map(reservationBalances.map(balance=>[balance.id,{id:balance.id,lotId:balance.lotId,skuId:balance.lot.skuId,skuName:balance.lot.sku.name,unit:balance.unit,lotLabel:balance.lot.label}] as const));
 const enrichedReservations=reservations.map(reservation=>({...reservation,balance:reservationBalanceById.get(reservation.balanceId)??null}));
 res.json(wire({order:{...projectInvoiceAmount(order),lines:order.lines.map(l=>({...l,skuName:skuNameById.get(l.skuId)??null,costMinor:financial?l.costMinor:null}))},reservations:enrichedReservations,allocations:await db.preparationAllocation.findMany({where:{orderId:id,...(visibleBalances?{balanceId:{in:visibleBalances.map(b=>b.id)}}:{})},select:{id:true,lineId:true,lotId:true,balanceId:true,requestedQuantity:true,actualQuantity:true,deliveredQuantity:true,returnedQuantity:true,returnedDeliveredQuantity:true,state:true}}),deliveries:await db.deliveryAssignment.findMany({where:{orderId:id}}),version:(await versions([id]))[id]}));
});
operationsRoutes.get("/purchases",async(req,res)=>{
 await requireCapability(db,req.user,"purchases.write");const limit=pageSize(req.query.limit??200),cursor=pageCursor(req.query.cursor);
 if(cursor&&!await db.purchaseOrder.findUnique({where:{id:cursor},select:{id:true}}))throw new OperationError(400,"PAGE_CURSOR","Reiniciá las compras con sus filtros actuales");
 const found=await db.purchaseOrder.findMany({orderBy:[{agreementDate:"desc"},{id:"desc"}],take:limit+1,...(cursor?{cursor:{id:cursor},skip:1}:{})}),rows=found.slice(0,limit);
 res.json(wire({items:rows,versions:await versions(rows.map(r=>r.id)),receipts:await db.goodsReceipt.findMany({where:{purchaseId:{in:rows.map(r=>r.id)}}}),hasMore:found.length>limit,nextCursor:found.length>limit?rows.at(-1)!.id:null}));
});
operationsRoutes.get("/stock/reference-data",async(req,res)=>{
 await requireCapability(db,req.user,"stock.read");const scope=await objectScope(db,req.user);
 const [locations,suppliers,custodians]=await Promise.all([db.location.findMany({where:{active:true,...(scope.locationIds?{id:{in:scope.locationIds}}:{})},select:{id:true,name:true}}),db.supplier.findMany({where:{active:true},select:{id:true,name:true}}),db.user.findMany({where:{active:true,...(scope.custodianIds?{id:{in:scope.custodianIds}}:{})},select:{id:true,name:true}})]);res.json({locations,suppliers,custodians});
});
operationsRoutes.get("/stock/counts",async(req,res)=>{
 await requireCapability(db,req.user,"stock.read");const scope=await objectScope(db,req.user),balances=scope.locationIds||scope.custodianIds?await db.stockBalance.findMany({where:{...(scope.locationIds?{locationId:{in:scope.locationIds}}:{}),...(scope.custodianIds?{custodianId:{in:scope.custodianIds}}:{})},select:{id:true}}):null;
 const items=await db.operationalStockCount.findMany({where:balances?{balanceId:{in:balances.map(b=>b.id)}}:{},orderBy:{countedAt:"desc"},take:200});res.json(wire({items,versions:await versions(items.map(r=>r.id))}));
});
operationsRoutes.get("/policies",async(req,res)=>{await requireCapability(db,req.user,"prices.propose").catch(async()=>requireCapability(db,req.user,"orders.write"));const [policies,packs,promotions]=await Promise.all([db.pricePolicy.findMany(),db.commercialPack.findMany(),db.commercialPromotion.findMany()]);res.json(wire({policies,packs,promotions,versions:await versions([...policies,...packs,...promotions].map(r=>r.id))}));});
operationsRoutes.get("/tasks",async(req,res)=>{await requireCapability(db,req.user,"operations.read");const items=await db.operationTask.findMany({orderBy:{dueDate:"asc"},take:200});res.json(wire({items,versions:await versions(items.map(r=>r.id))}));});
operationsRoutes.get("/accounts",async(req,res)=>{
 await requireCapability(db,req.user,"finance.read");const scope=await objectScope(db,req.user);const accounts=await db.operationAccount.findMany({where:{active:true,...(scope.accountIds?{id:{in:scope.accountIds}}:{})},orderBy:[{currency:"asc"},{name:"asc"}]});
 // Bootstrap needs a global empty ledger of club accounts, including inactive
 // accounts. A scoped empty list cannot prove that prerequisite. The command
 // repeats this check transactionally before creating anything.
 const accountBootstrapEligible=(await capabilities(db,req.user)).includes("accounts.write")&&scope.accountIds===undefined&&await db.operationAccount.count({where:{kind:{not:"custody"}}})===0;
 const ids=accounts.map(a=>a.id);
 const [sums,reconciliations]=await Promise.all([
   db.ledgerLeg.groupBy({by:["accountId"],where:{accountId:{in:ids}},_sum:{amountMinor:true}}),
   ids.length?db.$queryRaw<AccountReconciliation[]>(Prisma.sql`SELECT DISTINCT ON ("accountId") * FROM "AccountReconciliation" WHERE "accountId" IN (${Prisma.join(ids)}) ORDER BY "accountId", "createdAt" DESC, "id" DESC`):Promise.resolve([]),
 ]);
 const sumById=new Map(sums.map(s=>[s.accountId,s._sum.amountMinor??0n])),reconciliationById=new Map(reconciliations.map(r=>[r.accountId,r]));
 const items=accounts.map(a=>({...a,balanceMinor:a.verified&&a.openingApprovedBy?sumById.get(a.id)??0n:null,coverage:a.verified&&a.openingApprovedBy?"approved_opening_and_events":"opening_pending",reconciliation:reconciliationById.get(a.id)??null}));
 res.json(wire({items,versions:await versions(ids),currenciesCombined:false,accountBootstrapEligible}));
});
operationsRoutes.get("/accounts/:id/ledger",async(req,res)=>{
 await requireCapability(db,req.user,"finance.read");const id=String(req.params.id);await requireAccountScope(db,req.user,[id]);
 const limit=pageSize(req.query.limit),cursor=pageCursor(req.query.cursor);
 if(cursor&&!await db.ledgerLeg.findFirst({where:{id:cursor,accountId:id},select:{id:true}}))throw new OperationError(400,"PAGE_CURSOR","La página debe reiniciarse en esta cuenta");
 const rows=await db.ledgerLeg.findMany({where:{accountId:id},include:{event:true},orderBy:[{event:{occurredAt:"desc"}},{id:"desc"}],take:limit+1,...(cursor?{cursor:{id:cursor},skip:1}:{})});
 const hasMore=rows.length>limit,items=rows.slice(0,limit);
 res.json(wire({items,hasMore,nextCursor:hasMore?items.at(-1)!.id:null}));
});
operationsRoutes.get("/collections",async(req,res)=>{
 await requireCapability(db,req.user,"finance.read");const scope=await objectScope(db,req.user);
 const memberOrders=scope.memberIds?await db.operationOrder.findMany({where:{memberId:{in:scope.memberIds}},select:{id:true}}):null;
 const pendingAuthorized=Boolean(memberOrders||scope.custodianIds);
 const status=z.enum(["reported","verified","rejected"]).optional().parse(req.query.status);
 const items=await db.collectionReport.findMany({where:{...(status?{status}:{}),...(scope.accountIds?{OR:[{accountId:{in:scope.accountIds}},...(pendingAuthorized?[{accountId:null,status:{in:["reported","rejected"]}}]:[])]}:{}),...(memberOrders?{orderId:{in:memberOrders.map(o=>o.id)}}:{}),...(scope.custodianIds?{custodianId:{in:scope.custodianIds}}:{})},orderBy:{id:"desc"},take:201});
 const hasMore=items.length>200;
 res.json(wire({items:items.slice(0,200),hasMore,versions:await versions(items.slice(0,200).map(r=>r.id)),pendingScopeRequired:Boolean(scope.accountIds&&!pendingAuthorized),pendingScope:"explicit_member_or_custodian"}));
});
operationsRoutes.get("/settlements",async(req,res)=>{await requireCapability(db,req.user,"finance.read");const scope=await objectScope(db,req.user);const items=await db.rendition.findMany({where:scope.accountIds?{fromAccountId:{in:scope.accountIds},toAccountId:{in:scope.accountIds}}:{},orderBy:{acceptedAt:"desc"},take:200});res.json(wire({items}));});
operationsRoutes.get("/payables",async(req,res)=>{await requireCapability(db,req.user,"finance.read");const scope=await objectScope(db,req.user);if(scope.accountIds||scope.memberIds)throw new OperationError(403,"REPORT_SCOPE","La vista general de obligaciones requiere alcance financiero completo");const open=z.enum(["true","false"]).optional().parse(req.query.open),verified=z.enum(["true","false"]).optional().parse(req.query.verified);const rows=await db.operationPayable.findMany({where:{...(open?{amountMinor:{[open==="true"?"gt":"lte"]:db.operationPayable.fields.paidMinor}}:{}),...(verified?{verified:verified==="true"}:{})},orderBy:[{dueDate:"asc"},{id:"asc"}],take:501});const items=rows.slice(0,500);res.json(wire({items,hasMore:rows.length>500,versions:await versions(items.map(r=>r.id))}));});
operationsRoutes.get("/routes",async(req,res)=>{
 await requireCapability(db,req.user,"logistics.write");const scope=await objectScope(db,req.user);
 if(scope.memberIds)throw new OperationError(403,"ROUTE_SCOPE","La coordinación general de rutas requiere alcance comercial completo");
 const items=await db.deliveryRoute.findMany({where:scope.custodianIds?{driverId:{in:scope.custodianIds}}:{},orderBy:[{shiftDate:"desc"},{id:"desc"}],take:100});
 const unassignedCursor=pageCursor(req.query.unassignedCursor),limit=pageSize(req.query.limit??200);
 const unassignedWhere:Prisma.DeliveryAssignmentWhereInput={routeId:null,status:{notIn:["cancelled","delivered","returned"]},...(scope.custodianIds?{driverId:{in:scope.custodianIds}}:{})};
 if(unassignedCursor&&!await db.deliveryAssignment.findFirst({where:{AND:[unassignedWhere,{id:unassignedCursor}]},select:{id:true}}))throw new OperationError(400,"PAGE_CURSOR","Reiniciá la cola con su asignación actual");
 const [deliveries,unassignedDeliveries]=await Promise.all([
   db.deliveryAssignment.findMany({where:{routeId:{in:items.map(r=>r.id)}},orderBy:[{routeId:"asc"},{stopSequence:"asc"},{id:"asc"}]}),
   db.deliveryAssignment.findMany({where:unassignedWhere,orderBy:{id:"asc"},take:limit+1,...(unassignedCursor?{cursor:{id:unassignedCursor},skip:1}:{})}),
 ]);
 res.json(wire({items,deliveries,unassignedDeliveries:unassignedDeliveries.slice(0,limit),unassignedHasMore:unassignedDeliveries.length>limit,unassignedNextCursor:unassignedDeliveries.length>limit?unassignedDeliveries[limit-1]!.id:null,versions:await versions([...items,...deliveries,...unassignedDeliveries.slice(0,limit)].map(r=>r.id))}));
});
operationsRoutes.get("/access",async(req,res)=>{await requireCapability(db,req.user,"access.manage");res.json({users:await db.user.findMany({select:{id:true,name:true,role:true,active:true,authorizationEpoch:true}}),grants:await db.operationAccess.findMany(),devices:await db.operationDevice.findMany(),profiles:Object.keys((await import("../../shared/operations/contracts.js")).profileCapabilities)});});
operationsRoutes.get("/authority",async(req,res)=>{
 await requireCapability(db,req.user,"cutover.approve");
 const [authority,gates,captures]=await Promise.all([
  db.operationAuthority.findUnique({where:{id:"operations"}}),
  db.cutoverGate.findMany({orderBy:{id:"asc"}}),
  db.appSheetCaptureManifest.findMany({orderBy:{cutoffAt:"desc"},take:20,select:{
   captureId:true,sourceSystem:true,manifestHash:true,dataHash:true,definitionHash:true,stability:true,cutoffAt:true,
   dataSheetCount:true,dataPageCount:true,dataRecordCount:true,dataFormulaCount:true,dataUnresolvedFormulaCount:true,
   definitionTableCount:true,definitionColumnCount:true,definitionSliceCount:true,definitionViewCount:true,
   definitionActionCount:true,definitionBotCount:true,definitionWorkflowRuleCount:true,definitionFormatRuleCount:true,
  }}),
 ]);
 const gateVersions=await versions([...gates.map(gate=>gate.id),"operations"]);
 for(const gate of gates)gateVersions[gate.id]??=0;
 gateVersions.operations??=0;
 res.json(wire({authority,gates,captures,versions:gateVersions}));
});
operationsRoutes.get("/audit",async(req,res)=>{await requireCapability(db,req.user,"access.manage");res.json({items:await db.operationAudit.findMany({orderBy:{createdAt:"desc"},take:200})});});
