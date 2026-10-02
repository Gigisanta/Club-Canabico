import { createHash } from "node:crypto";
import { z } from "zod";
import { objectScope, registerCommand, OperationError, json, evidence, type CommandContext, type Tx } from "./core.js";

const periodSchema=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const REPORT_DEFINITION="management-contribution-source-population-v2";
const QUERY_VERSION="management-contribution-sql-v2";
const CONFIGURATION_KIND="period_coverage";
const PAGE_SIZE=1_000;
const periodCoverageInput=z.strictObject({period:periodSchema,sourceReconciliationReference:z.string().trim().min(1).max(500),evidence});

export type PeriodCoverageScope={accountIds?:string[];memberIds?:string[];locationIds?:string[];custodianIds?:string[]};
export interface PeriodCoveragePopulation {name:string;recordCount:number;observedCount:number;complete:boolean;digest:string}
export interface PeriodCoverageSnapshot {period:string;reportDefinition:string;queryVersion:string;fingerprint:string;queryComplete:boolean;populations:PeriodCoveragePopulation[]}
export interface PeriodCoverageStatus {
 period:string;reportDefinition:string;sourcePeriodCompletenessAttested:boolean;
 state:"attested"|"missing"|"stale"|"incomplete"|"scope_excluded";
 fingerprint:string|null;attestationId:string|null;attestationVersion:number|null;reviewedAt:string|null;reason:string|null;
}

function hash(value:unknown){return createHash("sha256").update(JSON.stringify(value)).digest("hex");}
function canonical(value:unknown):unknown{
 if(typeof value==="bigint")return value.toString();
 if(value instanceof Date)return value.toISOString();
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==="object"){
  const row=value as Record<string,unknown>;
  if(value.constructor?.name==="Decimal"&&typeof value.toString==="function")return value.toString();
  return Object.fromEntries(Object.keys(row).sort().map(key=>[key,canonical(row[key])]));
 }
 return value;
}
function bounds(period:string){
 if(!periodSchema.safeParse(period).success)throw new OperationError(400,"PERIOD_COVERAGE_PERIOD","Indicá un período calendario YYYY-MM");
 const [year,month]=period.split("-").map(Number);
 const nextMonth=new Date(Date.UTC(year!,month!,1)).toISOString().slice(0,10);
 return {from:new Date(`${period}-01T03:00:00.000Z`),to:new Date(`${nextMonth}T03:00:00.000Z`),lastDay:new Date(Date.UTC(year!,month!,0)).toISOString().slice(0,10)};
}
function fullScope(scope?:PeriodCoverageScope){return !scope||Object.values(scope).every(value=>value===undefined);}

async function readAll<T extends {id:string}>(fetchPage:(afterId?:string)=>Promise<T[]>):Promise<T[]>{
 const rows:T[]=[];let afterId:string|undefined;
 for(;;){
  const batch=await fetchPage(afterId);
  if(!batch.length)break;
  rows.push(...batch);
  if(batch.length<PAGE_SIZE)break;
  afterId=batch[batch.length-1]!.id;
 }
 return rows;
}
async function capture<T extends {id:string}>(name:string,countRows:()=>Promise<number>,fetchPage:(afterId?:string)=>Promise<T[]>){
 const recordCount=await countRows();
 const rows=await readAll(fetchPage);
 const digest=hash(canonical(rows));
 return {rows,population:{name,recordCount,observedCount:rows.length,complete:recordCount===rows.length,digest} satisfies PeriodCoveragePopulation};
}
function pageWhere(where:Record<string,unknown>,afterId?:string){return afterId?{AND:[where,{id:{gt:afterId}}]}:where;}
function pageArgs(_afterId?:string){return {orderBy:{id:"asc" as const},take:PAGE_SIZE};}
function snapshotSchema(){
 return z.strictObject({period:periodSchema,reportDefinition:z.literal(REPORT_DEFINITION),queryVersion:z.literal(QUERY_VERSION),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),queryComplete:z.boolean(),populations:z.array(z.strictObject({name:z.string(),recordCount:z.number().int().nonnegative(),observedCount:z.number().int().nonnegative(),complete:z.boolean(),digest:z.string().regex(/^[a-f0-9]{64}$/)})),sourceReconciliationReference:z.string().trim().min(1).max(500),proposalEvidence:evidence,approvalEvidence:evidence.optional()});
}
function reportPopulations(period:string,sources:PeriodCoveragePopulation[]):PeriodCoverageSnapshot{
 const queryComplete=sources.every(source=>source.complete);
 const fingerprint=hash({period,reportDefinition:REPORT_DEFINITION,queryVersion:QUERY_VERSION,populations:sources.map(({name,recordCount,digest})=>({name,recordCount,digest}))});
 return {period,reportDefinition:REPORT_DEFINITION,queryVersion:QUERY_VERSION,fingerprint,queryComplete,populations:sources};
}

