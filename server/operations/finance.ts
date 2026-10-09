import { z } from "zod";
import { randomUUID } from "node:crypto";
import { registerCommand, OperationError, json, objectId, currency, minor, positiveMinor, decimal, civilDate, evidence, requireDelivery, capabilities, requireAccountScope, requireMemberScope, touchAggregate, type CommandContext, type Tx } from "./core.js";
import { parseDecimal, roundHalfUp } from "../../shared/operations/exact.js";
import { isAppSheetInvoiceTotalPending } from "../../shared/operations/appsheet.js";
import { requireAppSheetOpeningSourceRecord } from "./access.js";
import "./period-coverage.js";
const signedMinor=z.string().regex(/^(0|-?[1-9]\d{0,18})$/).refine(v=>BigInt(v)>=-9223372036854775808n&&BigInt(v)<=9223372036854775807n);
function equivalentMinor(amount:bigint,fromCurrency:string,toCurrency:string,rate?:string){
 if(fromCurrency===toCurrency)return amount;
 if(!rate||parseDecimal(rate,12)<=0n)throw new OperationError(422,"CROSS_CURRENCY_RATE","Se requiere tasa y equivalencia aprobadas");
 const scaledRate=parseDecimal(rate,12);
 const equivalent=fromCurrency==="USD"?roundHalfUp(amount*scaledRate,10n**12n):roundHalfUp(amount*10n**12n,scaledRate);
 if(equivalent===0n)throw new OperationError(422,"CROSS_CURRENCY_EQUIVALENT_ZERO","La equivalencia no alcanza una unidad mínima de la moneda de la deuda; revisá el importe o la tasa");
 if(!minor.safeParse(equivalent.toString()).success)throw new OperationError(422,"CROSS_CURRENCY_EQUIVALENT_RANGE","La equivalencia supera la precisión monetaria admitida; revisá el importe o la tasa");
 return equivalent;
}
function orderFinancialState(total:bigint,verified:bigint,refunded:bigint){
 if(refunded>0n)return refunded===verified?"refunded":"partially_refunded";
 return verified>=total?"paid":verified>0n?"partially_paid":"unpaid";
}
const businessDateFormatter=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Argentina/Buenos_Aires"});
const businessDate=(instant:Date)=>businessDateFormatter.format(instant);
async function paymentDate(ctx:CommandContext,accountId:string,date:string,amount:bigint){
 await requireAccountScope(ctx.tx,ctx.actor,[accountId]);
 if(date>businessDate(ctx.now))throw new OperationError(422,"PAYMENT_FUTURE_DATE","Un pago efectuado no puede tener fecha futura; registrá el compromiso como obligación pendiente");
 const [opening,closed]=await Promise.all([
  ctx.tx.ledgerEvent.findFirst({where:{kind:"opening",legs:{some:{accountId}}},select:{occurredAt:true}}),
  ctx.tx.accountReconciliation.findFirst({where:{accountId,date:{gte:date}},select:{date:true}}),
 ]);
 if(opening&&date<businessDate(opening.occurredAt))throw new OperationError(422,"PAYMENT_BEFORE_OPENING","El pago es anterior a la apertura; conservá su historia sin debitar nuevamente el saldo inicial");
 if(closed)throw new OperationError(409,"PAYMENT_RECONCILED_DATE","El día ya tiene una conciliación; el pago necesita una resolución supervisada antes de modificar ese cierre");
 if(date<businessDate(ctx.now)){
  // Compute daily minima in PostgreSQL; never load the account's ledger into
  // the application or use only today's funds to approve a backdated debit.
  const [minimum]=await ctx.tx.$queryRaw<Array<{minimum:string|null}>>`
   WITH daily AS (
    SELECT (e."occurredAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS day, SUM(l."amountMinor") AS change
    FROM "LedgerLeg" l JOIN "LedgerEvent" e ON e.id=l."eventId"
    WHERE l."accountId"=${accountId} GROUP BY day
   ), balances AS (
    SELECT day, SUM(change) OVER (ORDER BY day ROWS UNBOUNDED PRECEDING) AS balance FROM daily
   ) SELECT MIN(balance)::text AS minimum FROM balances WHERE day>=${date}::date`;
  if(await accountBalance(ctx.tx,accountId,date)<amount||minimum?.minimum!==null&&minimum?.minimum!==undefined&&BigInt(minimum.minimum)<amount)
   throw new OperationError(422,"PAYMENT_HISTORICAL_FUNDS","El pago produciría un saldo diario negativo en su fecha o en un día posterior; conciliá los hechos y sus fechas");
 }
 // The source supplies a civil date, not a measured payment time. Noon is an
 // internal date anchor; metadata and the UI explicitly preserve that precision.
 return new Date(`${date}T12:00:00-03:00`);
}
export async function accountBalance(tx:Tx,accountId:string,asOf?:string){const sum=await tx.ledgerLeg.aggregate({where:{accountId,...(asOf?{event:{occurredAt:{lte:new Date(`${asOf}T23:59:59.999-03:00`)}}}:{})},_sum:{amountMinor:true}});return sum._sum.amountMinor??0n;}
export async function postLedger(ctx:CommandContext,kind:string,sourceObjectId:string,legs:{accountId:string;currency:string;amountMinor:bigint}[],metadata:Record<string,unknown>={},description=kind,occurredAt=new Date(ctx.envelope.occurredAt),sourceRecordId?:string){
 await requireAccountScope(ctx.tx,ctx.actor,legs.map(l=>l.accountId));
 if(!legs.length)throw new OperationError(422,"LEDGER_LEGS_REQUIRED","El movimiento requiere cuentas");
 for(const leg of legs){const a=await ctx.tx.operationAccount.findUnique({where:{id:leg.accountId}});if(!a?.active||!a.verified||a.currency!==leg.currency)throw new OperationError(422,"ACCOUNT_NOT_VERIFIED","Cuenta, moneda o correspondencia sin verificar");if(kind!=="opening"&&!a.openingApprovedBy)throw new OperationError(423,"ACCOUNT_OPENING_PENDING","La cuenta requiere apertura aprobada, incluso para un saldo inicial cero");}
 if(["transfer","rendition","fx"].includes(kind)&&legs.length<2)throw new OperationError(422,"PAIRED_LEGS_REQUIRED","Se requieren ambas piernas");
 if(["transfer","rendition"].includes(kind)&&legs.reduce((s,l)=>s+l.amountMinor,0n)!==0n)throw new OperationError(422,"UNBALANCED_TRANSFER","La transferencia debe conservar su importe");
 const id=randomUUID();
 return ctx.tx.ledgerEvent.create({data:{id,requestId:ctx.envelope.requestId,kind,occurredAt,actorId:ctx.actor.id,sourceObjectId,description,metadata:json(metadata),...(sourceRecordId?{sourceRecordId}:{}),legs:{create:legs.map(l=>({id:randomUUID(),...l}))}},include:{legs:true}});
}
const accountInput=z.strictObject({name:z.string().min(1).max(150),currency,kind:z.enum(["cash","bank","reserve","custody"]),holder:z.string().min(1).max(150),purpose:z.string().min(1).max(500),custodianId:objectId.optional(),sourceSystem:z.string().max(120).optional(),sourceId:z.string().max(150).optional()});
registerCommand("AccountCreated",{kind:"account",capability:"accounts.write",create:true,administrative:true,schema:accountInput,execute:async ctx=>({account:await ctx.tx.operationAccount.create({data:{id:ctx.envelope.targetId,...ctx.envelope.data as z.infer<typeof accountInput>}})})});
registerCommand("AccountsInitialized",{kind:"accountBootstrap",capability:"accounts.write",create:true,administrative:true,
 schema:z.strictObject({accounts:z.array(accountInput.extend({id:objectId})).length(6)}),execute:async ctx=>{
 const items=ctx.envelope.data.accounts as (z.infer<typeof accountInput>&{id:string})[];
 if(items.filter(a=>a.currency==="ARS").length!==3||items.filter(a=>a.currency==="USD").length!==3||items.some(a=>a.kind==="custody")||new Set(items.map(a=>a.id)).size!==6)throw new OperationError(422,"SIX_ACCOUNTS_REQUIRED","Se requieren tres cuentas ARS y tres USD del club");
 if(await ctx.tx.operationAccount.count({where:{kind:{not:"custody"}}}))throw new OperationError(409,"ACCOUNTS_ALREADY_INITIALIZED","La inicialización ya tiene cuentas");
 for(const item of items){await ctx.tx.operationAccount.create({data:item});await ctx.tx.operationObject.create({data:{id:item.id,kind:"account",version:1,createdBy:ctx.actor.id}});}
 return {accounts:items.map(a=>({id:a.id,verified:false}))};
 }});