/** Captures every source that can affect, reconcile, or map management history in this period. */
export async function getManagementPeriodCoverageSnapshot(tx:Tx,period:string):Promise<PeriodCoverageSnapshot>{
 const {from,to}=bounds(period);
 const orderWhere={commercialState:"confirmed",confirmedAt:{gte:from,lt:to},lines:{some:{delivered:{gt:"0"}}}};
 const lineWhere={order:{commercialState:"confirmed",confirmedAt:{gte:from,lt:to}},delivered:{gt:"0"}};
 const payableWhere={kind:{in:["courier_fee","operating_expense"]}};
 const [orders,lineRows,payables,snapshots,sourceRecords,identities,exceptions,batches,provenance,reconciliations,
  historicSales,historicSaleLines,historicPurchases,historicPurchaseLines,historicExpenses,historicStock,historicStockouts,
  historicCash,historicCashReconciliations,historicPromotions]=await Promise.all([
  capture("confirmed-orders-with-delivered-lines",()=>tx.operationOrder.count({where:orderWhere}),after=>tx.operationOrder.findMany({where:pageWhere(orderWhere,after),select:{id:true,currency:true,fulfillmentState:true,deliveryMinor:true,deliveryDiscountMinor:true,surchargeMinor:true,refundedDeliveryMinor:true,refundedSurchargeMinor:true,confirmedAt:true},...pageArgs(after)})),
  capture("delivered-order-lines",()=>tx.operationOrderLine.count({where:lineWhere}),after=>tx.operationOrderLine.findMany({where:pageWhere(lineWhere,after),select:{id:true,orderId:true,skuId:true,unit:true,requested:true,delivered:true,revenueMinor:true},...pageArgs(after)})),
  capture("courier-and-operating-payables",()=>tx.operationPayable.count({where:payableWhere}),after=>tx.operationPayable.findMany({where:pageWhere(payableWhere,after),select:{id:true,kind:true,currency:true,amountMinor:true,verified:true,accrualPeriod:true,sourceSystem:true,sourceId:true,evidence:true},...pageArgs(after)})),
  capture("legacy-import-snapshots",()=>tx.legacyImportSnapshot.count(),after=>tx.legacyImportSnapshot.findMany({where:after?{id:{gt:after}}:{},select:{id:true,sourceSystem:true,fileHash:true,importerVersion:true,status:true,reviewedBy:true,reviewedAt:true,coverage:true,controls:true},...pageArgs(after)})),
  capture("legacy-source-records",()=>tx.legacySourceRecord.count(),after=>tx.legacySourceRecord.findMany({where:after?{id:{gt:after}}:{},select:{id:true,snapshotId:true,sourceTable:true,sourceKey:true,fileHash:true,contentHash:true,importerVersion:true,treatment:true,resolution:true},...pageArgs(after)})),
  capture("legacy-identity-mappings",()=>tx.legacyIdentity.count(),after=>tx.legacyIdentity.findMany({where:after?{id:{gt:after}}:{},select:{id:true,sourceSystem:true,sourceTable:true,sourceKey:true,destinationType:true,destinationId:true,approvedBy:true},...pageArgs(after)})),
  capture("legacy-exception-resolutions",()=>tx.legacyException.count(),after=>tx.legacyException.findMany({where:after?{id:{gt:after}}:{},select:{id:true,snapshotId:true,sourceRecordId:true,kind:true,severity:true,status:true,resolution:true,resolvedBy:true,resolvedAt:true},...pageArgs(after)})),
  capture("historical-import-batches",()=>tx.historicalImportBatch.count(),after=>tx.historicalImportBatch.findMany({where:after?{id:{gt:after}}:{},select:{id:true,kind:true,sourceSystem:true,fileHash:true,mappingVersion:true,cutoffDate:true,status:true,factsHash:true,rowCount:true,acceptedCount:true,rejectedCount:true,insertedCount:true,skippedCount:true,importedAt:true},...pageArgs(after)})),
  capture("historical-import-provenance",()=>tx.historicalImportProvenance.count(),after=>tx.historicalImportProvenance.findMany({where:after?{id:{gt:after}}:{},select:{id:true,batchId:true,factKind:true,sourceSystem:true,sourceId:true,factHash:true,disposition:true,recordedAt:true},...pageArgs(after)})),
  capture("historical-reconciliations",()=>tx.historicalReconciliation.count(),after=>tx.historicalReconciliation.findMany({where:after?{id:{gt:after}}:{},select:{id:true,batchId:true,asOf:true,coverageFrom:true,coverageThrough:true,coverageComplete:true,reference:true,confirmedByUserId:true,confirmedAt:true,varianceCents:true,sourceRecordCount:true,sourceTotalCents:true,calculatedTotalCents:true},...pageArgs(after)})),
  capture("historical-delivery-sales",()=>tx.historicalDeliverySale.count({where:{saleDate:{gte:new Date(`${period}-01T00:00:00.000Z`),lt:new Date(`${to.toISOString().slice(0,10)}T00:00:00.000Z`)}}}),after=>tx.historicalDeliverySale.findMany({where:pageWhere({saleDate:{gte:new Date(`${period}-01T00:00:00.000Z`),lt:new Date(`${to.toISOString().slice(0,10)}T00:00:00.000Z`)}},after),select:{id:true,sourceSystem:true,sourceId:true,factHash:true,saleDate:true,totalCents:true,discountCents:true},...pageArgs(after)})),
  capture("historical-delivery-sale-lines",()=>tx.historicalDeliverySaleLine.count({where:{sale:{saleDate:{gte:new Date(`${period}-01T00:00:00.000Z`),lt:new Date(`${to.toISOString().slice(0,10)}T00:00:00.000Z`)}}}}),after=>tx.historicalDeliverySaleLine.findMany({where:pageWhere({sale:{saleDate:{gte:new Date(`${period}-01T00:00:00.000Z`),lt:new Date(`${to.toISOString().slice(0,10)}T00:00:00.000Z`)}}},after),select:{id:true,sourceSystem:true,sourceId:true,factHash:true,saleId:true,productSourceId:true,quantityMilliunits:true,quantityUnit:true,unitPriceCents:true,lineTotalCents:true},...pageArgs(after)})),
  capture("historical-purchase-receipts",()=>tx.historicalPurchaseReceipt.count({where:{receivedDate:{gte:new Date(`${period}-01T00:00:00.000Z`),lt:new Date(`${to.toISOString().slice(0,10)}T00:00:00.000Z`)}}}),after=>tx.historicalPurchaseReceipt.findMany({where:pageWhere({receivedDate:{gte:new Date(`${period}-01T00:00:00.000Z`),lt:new Date(`${to.toISOString().slice(0,10)}T00:00:00.000Z`)}},after),select:{id:true,sourceSystem:true,sourceId:true,factHash:true,receivedDate:true,totalCents:true},...pageArgs(after)})),
  capture("historical-purchase-receipt-lines",()=>tx.historicalPurchaseReceiptLine.count({where:{receipt:{receivedDate:{gte:new Date(`${period}-01T00:00:00.000Z`),lt:new Date(`${to.toISOString().slice(0,10)}T00:00:00.000Z`)}}}}),after=>tx.historicalPurchaseReceiptLine.findMany({where:pageWhere({receipt:{receivedDate:{gte:new Date(`${period}-01T00:00:00.000Z`),lt:new Date(`${to.toISOString().slice(0,10)}T00:00:00.000Z`)}}},after),select:{id:true,sourceSystem:true,sourceId:true,factHash:true,receiptId:true,productSourceId:true,quantityMilliunits:true,quantityUnit:true,unitCostCents:true,lineTotalCents:true},...pageArgs(after)})),
  capture("historical-expenses",()=>tx.historicalExpense.count({where:{expenseDate:{gte:new Date(`${period}-01T00:00:00.000Z`),lt:new Date(`${to.toISOString().slice(0,10)}T00:00:00.000Z`)}}}),after=>tx.historicalExpense.findMany({where:pageWhere({expenseDate:{gte:new Date(`${period}-01T00:00:00.000Z`),lt:new Date(`${to.toISOString().slice(0,10)}T00:00:00.000Z`)}},after),select:{id:true,sourceSystem:true,sourceId:true,factHash:true,expenseDate:true,category:true,amountCents:true},...pageArgs(after)})),
  capture("historical-stock-observations",()=>tx.historicalStockObservation.count({where:{observedDate:{gte:new Date(`${period}-01T00:00:00.000Z`),lt:new Date(`${to.toISOString().slice(0,10)}T00:00:00.000Z`)}}}),after=>tx.historicalStockObservation.findMany({where:pageWhere({observedDate:{gte:new Date(`${period}-01T00:00:00.000Z`),lt:new Date(`${to.toISOString().slice(0,10)}T00:00:00.000Z`)}},after),select:{id:true,sourceSystem:true,sourceId:true,factHash:true,productSourceId:true,locationSourceId:true,quantityMilliunits:true,quantityUnit:true},...pageArgs(after)})),
  capture("historical-stockouts",()=>tx.historicalStockout.count({where:{stockoutDate:{gte:new Date(`${period}-01T00:00:00.000Z`),lt:new Date(`${to.toISOString().slice(0,10)}T00:00:00.000Z`)}}}),after=>tx.historicalStockout.findMany({where:pageWhere({stockoutDate:{gte:new Date(`${period}-01T00:00:00.000Z`),lt:new Date(`${to.toISOString().slice(0,10)}T00:00:00.000Z`)}},after),select:{id:true,sourceSystem:true,sourceId:true,factHash:true,productSourceId:true,locationSourceId:true,lostQuantityMilliunits:true,quantityUnit:true},...pageArgs(after)})),
  capture("historical-cash-movements",()=>tx.historicalCashMovement.count({where:{movementDate:{gte:new Date(`${period}-01T00:00:00.000Z`),lt:new Date(`${to.toISOString().slice(0,10)}T00:00:00.000Z`)}}}),after=>tx.historicalCashMovement.findMany({where:pageWhere({movementDate:{gte:new Date(`${period}-01T00:00:00.000Z`),lt:new Date(`${to.toISOString().slice(0,10)}T00:00:00.000Z`)}},after),select:{id:true,sourceSystem:true,sourceId:true,factHash:true,account:true,category:true,amountCents:true},...pageArgs(after)})),
  capture("historical-cash-reconciliations",()=>tx.historicalCashReconciliation.count({where:{reconciledDate:{gte:new Date(`${period}-01T00:00:00.000Z`),lt:new Date(`${to.toISOString().slice(0,10)}T00:00:00.000Z`)}}}),after=>tx.historicalCashReconciliation.findMany({where:pageWhere({reconciledDate:{gte:new Date(`${period}-01T00:00:00.000Z`),lt:new Date(`${to.toISOString().slice(0,10)}T00:00:00.000Z`)}},after),select:{id:true,sourceSystem:true,sourceId:true,factHash:true,account:true,expectedCents:true,countedCents:true,varianceCents:true},...pageArgs(after)})),
  capture("historical-promotions",()=>tx.historicalPromotion.count({where:{startsOn:{lt:new Date(`${to.toISOString().slice(0,10)}T00:00:00.000Z`)},OR:[{endsOn:null},{endsOn:{gte:new Date(`${period}-01T00:00:00.000Z`)}}]}}),after=>tx.historicalPromotion.findMany({where:pageWhere({startsOn:{lt:new Date(`${to.toISOString().slice(0,10)}T00:00:00.000Z`)},OR:[{endsOn:null},{endsOn:{gte:new Date(`${period}-01T00:00:00.000Z`)}}]},after),select:{id:true,sourceSystem:true,sourceId:true,factHash:true,label:true,startsOn:true,endsOn:true,discountCents:true},...pageArgs(after)})),
 ]);

 const orderIds=orders.rows.map(order=>order.id);
 const allocationWhere={orderId:{in:orderIds}};
 const allocation=await capture("preparation-allocations-for-period-orders",()=>orderIds.length?tx.preparationAllocation.count({where:allocationWhere}):Promise.resolve(0),after=>orderIds.length?tx.preparationAllocation.findMany({where:pageWhere(allocationWhere,after),select:{id:true,orderId:true,lineId:true,lotId:true,requestedQuantity:true,actualQuantity:true,deliveredQuantity:true,returnedDeliveredQuantity:true,costMinor:true},...pageArgs(after)}):Promise.resolve([]));
 const lotIds=[...new Set(allocation.rows.map(row=>row.lotId))];
 const lots=await capture("inventory-lot-currencies",()=>lotIds.length?tx.inventoryLot.count({where:{id:{in:lotIds}}}):Promise.resolve(0),after=>lotIds.length?tx.inventoryLot.findMany({where:pageWhere({id:{in:lotIds}},after),select:{id:true,costCurrency:true},...pageArgs(after)}):Promise.resolve([]));

 const populations=[orders.population,lineRows.population,allocation.population,lots.population,payables.population,
  snapshots.population,sourceRecords.population,identities.population,exceptions.population,batches.population,provenance.population,reconciliations.population,
  historicSales.population,historicSaleLines.population,historicPurchases.population,historicPurchaseLines.population,historicExpenses.population,
  historicStock.population,historicStockouts.population,historicCash.population,historicCashReconciliations.population,historicPromotions.population];
 return reportPopulations(period,populations);
}

async function requireUnscopedReview(ctx:CommandContext){
 const scope=await objectScope(ctx.tx,ctx.actor);
 if(!fullScope(scope))throw new OperationError(403,"PERIOD_COVERAGE_FULL_SCOPE_REQUIRED","La cobertura del período requiere acceso financiero y operativo sin filtros de alcance");
}
function configurationName(period:string){return `management-period-coverage-${period}`;}

registerCommand("PeriodCoverageProposed",{kind:"configuration",capability:"imports.review",administrative:true,create:true,schema:periodCoverageInput,authorize:requireUnscopedReview,execute:async ctx=>{
 const input=ctx.envelope.data as z.infer<typeof periodCoverageInput>,snapshot=await getManagementPeriodCoverageSnapshot(ctx.tx,input.period);
 if(!snapshot.queryComplete)throw new OperationError(422,"PERIOD_COVERAGE_QUERY_INCOMPLETE","No se pudo capturar completa una población fuente del período");
 const name=configurationName(input.period),latest=await ctx.tx.operationalConfiguration.findFirst({where:{name},orderBy:{version:"desc"},select:{version:true}});
 const {lastDay}=bounds(input.period);
 const definition={...snapshot,sourceReconciliationReference:input.sourceReconciliationReference,proposalEvidence:input.evidence};
 const configuration=await ctx.tx.operationalConfiguration.create({data:{id:ctx.envelope.targetId,name,kind:CONFIGURATION_KIND,version:(latest?.version??0)+1,state:"proposed",definition:json(definition),validFrom:`${input.period}-01`,validUntil:lastDay,proposedBy:ctx.actor.id}});
 return {configuration};
}});