registerCommand("AccountVerified",{kind:"account",capability:"openings.approve",administrative:true,schema:z.strictObject({evidence,sourceSystem:z.string().max(120).optional(),sourceId:z.string().max(150).optional()}),execute:async ctx=>({account:await ctx.tx.operationAccount.update({where:{id:ctx.envelope.targetId},data:{verified:true,sourceSystem:ctx.envelope.data.sourceSystem as string|undefined,sourceId:ctx.envelope.data.sourceId as string|undefined,openingEvidence:json(ctx.envelope.data.evidence)}})})});
const accountOpeningSchema=z.strictObject({amountMinor:signedMinor,evidence,preparedBy:objectId,sourceRecordId:objectId.optional()});
registerCommand("AccountOpeningApproved",{kind:"account",capability:"openings.approve",administrative:true,schema:accountOpeningSchema,
 authorize:async ctx=>{
  const account=await ctx.tx.operationAccount.findUnique({where:{id:ctx.envelope.targetId},select:{currency:true}});
  if(!account)throw new OperationError(404,"ACCOUNT_NOT_FOUND","Cuenta no encontrada");
  await requireAppSheetOpeningSourceRecord(ctx,ctx.envelope.data.sourceRecordId as string|undefined,{kind:"cash",amountMinor:BigInt(ctx.envelope.data.amountMinor as string),currency:account.currency});
 },execute:async ctx=>{
 const a=await ctx.tx.operationAccount.findUniqueOrThrow({where:{id:ctx.envelope.targetId}});
 const sourceRecordId=ctx.envelope.data.sourceRecordId as string|undefined;
 await requireAppSheetOpeningSourceRecord(ctx,sourceRecordId,{kind:"cash",amountMinor:BigInt(ctx.envelope.data.amountMinor as string),currency:a.currency});
 if(a.openingApprovedBy||await ctx.tx.ledgerLeg.count({where:{accountId:a.id}}))throw new OperationError(409,"OPENING_ALREADY_POSTED","La apertura debe preceder a los movimientos; corregí hacia adelante");
 if(ctx.envelope.data.preparedBy===ctx.actor.id)throw new OperationError(409,"INDEPENDENT_REVIEW_REQUIRED","La apertura requiere otro revisor");
 if(!await ctx.tx.user.findFirst({where:{id:ctx.envelope.data.preparedBy as string,active:true}}))throw new OperationError(422,"OPENING_AUTHOR_REQUIRED","La apertura requiere un autor activo identificado");
 const amount=BigInt(ctx.envelope.data.amountMinor as string);
 await ctx.tx.operationAccount.update({where:{id:a.id},data:{openingMinor:amount,openingApprovedBy:ctx.actor.id,openingEvidence:json(ctx.envelope.data.evidence)}});
 const event=await postLedger(ctx,"opening",a.id,[{accountId:a.id,currency:a.currency,amountMinor:amount}],{evidence:ctx.envelope.data.evidence,preparedBy:ctx.envelope.data.preparedBy},"Apertura conciliada",new Date(ctx.envelope.occurredAt),sourceRecordId);
 return {event,balanceMinor:amount};
}});
registerCommand("AccountTransferred",{kind:"account",capability:"accounts.write",schema:z.strictObject({toAccountId:objectId,amountMinor:positiveMinor,reason:z.string().min(1).max(1000)}),execute:async ctx=>{
 const from=await ctx.tx.operationAccount.findUniqueOrThrow({where:{id:ctx.envelope.targetId}}),to=await ctx.tx.operationAccount.findUniqueOrThrow({where:{id:ctx.envelope.data.toAccountId as string}});
 if(from.id===to.id||from.currency!==to.currency)throw new OperationError(422,"TRANSFER_ACCOUNTS","Usá cuentas distintas de la misma moneda");
 const amount=BigInt(ctx.envelope.data.amountMinor as string);
 if(await accountBalance(ctx.tx,from.id)<amount)throw new OperationError(422,"ACCOUNT_FUNDS","Saldo insuficiente");
 return {event:await postLedger(ctx,"transfer",from.id,[{accountId:from.id,currency:from.currency,amountMinor:-amount},{accountId:to.id,currency:to.currency,amountMinor:amount}],{},ctx.envelope.data.reason as string)};
}});
registerCommand("OwnerContributionRecorded",{kind:"ownerContribution",capability:"accounts.write",create:true,
 schema:z.strictObject({accountId:objectId,amountMinor:positiveMinor,contributor:z.string().trim().min(1).max(150),evidence}),
 authorize:async ctx=>requireAccountScope(ctx.tx,ctx.actor,[ctx.envelope.data.accountId as string]),execute:async ctx=>{
 const account=await ctx.tx.operationAccount.findUniqueOrThrow({where:{id:ctx.envelope.data.accountId as string}});
 if(account.kind==="custody")throw new OperationError(422,"CONTRIBUTION_CLUB_ACCOUNT","El aporte debe recibirse en una cuenta del club");
 const amount=BigInt(ctx.envelope.data.amountMinor as string);
 const event=await postLedger(ctx,"owner_contribution",ctx.envelope.targetId,[{accountId:account.id,currency:account.currency,amountMinor:amount}],{contributor:ctx.envelope.data.contributor,evidence:ctx.envelope.data.evidence},"Aporte del propietario");
 return {event,effect:"owner_funding_only",currency:account.currency,amountMinor:amount};
}});
registerCommand("ForeignExchangeRecorded",{kind:"fx",capability:"accounts.write",create:true,
 schema:z.strictObject({fromAccountId:objectId,toAccountId:objectId,fromMinor:positiveMinor,toMinor:positiveMinor,rate:decimal,commissionMinor:minor.default("0"),commissionAccountId:objectId.optional(),evidence}),execute:async ctx=>{
 const v=ctx.envelope.data as {fromAccountId:string;toAccountId:string;fromMinor:string;toMinor:string;rate:string;commissionMinor:string;commissionAccountId?:string;evidence:Record<string,unknown>};
 const from=await ctx.tx.operationAccount.findUniqueOrThrow({where:{id:v.fromAccountId}}),to=await ctx.tx.operationAccount.findUniqueOrThrow({where:{id:v.toAccountId}});
 if(from.currency===to.currency||parseDecimal(v.rate,12)<=0n)throw new OperationError(422,"FX_CURRENCIES","El cambio requiere monedas distintas y tasa positiva");
 const expected=from.currency==="USD"?roundHalfUp(BigInt(v.fromMinor)*parseDecimal(v.rate,12),10n**12n):roundHalfUp(BigInt(v.toMinor)*parseDecimal(v.rate,12),10n**12n);
 const actual=from.currency==="USD"?BigInt(v.toMinor):BigInt(v.fromMinor);
 // Both actual amounts are preserved. Any difference needs explicit evidence, never silent adjustment.
 const difference=actual-expected;
 if(difference!==0n&&!v.evidence.differenceReason)throw new OperationError(422,"FX_DIFFERENCE_UNRESOLVED","Documentá la diferencia entre tasa y montos reales");
 const legs=[{accountId:from.id,currency:from.currency,amountMinor:-BigInt(v.fromMinor)},{accountId:to.id,currency:to.currency,amountMinor:BigInt(v.toMinor)}];
 const fee=BigInt(v.commissionMinor);
 if(fee>0n){if(!v.commissionAccountId)throw new OperationError(422,"FX_COMMISSION_ACCOUNT","Indicá la cuenta de comisión");const fa=await ctx.tx.operationAccount.findUniqueOrThrow({where:{id:v.commissionAccountId}});legs.push({accountId:fa.id,currency:fa.currency,amountMinor:-fee});}
 // All legs belong to this atomic exchange. The destination can pay its fee
 // from these proceeds; a separate fee account still needs its own funds.
 const accountChanges=new Map<string,bigint>();
 for(const leg of legs)accountChanges.set(leg.accountId,(accountChanges.get(leg.accountId)??0n)+leg.amountMinor);
 for(const [accountId,change] of accountChanges)if(change<0n&&await accountBalance(ctx.tx,accountId)<-change)throw new OperationError(422,"ACCOUNT_FUNDS","Saldo insuficiente para cambio y comisión");
 return {event:await postLedger(ctx,"fx",ctx.envelope.targetId,legs,{rate:v.rate,differenceMinor:difference.toString(),evidence:v.evidence,commissionMinor:v.commissionMinor})};
}});
const reportSchema=z.strictObject({orderId:objectId,deliveryId:objectId.optional(),method:z.enum(["cash","transfer","mercado_pago","card"]),currency,amountMinor:positiveMinor,accountId:objectId.optional(),custodianId:objectId.optional(),evidence});
async function authorizeCollection(ctx:CommandContext){const caps=await capabilities(ctx.tx,ctx.actor);const deliveryId=ctx.envelope.data.deliveryId as string|undefined;if(deliveryId){const d=await ctx.tx.deliveryAssignment.findUnique({where:{id:deliveryId}});if(!d||d.orderId!==ctx.envelope.data.orderId)throw new OperationError(403,"COLLECTION_SCOPE","La entrega pertenece a otro pedido");if(!caps.includes("finance.read")&&!caps.includes("orders.write"))await requireDelivery(ctx,deliveryId);}else if(!caps.includes("finance.read")&&!caps.includes("orders.write"))throw new OperationError(403,"COLLECTION_SCOPE","El repartidor debe indicar su entrega asignada");}
registerCommand("CollectionReported",{kind:"collection",capability:"collections.report",create:true,schema:reportSchema,authorize:authorizeCollection,execute:async ctx=>{
  const v=ctx.envelope.data as z.infer<typeof reportSchema>;
  const order=await ctx.tx.operationOrder.findUnique({where:{id:v.orderId}});
  if(!order||order.commercialState!=="confirmed")throw new OperationError(422,"COLLECTION_ORDER","El pedido no está confirmado");
  if(v.method==="cash"&&v.deliveryId&&v.custodianId!==ctx.actor.id)throw new OperationError(422,"CASH_CUSTODY","El efectivo debe indicar la custodia real del repartidor");
 if(v.method!=="cash"&&v.custodianId)throw new OperationError(422,"CASH_CUSTODY","Una transferencia declarada no se encuentra bajo custodia física del repartidor");
 const report=await ctx.tx.collectionReport.create({data:{id:ctx.envelope.targetId,...v,amountMinor:BigInt(v.amountMinor),evidence:json(v.evidence),reporterId:ctx.actor.id}});
 return {report,effect:"reported_only"};
}});
registerCommand("CollectionVerified",{kind:"collection",capability:"collections.verify",schema:z.strictObject({accountId:objectId,evidence,exchangeRate:decimal.optional(),appliedMinor:minor.optional(),excessTreatment:z.enum(["member_credit","refund_due"]).default("member_credit")}),execute:async ctx=>{
 const c=await ctx.tx.collectionReport.findUniqueOrThrow({where:{id:ctx.envelope.targetId}});
 if(c.status!=="reported")throw new OperationError(409,"COLLECTION_ALREADY_RESOLVED","El cobro ya fue resuelto");
 const order=await ctx.tx.operationOrder.findUniqueOrThrow({where:{id:c.orderId}});
 if(isAppSheetInvoiceTotalPending(order.quote))throw new OperationError(423,"INVOICE_TOTAL_DEFINITION_PENDING","Falta cotejar el total facturado antes de informar un cobro");
 const a=await ctx.tx.operationAccount.findUniqueOrThrow({where:{id:ctx.envelope.data.accountId as string}});
 if(a.currency!==c.currency)throw new OperationError(422,"COLLECTION_CURRENCY","La cuenta debe tener la moneda realmente recibida");
 if(c.custodianId&&(a.kind!=="custody"||a.custodianId!==c.custodianId))throw new OperationError(422,"CUSTODY_ACCOUNT_REQUIRED","El efectivo en custodia no es caja disponible del club");
 if(c.method==="cash"&&!c.custodianId&&a.kind!=="cash")throw new OperationError(422,"CASH_ACCOUNT_REQUIRED","El efectivo recibido por el club se verifica en caja; su depósito bancario es una transferencia separada");
 if(c.method!=="cash"&&a.kind!=="bank")throw new OperationError(422,"BANK_RECEIPT_REQUIRED","Verificá recepción en una cuenta bancaria");
 const equivalent=equivalentMinor(c.amountMinor,c.currency,order.currency,ctx.envelope.data.exchangeRate as string|undefined);
 // The frozen quote remains historical evidence after cancellation. A late
 // receipt still records real cash, but cannot pay cancelled demand.
 const outstanding=order.commercialState==="cancelled"||order.verifiedMinor>=order.totalMinor?0n:order.totalMinor-order.verifiedMinor;
 const requested=ctx.envelope.data.appliedMinor===undefined?equivalent:BigInt(ctx.envelope.data.appliedMinor as string);
 if(requested>equivalent)throw new OperationError(422,"APPLICATION_EXCEEDS_RECEIPT","La aplicación supera el dinero verificado");
 const applied=requested<outstanding?requested:outstanding;const excess=equivalent-applied;
 await postLedger(ctx,"collection",c.id,[{accountId:a.id,currency:c.currency,amountMinor:c.amountMinor}],{orderId:order.id,appliedMinor:applied.toString(),appliedCurrency:order.currency,exchangeRate:ctx.envelope.data.exchangeRate??null,evidence:ctx.envelope.data.evidence});
 await ctx.tx.collectionReport.update({where:{id:c.id},data:{status:"verified",verifiedBy:ctx.actor.id,verifiedAt:ctx.now,accountId:a.id,appliedMinor:applied,excessMinor:excess,exchangeRate:ctx.envelope.data.exchangeRate as string|undefined}});
 const paid=order.verifiedMinor+applied;
 await ctx.tx.operationOrder.update({where:{id:order.id},data:{verifiedMinor:paid,financialState:orderFinancialState(order.totalMinor,paid,order.refundedMinor)}});
 await touchAggregate(ctx,order.id);
 let creditId:string|null=null;
 if(excess>0n){creditId=randomUUID();await ctx.tx.memberCredit.create({data:{id:creditId,memberId:order.memberId,collectionId:c.id,currency:order.currency,amountMinor:excess,treatment:ctx.envelope.data.excessTreatment as string}});await ctx.tx.operationObject.create({data:{id:creditId,kind:"credit",version:1,createdBy:ctx.actor.id}});}
 return {collectionId:c.id,appliedMinor:applied,excessMinor:excess,creditId,currency:order.currency,location:a.kind==="custody"?"courier_custody":"club_account"};
}});
registerCommand("CollectionReportRejected",{kind:"collection",capability:"collections.verify",schema:z.strictObject({reason:z.string().trim().min(1).max(1000),evidence}),execute:async ctx=>{
 const report=await ctx.tx.collectionReport.findUniqueOrThrow({where:{id:ctx.envelope.targetId}});
 if(report.status!=="reported")throw new OperationError(409,"COLLECTION_ALREADY_RESOLVED","El aviso ya fue resuelto; un cobro verificado necesita una corrección financiera");
 return {report:await ctx.tx.collectionReport.update({where:{id:report.id},data:{status:"rejected"}}),effect:"reported_only",resolution:ctx.envelope.data};
}});
registerCommand("CollectionVerificationReversed",{kind:"collection",capability:"collections.verify",schema:z.strictObject({reason:z.string().trim().min(1).max(1000),evidence}),execute:async ctx=>{
 const report=await ctx.tx.collectionReport.findUniqueOrThrow({where:{id:ctx.envelope.targetId}});
 if(report.status!=="verified")throw new OperationError(409,"COLLECTION_REVERSAL_STATE","Sólo puede corregirse un cobro verificado todavía vigente");
 const [order,events,credits]=await Promise.all([ctx.tx.operationOrder.findUniqueOrThrow({where:{id:report.orderId}}),ctx.tx.ledgerEvent.findMany({where:{sourceObjectId:report.id,kind:"collection"},include:{legs:true}}),ctx.tx.memberCredit.findMany({where:{collectionId:report.id}})]);
 if(events.length!==1||events[0]!.legs.length!==1||events[0]!.legs[0]!.amountMinor!==report.amountMinor)throw new OperationError(409,"COLLECTION_REVERSAL_EVIDENCE","No pudo verificarse el asiento original completo");
 if(credits.some(c=>c.resolvedMinor!==0n)||order.verifiedMinor-report.appliedMinor<order.refundedMinor)throw new OperationError(409,"COLLECTION_REVERSAL_DEPENDENCIES","Hay crédito utilizado o reintegros posteriores; resolvé sus efectos antes de corregir el cobro");
 const original=events[0]!,leg=original.legs[0]!;
 if(await accountBalance(ctx.tx,leg.accountId)<leg.amountMinor)throw new OperationError(409,"COLLECTION_REVERSAL_LOCATION","El dinero ya salió de la cuenta original; conciliá su ubicación antes de corregir");
 const event=await postLedger(ctx,"collection_reversal",report.id,[{accountId:leg.accountId,currency:leg.currency,amountMinor:-leg.amountMinor}],{originalEventId:original.id,appliedMinor:report.appliedMinor.toString(),excessMinor:report.excessMinor.toString(),...ctx.envelope.data});
 const verified=order.verifiedMinor-report.appliedMinor;
 await ctx.tx.operationOrder.update({where:{id:order.id},data:{verifiedMinor:verified,financialState:orderFinancialState(order.totalMinor,verified,order.refundedMinor)}});
 for(const c of credits){await ctx.tx.memberCredit.update({where:{id:c.id},data:{treatment:"reversed"}});await touchAggregate(ctx,c.id);}
 await ctx.tx.collectionReport.update({where:{id:report.id},data:{status:"reversed"}});await touchAggregate(ctx,order.id);
 return {collectionId:report.id,event,appliedMinorReversed:report.appliedMinor,excessMinorReversed:report.excessMinor,effect:"exact_forward_correction"};
}});
registerCommand("RenditionAccepted",{kind:"rendition",capability:"renditions.accept",create:true,
 schema:z.strictObject({routeId:objectId.optional(),driverId:objectId,fromAccountId:objectId,toAccountId:objectId,grossMinor:positiveMinor,deliveredMinor:minor,feeMinor:minor.default("0"),mode:z.enum(["gross","net"]).default("gross"),feePayableId:objectId.optional(),evidence}),execute:async ctx=>{
 const v=ctx.envelope.data as {routeId?:string;driverId:string;fromAccountId:string;toAccountId:string;grossMinor:string;deliveredMinor:string;feeMinor:string;mode:string;feePayableId?:string;evidence:Record<string,unknown>};
 const from=await ctx.tx.operationAccount.findUniqueOrThrow({where:{id:v.fromAccountId}}),to=await ctx.tx.operationAccount.findUniqueOrThrow({where:{id:v.toAccountId}});
 if(from.kind!=="custody"||from.custodianId!==v.driverId||to.kind==="custody"||from.currency!==to.currency)throw new OperationError(422,"RENDITION_ACCOUNTS","La rendición transfiere custodia a una cuenta del club");
 if(v.routeId){
  const route=await ctx.tx.deliveryRoute.findUnique({where:{id:v.routeId}});
  if(!route||route.driverId!==v.driverId||(route.custodianAccountId&&route.custodianAccountId!==from.id))throw new OperationError(422,"RENDITION_ROUTE_SCOPE","El turno debe corresponder al repartidor y a su cuenta de custodia");
 }
 const gross=BigInt(v.grossMinor),delivered=BigInt(v.deliveredMinor),fee=BigInt(v.feeMinor);
 if(gross!==delivered+fee||(v.mode==="gross"&&fee!==0n))throw new OperationError(422,"RENDITION_AMOUNTS","El dinero entregado y la remuneración deben explicar el bruto");
 if(await accountBalance(ctx.tx,from.id)<gross)throw new OperationError(422,"CUSTODY_FUNDS","La rendición supera el dinero verificado en custodia");
 if(fee>0n){
  if(!v.feePayableId)throw new OperationError(422,"COURIER_PAYABLE_REQUIRED","La compensación requiere obligación aprobada");
  const p=await ctx.tx.operationPayable.findUniqueOrThrow({where:{id:v.feePayableId}});
  if(!p.verified||p.kind!=="courier_fee"||p.beneficiaryId!==v.driverId||p.currency!==from.currency||p.amountMinor-p.paidMinor<fee)throw new OperationError(422,"COURIER_FEE_UNAPPROVED","La remuneración no está aprobada o supera su pendiente");
  await ctx.tx.operationPayable.update({where:{id:p.id},data:{paidMinor:{increment:fee}}});
  const feeEvent=await postLedger(ctx,"courier_fee",p.id,[{accountId:from.id,currency:from.currency,amountMinor:-fee}],{renditionId:ctx.envelope.targetId});
  await ctx.tx.payablePayment.create({data:{id:randomUUID(),payableId:p.id,accountId:from.id,currency:from.currency,amountMinor:fee,appliedMinor:fee,date:new Intl.DateTimeFormat("en-CA",{timeZone:"America/Argentina/Buenos_Aires"}).format(ctx.now),eventId:feeEvent.id}});
 }
 const event=await postLedger(ctx,"rendition",ctx.envelope.targetId,[{accountId:from.id,currency:from.currency,amountMinor:-delivered},{accountId:to.id,currency:to.currency,amountMinor:delivered}],{evidence:v.evidence,grossMinor:v.grossMinor,feeMinor:v.feeMinor});
 const rendition=await ctx.tx.rendition.create({data:{id:ctx.envelope.targetId,routeId:v.routeId,driverId:v.driverId,fromAccountId:from.id,toAccountId:to.id,currency:from.currency,grossMinor:gross,deliveredMinor:delivered,feeMinor:fee,mode:v.mode,acceptedBy:ctx.actor.id}});
 return {rendition,event,effect:"custody_transfer_only"};
}});
registerCommand("PayableCreated",{kind:"payable",capability:"payables.write",create:true,
 schema:z.strictObject({purchaseId:objectId.optional(),beneficiaryId:objectId,kind:z.enum(["purchase","courier_fee","operating_expense","asset_purchase","owner_withdrawal","other"]),currency,amountMinor:positiveMinor,dueDate:civilDate,accrualPeriod:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),costTreatment:z.enum(["variable","fixed"]).optional(),evidence,sourceSystem:z.string().max(120).optional(),sourceId:z.string().max(150).optional()}),execute:async ctx=>{
 const v=ctx.envelope.data as {purchaseId?:string;beneficiaryId:string;kind:string;currency:string;amountMinor:string;dueDate:string;accrualPeriod?:string;evidence:Record<string,unknown>;sourceSystem?:string;sourceId?:string};
 if(Boolean(v.sourceSystem)!==Boolean(v.sourceId))throw new OperationError(400,"SOURCE_ID_PAIR","Sistema y compromiso de origen deben estar completos");
 if(v.purchaseId){
  if(v.kind!=="purchase")throw new OperationError(422,"PURCHASE_PAYABLE_KIND","Una compra vinculada requiere una obligación de tipo compra");
  const purchase=await ctx.tx.purchaseOrder.findUnique({where:{id:v.purchaseId},select:{id:true,supplierId:true,currency:true}});
  if(!purchase)throw new OperationError(422,"PURCHASE_PAYABLE_NOT_FOUND","La compra vinculada no existe");
  if(purchase.supplierId!==v.beneficiaryId)throw new OperationError(422,"PURCHASE_PAYABLE_BENEFICIARY","La obligación debe corresponder al proveedor de la compra");
  if(purchase.currency!==v.currency)throw new OperationError(422,"PURCHASE_PAYABLE_CURRENCY","La obligación debe conservar la moneda de la compra");
 }
 const costTreatment=ctx.envelope.data.costTreatment as string|undefined;
 if(costTreatment&&v.kind!=="operating_expense")throw new OperationError(422,"COST_TREATMENT_KIND","La clasificación de gasto corresponde a un gasto operativo");
 const {costTreatment:_cost,...fields}=ctx.envelope.data;
 return {payable:await ctx.tx.operationPayable.create({data:{id:ctx.envelope.targetId,...fields as typeof v,amountMinor:BigInt(v.amountMinor),evidence:json({...v.evidence,...(costTreatment?{costTreatment}:{})})}})};
}});
registerCommand("PayableVerified",{kind:"payable",capability:"payables.write",schema:z.strictObject({evidence,costTreatment:z.enum(["variable","fixed"]).optional(),accrualPeriod:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional()}),execute:async ctx=>{
 const current=await ctx.tx.operationPayable.findUniqueOrThrow({where:{id:ctx.envelope.targetId}}),costTreatment=ctx.envelope.data.costTreatment as string|undefined;
 if(current.verified)throw new OperationError(409,"PAYABLE_ALREADY_VERIFIED","La obligación aprobada conserva su clasificación y evidencia");
 if(costTreatment&&current.kind!=="operating_expense")throw new OperationError(422,"COST_TREATMENT_KIND","La clasificación corresponde a un gasto operativo");
 return {payable:await ctx.tx.operationPayable.update({where:{id:current.id},data:{verified:true,...(ctx.envelope.data.accrualPeriod?{accrualPeriod:ctx.envelope.data.accrualPeriod as string}:{}),evidence:json({...current.evidence as Record<string,unknown>,reviewEvidence:ctx.envelope.data.evidence,...(costTreatment?{costTreatment}:{})})}})};
}});
registerCommand("PayablePaid",{kind:"payable",capability:"payables.write",schema:z.strictObject({accountId:objectId,amountMinor:positiveMinor,date:civilDate,exchangeRate:decimal.optional(),evidence}),execute:async ctx=>{
 const p=await ctx.tx.operationPayable.findUniqueOrThrow({where:{id:ctx.envelope.targetId}}),a=await ctx.tx.operationAccount.findUniqueOrThrow({where:{id:ctx.envelope.data.accountId as string}});
 if(!p.verified)throw new OperationError(422,"PAYABLE_NOT_VERIFIED","La obligación requiere verificación");
 const amount=BigInt(ctx.envelope.data.amountMinor as string),applied=equivalentMinor(amount,a.currency,p.currency,ctx.envelope.data.exchangeRate as string|undefined);
 if(applied>p.amountMinor-p.paidMinor)throw new OperationError(422,"PAYABLE_OVERPAYMENT","El pago supera la obligación pendiente");
 if(await accountBalance(ctx.tx,a.id)<amount)throw new OperationError(422,"ACCOUNT_FUNDS","Saldo insuficiente");
 const date=ctx.envelope.data.date as string,occurredAt=await paymentDate(ctx,a.id,date,amount);
 const event=await postLedger(ctx,p.kind,p.id,[{accountId:a.id,currency:a.currency,amountMinor:-amount}],{appliedMinor:applied.toString(),appliedCurrency:p.currency,exchangeRate:ctx.envelope.data.exchangeRate??null,evidence:ctx.envelope.data.evidence,declaredDate:date,timestampPrecision:"civil_date",reportedOccurredAt:ctx.envelope.occurredAt},p.kind,occurredAt);
 await ctx.tx.operationPayable.update({where:{id:p.id},data:{paidMinor:{increment:applied}}});
 const payment=await ctx.tx.payablePayment.create({data:{id:randomUUID(),payableId:p.id,accountId:a.id,currency:a.currency,amountMinor:amount,appliedMinor:applied,exchangeRate:ctx.envelope.data.exchangeRate as string|undefined,date:ctx.envelope.data.date as string,eventId:event.id}});
 return {payment};
}});
registerCommand("AccountReconciled",{kind:"account",capability:"accounts.write",schema:z.strictObject({date:civilDate,countedMinor:signedMinor,evidence}),execute:async ctx=>{
 const account=await ctx.tx.operationAccount.findUniqueOrThrow({where:{id:ctx.envelope.targetId}});
 if(!account.verified||!account.openingApprovedBy)throw new OperationError(423,"ACCOUNT_OPENING_PENDING","La conciliación requiere una apertura aprobada");
 const calculated=await accountBalance(ctx.tx,ctx.envelope.targetId,ctx.envelope.data.date as string),counted=BigInt(ctx.envelope.data.countedMinor as string);
 return {reconciliation:await ctx.tx.accountReconciliation.create({data:{id:randomUUID(),accountId:ctx.envelope.targetId,date:ctx.envelope.data.date as string,calculatedMinor:calculated,countedMinor:counted,differenceMinor:counted-calculated,evidence:json(ctx.envelope.data.evidence),reviewerId:ctx.actor.id}})};
}});
async function creditScope(ctx:CommandContext){const c=await ctx.tx.memberCredit.findUniqueOrThrow({where:{id:ctx.envelope.targetId}});await requireMemberScope(ctx.tx,ctx.actor,c.memberId);}
registerCommand("MemberCreditApplied",{kind:"credit",capability:"collections.verify",schema:z.strictObject({orderId:objectId,amountMinor:positiveMinor,evidence}),authorize:creditScope,execute:async ctx=>{
 const c=await ctx.tx.memberCredit.findUniqueOrThrow({where:{id:ctx.envelope.targetId}}),o=await ctx.tx.operationOrder.findUniqueOrThrow({where:{id:ctx.envelope.data.orderId as string}}),amount=BigInt(ctx.envelope.data.amountMinor as string);
 if(isAppSheetInvoiceTotalPending(o.quote))throw new OperationError(423,"INVOICE_TOTAL_DEFINITION_PENDING","No se puede aplicar un crédito hasta cotejar el total facturado de AppSheet");
 if(c.treatment!=="member_credit"||o.memberId!==c.memberId||o.currency!==c.currency||o.commercialState!=="confirmed")throw new OperationError(422,"CREDIT_APPLICATION_SCOPE","Aplicá el crédito al mismo socio, moneda y pedido confirmado");
 if(amount>c.amountMinor-c.resolvedMinor||amount>o.totalMinor-o.verifiedMinor)throw new OperationError(422,"CREDIT_APPLICATION_LIMIT","La aplicación supera el crédito o la deuda pendientes");
 await ctx.tx.memberCredit.update({where:{id:c.id},data:{resolvedMinor:{increment:amount}}});
 const paid=o.verifiedMinor+amount;await ctx.tx.operationOrder.update({where:{id:o.id},data:{verifiedMinor:paid,financialState:orderFinancialState(o.totalMinor,paid,o.refundedMinor)}});
 await ctx.tx.operationObject.update({where:{id:o.id},data:{version:{increment:1}}});
 return {creditId:c.id,orderId:o.id,appliedMinor:amount,effect:"existing_credit_applied_without_new_receipt",evidence:ctx.envelope.data.evidence};
}});
registerCommand("MemberCreditRefunded",{kind:"credit",capability:"collections.verify",schema:z.strictObject({accountId:objectId,amountMinor:positiveMinor,evidence}),authorize:creditScope,execute:async ctx=>{
 const c=await ctx.tx.memberCredit.findUniqueOrThrow({where:{id:ctx.envelope.targetId}}),a=await ctx.tx.operationAccount.findUniqueOrThrow({where:{id:ctx.envelope.data.accountId as string}}),amount=BigInt(ctx.envelope.data.amountMinor as string);
 if(c.treatment==="reversed")throw new OperationError(409,"CREDIT_REVERSED","El crédito pertenece a una verificación corregida");
 if(a.currency!==c.currency||amount>c.amountMinor-c.resolvedMinor)throw new OperationError(422,"CREDIT_REFUND_LIMIT","El vuelto o reintegro está limitado al crédito todavía pendiente en su moneda");
 if(await accountBalance(ctx.tx,a.id)<amount)throw new OperationError(422,"ACCOUNT_FUNDS","Saldo insuficiente");
 const event=await postLedger(ctx,"credit_refund",c.id,[{accountId:a.id,currency:a.currency,amountMinor:-amount}],{evidence:ctx.envelope.data.evidence});
 await ctx.tx.memberCredit.update({where:{id:c.id},data:{resolvedMinor:{increment:amount}}});
 return {creditId:c.id,event,amountMinor:amount};
}});