registerCommand("PeriodCoverageApproved",{kind:"configuration",capability:"imports.review",administrative:true,schema:z.strictObject({evidence}),authorize:requireUnscopedReview,execute:async ctx=>{
 const configuration=await ctx.tx.operationalConfiguration.findUniqueOrThrow({where:{id:ctx.envelope.targetId}});
 if(configuration.kind!==CONFIGURATION_KIND||configuration.state!=="proposed")throw new OperationError(409,"PERIOD_COVERAGE_STATE","Sólo puede aprobarse una propuesta de cobertura pendiente");
 if(configuration.proposedBy===ctx.actor.id)throw new OperationError(409,"PERIOD_COVERAGE_INDEPENDENT_REVIEW_REQUIRED","La aprobación requiere un revisor distinto de quien propuso la conciliación");
 const parsed=snapshotSchema().safeParse(configuration.definition);
 if(!parsed.success)throw new OperationError(409,"PERIOD_COVERAGE_PROPOSAL_INVALID","La propuesta perdió una huella de fuentes válida");
 const current=await getManagementPeriodCoverageSnapshot(ctx.tx,parsed.data.period);
 if(!current.queryComplete||current.fingerprint!==parsed.data.fingerprint)throw new OperationError(409,"PERIOD_COVERAGE_STALE","Las fuentes cambiaron desde la propuesta; generá una nueva revisión del período");
 const definition=configuration.definition as Record<string,unknown>;
 const updated=await ctx.tx.operationalConfiguration.update({where:{id:configuration.id},data:{state:"approved",approvedBy:ctx.actor.id,approvedAt:ctx.now,definition:json({...definition,approvalEvidence:ctx.envelope.data.evidence})}});
 return {configuration:updated,sourcePeriodCompletenessAttested:true,fingerprint:current.fingerprint};
}});

/** Returns true only for a full-scope period whose source populations still match an independent approval. */
export async function getManagementPeriodCoverageStatus(tx:Tx,{period,scope}:{period:string;scope?:PeriodCoverageScope}):Promise<PeriodCoverageStatus>{
 bounds(period);
 if(!fullScope(scope))return {period,reportDefinition:REPORT_DEFINITION,sourcePeriodCompletenessAttested:false,state:"scope_excluded",fingerprint:null,attestationId:null,attestationVersion:null,reviewedAt:null,reason:"full-scope-required"};
 const approvals=await tx.operationalConfiguration.findMany({where:{name:configurationName(period),kind:CONFIGURATION_KIND,state:"approved"},orderBy:{version:"desc"},select:{id:true,version:true,definition:true,proposedBy:true,approvedBy:true,approvedAt:true}});
 if(!approvals.length)return {period,reportDefinition:REPORT_DEFINITION,sourcePeriodCompletenessAttested:false,state:"missing",fingerprint:null,attestationId:null,attestationVersion:null,reviewedAt:null,reason:"no-approved-attestation"};
 const current=await getManagementPeriodCoverageSnapshot(tx,period);
 if(!current.queryComplete)return {period,reportDefinition:REPORT_DEFINITION,sourcePeriodCompletenessAttested:false,state:"incomplete",fingerprint:current.fingerprint,attestationId:null,attestationVersion:null,reviewedAt:null,reason:"source-population-query-incomplete"};
 const independentlyApproved=approvals.filter(approval=>Boolean(approval.approvedBy&&approval.approvedAt&&approval.approvedBy!==approval.proposedBy));
 for(const approval of independentlyApproved){
  const stored=snapshotSchema().safeParse(approval.definition);
  if(stored.success&&stored.data.fingerprint===current.fingerprint)return {period,reportDefinition:REPORT_DEFINITION,sourcePeriodCompletenessAttested:true,state:"attested",fingerprint:current.fingerprint,attestationId:approval.id,attestationVersion:approval.version,reviewedAt:approval.approvedAt!.toISOString(),reason:null};
 }
 return {period,reportDefinition:REPORT_DEFINITION,sourcePeriodCompletenessAttested:false,state:"stale",fingerprint:current.fingerprint,attestationId:null,attestationVersion:null,reviewedAt:null,reason:independentlyApproved.length?"source-population-changed-since-approval":"approved-attestation-metadata-invalid"};
}
