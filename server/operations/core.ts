import { Prisma, type User } from "@prisma/client";
import { z } from "zod";
import { db } from "../db.js";
import { type Capability, type CommandEnvelope, type CommandResult } from "../../shared/operations/contracts.js";
import { APPSHEET_CANONICAL_IMPORTER_VERSION, APPSHEET_CANONICAL_SOURCE_SYSTEM } from "../../shared/operations/appsheet-canonical.js";
import {
  APPSHEET_HISTORY_IMPORTER_VERSION,
  APPSHEET_HISTORY_SOURCE_SYSTEM,
  APPSHEET_HISTORY_STAGE_SCHEMA_VERSION_V1,
  APPSHEET_HISTORY_STAGE_SCHEMA_VERSION_V2,
  appSheetHistoryStageHasBoundTechnicalReview,
} from "../../shared/operations/appsheet-history.js";
import { canonicalCommandBodyHash } from "./canonical.js";
import { capabilitiesFromGrant } from "./access-snapshot.js";
export class OperationError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
export type Tx = Prisma.TransactionClient;
export interface CommandContext { tx: Tx; actor: User; envelope: CommandEnvelope; now: Date; authorityEpoch: number; requestBytes?: number; prepared?: unknown }
export interface CommandSpec {
  kind: string;
  capability: Capability;
  schema: z.ZodType<Record<string, unknown>>;
  create?: boolean;
  administrative?: boolean;
  internal?: boolean;
  transactionTimeoutMs?: number;
  authorize?: (context: CommandContext) => Promise<void>;
  /** External I/O runs before the effect transaction; execute must revalidate its inputs. */
  prepare?: (context: CommandContext) => Promise<unknown>;
  execute: (context: CommandContext) => Promise<Record<string, unknown>>;
}
export const commandSpecs = new Map<string, CommandSpec>();
export function registerCommand(name: string, spec: CommandSpec) {
  if (commandSpecs.has(name)) throw new Error(`Duplicate command ${name}`);
  commandSpecs.set(name, spec);
}
export const envelopeSchema = z.strictObject({
  schemaVersion: z.literal(1), requestId: z.uuid(), targetId: z.string().min(1).max(100),
  expectedVersion: z.number().int().min(0).max(2147483646), occurredAt: z.iso.datetime({offset: true}),
  command: z.string().min(1).max(80), data: z.record(z.string(), z.unknown()),
});
export const civilDate = z.iso.date();
export const minor = z.string().regex(/^(0|[1-9]\d{0,18})$/).refine(v => BigInt(v) <= 9223372036854775807n, "Importe fuera de BigInt PostgreSQL");
export const positiveMinor = minor.refine(v => BigInt(v) > 0n, "El importe debe ser positivo");
export const decimal = z.string().regex(/^(0|[1-9]\d{0,25})(\.\d{1,12})?$/);
export const currency = z.enum(["ARS", "USD"]);
export const objectId = z.string().min(1).max(100);
export const evidence = z.record(z.string(), z.unknown()).refine(v => Object.keys(v).length > 0, "Se requiere evidencia");
const guardedAppSheetHistoryImporterVersions = [
  APPSHEET_HISTORY_IMPORTER_VERSION,
  "bombo-appsheet-history/1.1.0",
  "bombo-appsheet-history/1.0.0",
] as const;
export function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value, (_k, v) => typeof v === "bigint" ? v.toString() : v)) as Prisma.InputJsonValue;
}
export function wire<T>(value: T): T { return JSON.parse(JSON.stringify(value, (_k, v) => typeof v === "bigint" ? v.toString() : v)); }
export async function capabilities(tx: Tx, user: Pick<User,"id"|"role">): Promise<Capability[]> {
  const grant = await tx.operationAccess.findUnique({where:{userId:user.id}});
  return capabilitiesFromGrant(user, grant);
}
export async function requireCapability(tx: Tx, actor: User, capability: Capability) {
  const current = await tx.user.findUnique({where:{id:actor.id}});
  if (!current?.active || current.authorizationEpoch !== actor.authorizationEpoch) throw new OperationError(403,"AUTHORIZATION_REVOKED","La autorización fue revocada");
  if (!(await capabilities(tx, current)).includes(capability)) throw new OperationError(403,"CAPABILITY_REQUIRED","No tenés permiso para esta operación");
  if(capability==="finance.read"){
    const grant=await tx.operationAccess.findUnique({where:{userId:actor.id}}),scope=grant?.scope as {accountIds?:string[]}|undefined;
    if((grant?.profile??actor.role)==="cashier"&&!scope?.accountIds?.length)throw new OperationError(423,"CASHIER_SCOPE_PENDING","El propietario debe asignar las cuentas de caja autorizadas");
  }
}
/** Once a canonical master or supported history AppSheet source exists, legacy authority cannot govern its commands or cutover profile. */
export async function requireCanonicalAppSheetReplacementProfile(tx: Tx, requestedProfile?: string) {
  const [capture, preliminarySnapshot] = await Promise.all([
    tx.appSheetCaptureManifest.findFirst({
      where: { sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM },
      select: { captureId: true },
    }),
    tx.legacyImportSnapshot.findFirst({
      where: { OR: [
        { sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM, importerVersion: APPSHEET_CANONICAL_IMPORTER_VERSION },
        ...guardedAppSheetHistoryImporterVersions.map(importerVersion => ({ sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, importerVersion })),
      ] },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      select: { id: true, sourceSystem: true, importerVersion: true, fileHash: true, controls: true },
    }),
  ]);
  const controls = preliminarySnapshot?.controls;
  const historyImporterVersion = preliminarySnapshot?.sourceSystem === APPSHEET_HISTORY_SOURCE_SYSTEM &&
    guardedAppSheetHistoryImporterVersions.includes(preliminarySnapshot.importerVersion as typeof guardedAppSheetHistoryImporterVersions[number]);
  const projectionKey = historyImporterVersion ? "appSheetHistoryStage" : "appSheetCanonical";
  const projection = controls !== null && typeof controls === "object" && !Array.isArray(controls)
    ? (controls as Record<string, unknown>)[projectionKey]
    : null;
  const rawCaptureId = projection !== null && typeof projection === "object" && !Array.isArray(projection)
    ? (projection as Record<string, unknown>).captureId
    : null;
  const historyStage = projection !== null && typeof projection === "object" && !Array.isArray(projection)
    ? projection as Record<string, unknown>
    : null;
  // Legacy v1 remains source/blocker evidence only; readiness and writes require a bound v2 stage.
  const historyProjectionValid = !historyImporterVersion || (historyStage !== null &&
    (historyStage.schemaVersion === APPSHEET_HISTORY_STAGE_SCHEMA_VERSION_V1 ||
      (historyStage.schemaVersion === APPSHEET_HISTORY_STAGE_SCHEMA_VERSION_V2 && appSheetHistoryStageHasBoundTechnicalReview(historyStage))) &&
    historyStage.projectionKind === "history" &&
    historyStage.sourceSystem === APPSHEET_HISTORY_SOURCE_SYSTEM &&
    historyStage.importerVersion === preliminarySnapshot?.importerVersion &&
    ["stable", "preliminary-delta"].includes(String(historyStage.mode)) &&
    historyStage.status === "staged");
  const snapshotCaptureId = preliminarySnapshot && typeof rawCaptureId === "string" && /^appsreal-[a-f0-9]{16}$/.test(rawCaptureId) &&
    /^[a-f0-9]{64}$/.test(preliminarySnapshot.fileHash) && rawCaptureId === `appsreal-${preliminarySnapshot.fileHash.slice(0, 16)}` &&
    projection !== null && typeof projection === "object" && !Array.isArray(projection) &&
    (projection as Record<string, unknown>).manifestHash === preliminarySnapshot.fileHash && historyProjectionValid
    ? rawCaptureId
    : undefined;
  const sourceEvidence: { captureId?: string; snapshotId?: string } | null = capture
    ? { captureId: capture.captureId }
    : preliminarySnapshot
      ? { ...(snapshotCaptureId ? { captureId: snapshotCaptureId } : {}), snapshotId: preliminarySnapshot.id }
      : null;
  if (!sourceEvidence) return null;
  const authority = await tx.operationAuthority.findUnique({ where: { id: "operations" }, select: { mode: true, cutoverProfile: true } });
  if (requestedProfile === "legacy" || (requestedProfile === undefined && authority?.mode === "active" && authority.cutoverProfile === "legacy")) {
    throw new OperationError(423, "APPSHEET_REPLACEMENT_REQUIRED", "La fuente real de AppSheet requiere autoridad del perfil de reemplazo", {
      ...sourceEvidence,
      blockers: ["canonical_appsheet_capture_requires_replacement_profile"],
    });
  }
  return sourceEvidence;
}
export async function audit(ctx: CommandContext, action: string, details: Record<string,unknown> = {}) {
  await ctx.tx.operationAudit.create({data:{actorId:ctx.actor.id,action,objectId:ctx.envelope.targetId,requestId:ctx.envelope.requestId,details:json(details)}});
}
export async function touchAggregate(ctx:CommandContext,id:string){
 if(id!==ctx.envelope.targetId)await ctx.tx.operationObject.update({where:{id},data:{version:{increment:1}}});
}
export async function executeCommand(actor: User, input: unknown, authorization?: (ctx:CommandContext)=>Promise<void>): Promise<CommandResult> {
  const envelope = envelopeSchema.parse(input) as CommandEnvelope;
  const spec = commandSpecs.get(envelope.command);
  if (!spec) throw new OperationError(400,"UNKNOWN_COMMAND","Comando desconocido");
  envelope.data = spec.schema.parse(envelope.data);
  envelope.occurredAt = new Date(envelope.occurredAt).toISOString();
  const bodyHash = canonicalCommandBodyHash(envelope);
  let prepared: unknown;
  if (spec.prepare) {
    await requireCapability(db, actor, spec.capability);
    const authority = await db.operationAuthority.findUnique({ where: { id: "operations" } });
    const context: CommandContext = { tx: db, actor, envelope, now: new Date(), authorityEpoch: authority?.epoch ?? 1 };
    if (authorization) await authorization(context);
    await requireCommandScope(context, spec.kind);
    if (spec.authorize) await spec.authorize(context);
    const prior = await db.commandReceipt.findUnique({ where: { requestId: envelope.requestId } });
    if (prior && (prior.actorId !== actor.id || prior.bodyHash !== bodyHash))
      throw new OperationError(prior.actorId !== actor.id ? 403 : 409, prior.actorId !== actor.id ? "COMMAND_ACTOR_MISMATCH" : "IDEMPOTENCY_KEY_REUSED", "La identidad del comando ya tiene otra autorización o contenido");
    if (!prior) {
      const rehearsal = process.env.DEMO_MODE === "true" || process.env.NODE_ENV === "test" || process.env.OPERATIONAL_REHEARSAL === "true";
      if (!spec.administrative && !rehearsal && (authority?.mode !== "active" || process.env.CLUB_OPERATIONS_APPROVED !== "true"))
        throw new OperationError(423, "OPERATION_AUTHORITY_PENDING", "El circuito requiere apertura y habilitación aprobadas");
      const object = await db.operationObject.findUnique({ where: { id: envelope.targetId } });
      if (!object && !spec.create) throw new OperationError(404, "OBJECT_NOT_FOUND", "No se encontró el objeto");
      if (object && object.kind !== spec.kind) throw new OperationError(409, "OBJECT_KIND_MISMATCH", "La identidad pertenece a otro tipo de objeto");
      if ((object?.version ?? 0) !== envelope.expectedVersion) throw new OperationError(409, "VERSION_CONFLICT", "El objeto cambió; revisá la versión actual", { currentVersion: object?.version ?? 0 });
      prepared = await spec.prepare(context);
    }
  }
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(async tx => {
        await requireCapability(tx, actor, spec.capability);
        const authority = await tx.operationAuthority.findUnique({where:{id:"operations"}});
        const now = new Date();
        const ctx: CommandContext = {tx, actor, envelope, now, authorityEpoch:authority?.epoch ?? 1, prepared};
        // Object authorization is current even on a replay. No cross-actor receipt is revealed.
        if(authorization)await authorization(ctx);
        await requireCommandScope(ctx, spec.kind);
        if (spec.authorize) await spec.authorize(ctx);
        const receipt = await tx.commandReceipt.findUnique({where:{requestId:envelope.requestId}});
        if (receipt) {
          if (receipt.actorId !== actor.id) throw new OperationError(403,"COMMAND_ACTOR_MISMATCH","El comando pertenece a otra autorización");
          if (receipt.bodyHash !== bodyHash) throw new OperationError(409,"IDEMPOTENCY_KEY_REUSED","Este UUID ya se utilizó con otro contenido");
          return {...receipt.response as unknown as CommandResult, replay:true};
        }
        const rehearsal = process.env.DEMO_MODE === "true" || process.env.NODE_ENV === "test" || process.env.OPERATIONAL_REHEARSAL === "true";
        if (!spec.administrative && !rehearsal && (authority?.mode !== "active" || process.env.CLUB_OPERATIONS_APPROVED !== "true"))
          throw new OperationError(423,"OPERATION_AUTHORITY_PENDING","El circuito requiere apertura y habilitación aprobadas");
        const object = await tx.operationObject.findUnique({where:{id:envelope.targetId}});
        if (!object && !spec.create) throw new OperationError(404,"OBJECT_NOT_FOUND","No se encontró el objeto");
        if (object && object.kind !== spec.kind) throw new OperationError(409,"OBJECT_KIND_MISMATCH","La identidad pertenece a otro tipo de objeto");
        if ((object?.version ?? 0) !== envelope.expectedVersion) throw new OperationError(409,"VERSION_CONFLICT","El objeto cambió; revisá la versión actual",{currentVersion:object?.version??0});
        if (!object) await tx.operationObject.create({data:{id:envelope.targetId,kind:spec.kind,version:0,createdBy:actor.id}});
        const result = await spec.execute(ctx);
        const version = (object?.version ?? 0) + 1;
        await tx.operationObject.update({where:{id:envelope.targetId},data:{version}});
        const response: CommandResult = {requestId:envelope.requestId,targetId:envelope.targetId,version,result:wire(result)};
        await tx.commandReceipt.create({data:{requestId:envelope.requestId,actorId:actor.id,targetId:envelope.targetId,command:envelope.command,bodyHash,response:json(response),resultingVersion:version,authorityEpoch:ctx.authorityEpoch,occurredAt:new Date(envelope.occurredAt)}});
        await tx.operationOutbox.create({data:{requestId:envelope.requestId,topic:`operation.${envelope.command}`,payload:json({targetId:envelope.targetId,version})}});
        await audit(ctx,envelope.command,{version});
        if (!spec.administrative && !rehearsal && !authority?.firstRealWriteAt) await tx.operationAuthority.update({where:{id:"operations"},data:{firstRealWriteAt:now}});
        return response;
      },{isolationLevel:"Serializable",timeout:spec.transactionTimeoutMs??20000});
    } catch (error) {
      const retryableConflict = error instanceof Prisma.PrismaClientKnownRequestError &&
        (["P2034", "P2002"].includes(error.code) || (error.code === "P2010" && error.meta?.code === "40001"));
      if (retryableConflict && attempt < 4) { await new Promise(resolve=>setTimeout(resolve,20*2**attempt+Math.floor(Math.random()*20))); continue; }
      throw error;
    }
  }
}
export async function requireDelivery(ctx: CommandContext, id: string) {
  const delivery = await ctx.tx.deliveryAssignment.findUnique({where:{id}});
  if (!delivery) throw new OperationError(404,"DELIVERY_NOT_FOUND","Entrega no encontrada");
  const caps = await capabilities(ctx.tx, ctx.actor);
  if (!caps.includes("logistics.write") && delivery.driverId !== ctx.actor.id) throw new OperationError(403,"DELIVERY_SCOPE","La entrega no está asignada a tu turno");
  return delivery;
}
/** Capabilities never imply access to a cash account or a restricted member outside a configured scope. */
export async function requireAccountScope(tx:Tx,actor:User,accountIds:string[]){
 const grant=await tx.operationAccess.findUnique({where:{userId:actor.id}});
 const scope=grant?.scope as {accountIds?:string[]}|undefined;
 if(scope?.accountIds&&accountIds.some(id=>!scope.accountIds!.includes(id)))throw new OperationError(403,"ACCOUNT_SCOPE","Cuenta fuera de tu alcance");
 if((grant?.profile??actor.role)==="cashier"&&!scope?.accountIds?.length)throw new OperationError(423,"CASHIER_SCOPE_PENDING","El propietario debe asignar las cuentas de caja autorizadas");
}
export async function requireMemberScope(tx:Tx,actor:User,memberId:string){
 const grant=await tx.operationAccess.findUnique({where:{userId:actor.id}});
 const scope=grant?.scope as {memberIds?:string[]}|undefined;
 if(scope?.memberIds&&!scope.memberIds.includes(memberId))throw new OperationError(403,"MEMBER_SCOPE","Socio fuera de tu alcance");
}
export async function objectScope(tx:Tx,actor:User):Promise<{accountIds?:string[];memberIds?:string[];locationIds?:string[];custodianIds?:string[]}>{
 const grant=await tx.operationAccess.findUnique({where:{userId:actor.id}});
 return (grant?.scope&&typeof grant.scope==="object"&&!Array.isArray(grant.scope)?grant.scope:{}) as {accountIds?:string[];memberIds?:string[];locationIds?:string[];custodianIds?:string[]};
}
export async function requireFullLegacySourceScope(tx:Tx,actor:User):Promise<void>{
 const scope=await objectScope(tx,actor);
 const access=await tx.operationAccess.findUnique({where:{userId:actor.id},select:{profile:true}});
 const profile=access?.profile??actor.role;
 if(Object.values(scope).some(value=>value!==undefined)||profile==="driver"||profile==="cashier")
  throw new OperationError(403,"LEGACY_SOURCE_FULL_SCOPE_REQUIRED","La conciliación de fuentes requiere alcance operativo completo");
}
/** Resolve every declared link, including delivery-only documents; inconsistent links never grant access. */
export async function resolveDocumentMember(tx:Tx,link:{memberId?:string|null;orderId?:string|null;deliveryId?:string|null}):Promise<string|undefined>{
 let memberId=link.memberId??undefined;
 let orderId=link.orderId??undefined;
 if(link.deliveryId){
  const delivery=await tx.deliveryAssignment.findUnique({where:{id:link.deliveryId},select:{orderId:true}});
  if(!delivery||(orderId&&orderId!==delivery.orderId))throw new OperationError(403,"DOCUMENT_DELIVERY_SCOPE","La entrega referenciada no pudo verificarse");
  orderId=delivery.orderId;
 }
 if(orderId){
  const order=await tx.operationOrder.findUnique({where:{id:orderId},select:{memberId:true}});
  if(!order||(memberId&&memberId!==order.memberId))throw new OperationError(403,"DOCUMENT_ORDER_SCOPE","El documento y el pedido no corresponden al mismo socio");
  memberId=order.memberId;
 }
 return memberId;
}
export async function requireDocumentScope(tx:Tx,actor:User,link:{memberId?:string|null;orderId?:string|null;deliveryId?:string|null}){
 const memberId=await resolveDocumentMember(tx,link);
 if(memberId)await requireMemberScope(tx,actor,memberId);
 else if((await objectScope(tx,actor)).memberIds)throw new OperationError(403,"DOCUMENT_MEMBER_SCOPE","La identidad del socio debe estar verificada dentro de tu alcance");
 return memberId;
}
export async function requireLocationScope(tx:Tx,actor:User,locationIds:string[]){
 const scope=await objectScope(tx,actor);
 if(scope.locationIds&&locationIds.some(id=>!scope.locationIds!.includes(id)))throw new OperationError(403,"LOCATION_SCOPE","Ubicación fuera de tu alcance");
}
export async function requireCustodianScope(tx:Tx,actor:User,custodianIds:string[]){
 const scope=await objectScope(tx,actor);
 if(scope.custodianIds&&custodianIds.some(id=>!scope.custodianIds!.includes(id)))throw new OperationError(403,"STOCK_CUSTODIAN_SCOPE","Custodia fuera de tu alcance");
}
/** Shared scope enforcement also runs before replay, so no handler can accidentally omit it. */
async function requireCommandScope(ctx:CommandContext,kind:string){
 const {tx,actor,envelope:e}=ctx;
 const spec=commandSpecs.get(e.command);
 if(spec&&!spec.administrative)await requireCanonicalAppSheetReplacementProfile(tx);
 if(kind==="legacyImport")await requireFullLegacySourceScope(tx,actor);
 const accountIds=["accountId","fromAccountId","toAccountId","commissionAccountId","custodianAccountId"].flatMap(k=>typeof e.data[k]==="string"?[e.data[k] as string]:[]);
 if(kind==="account")accountIds.push(e.targetId);
 if(kind==="accountBootstrap"&&Array.isArray(e.data.accounts))for(const item of e.data.accounts)if(item&&typeof item==="object"&&typeof (item as {id?:unknown}).id==="string")accountIds.push((item as {id:string}).id);
 if(accountIds.length)await requireAccountScope(tx,actor,accountIds);
 const locationIds=["locationId","toLocationId","fromLocationId"].flatMap(k=>typeof e.data[k]==="string"?[e.data[k] as string]:[]);
 const balanceIds:string[]=typeof e.data.balanceId==="string"?[e.data.balanceId]:[];
 const custodianIds=["custodianId","toCustodianId","fromCustodianId","driverId"].flatMap(k=>typeof e.data[k]==="string"?[e.data[k] as string]:[]);
 for(const key of ["allocations","returns"]){
  if(!Array.isArray(e.data[key]))continue;
  for(const value of e.data[key]){
   if(!value||typeof value!=="object")continue;const row=value as Record<string,unknown>;
   if(typeof row.locationId==="string")locationIds.push(row.locationId);
   if(typeof row.balanceId==="string")balanceIds.push(row.balanceId);
   if(typeof row.custodianId==="string")custodianIds.push(row.custodianId);
   if(typeof row.allocationId==="string"){
    const allocation=await tx.preparationAllocation.findUnique({where:{id:row.allocationId},select:{balanceId:true}});
    if(allocation)balanceIds.push(allocation.balanceId);
   }
  }
 }
 if(balanceIds.length){const balances=await tx.stockBalance.findMany({where:{id:{in:balanceIds}},select:{locationId:true,custodianId:true}});locationIds.push(...balances.map(b=>b.locationId));custodianIds.push(...balances.map(b=>b.custodianId));}
 if(custodianIds.length)await requireCustodianScope(tx,actor,custodianIds);
 if(locationIds.length)await requireLocationScope(tx,actor,locationIds);
 let memberId=typeof e.data.memberId==="string"?e.data.memberId:undefined;
 if(kind==="member")memberId=e.targetId;
 if(kind==="order"){
  memberId=(await tx.operationOrder.findUnique({where:{id:e.targetId},select:{memberId:true}}))?.memberId??memberId;
  const scope=await objectScope(tx,actor);
  if(scope.locationIds||scope.custodianIds){
   // A stored receipt can include previous reservations or allocations. Recheck
   // their current object scope before returning it, even with an empty payload.
   const [reservations,allocations]=await Promise.all([
    tx.stockReservation.findMany({where:{orderId:e.targetId},select:{balanceId:true}}),
    tx.preparationAllocation.findMany({where:{orderId:e.targetId},select:{balanceId:true}}),
   ]);
   const ids=[...new Set([...reservations,...allocations].map(row=>row.balanceId))];
   if(ids.length){
    const balances=await tx.stockBalance.findMany({where:{id:{in:ids}},select:{locationId:true,custodianId:true}});
    if(balances.length!==ids.length)throw new OperationError(403,"ORDER_STOCK_SCOPE_UNVERIFIED","No pudo verificarse la custodia vinculada al pedido");
    await requireLocationScope(tx,actor,balances.map(balance=>balance.locationId));
    await requireCustodianScope(tx,actor,balances.map(balance=>balance.custodianId));
   }
  }
 }
 if(kind==="collection"){
  const c=await tx.collectionReport.findUnique({where:{id:e.targetId}});
  const orderId=c?.orderId??(typeof e.data.orderId==="string"?e.data.orderId:undefined);
  if(orderId)memberId=(await tx.operationOrder.findUnique({where:{id:orderId},select:{memberId:true}}))?.memberId;
  if(c?.accountId)await requireAccountScope(tx,actor,[c.accountId]);
  if(c){
   const scope=await objectScope(tx,actor);
   if(scope.custodianIds&&(!c.custodianId||!scope.custodianIds.includes(c.custodianId)))throw new OperationError(403,"COLLECTION_CUSTODIAN_SCOPE","Cobro fuera de la custodia autorizada");
   if(!c.accountId&&scope.accountIds&&!scope.memberIds&&!scope.custodianIds)throw new OperationError(403,"COLLECTION_PENDING_SCOPE","Asigná socios o custodios para revisar cobros todavía sin cuenta");
  }
 }
 if(kind==="delivery"){
  const d=await tx.deliveryAssignment.findUnique({where:{id:e.targetId}});
  if(d){memberId=(await tx.operationOrder.findUnique({where:{id:d.orderId},select:{memberId:true}}))?.memberId;if(d.driverId)await requireCustodianScope(tx,actor,[d.driverId]);}
 }
 if(kind==="document"){
  const document=await tx.operationDocument.findUnique({where:{id:e.targetId}});
  memberId=await requireDocumentScope(tx,actor,document??{
   memberId:typeof e.data.memberId==="string"?e.data.memberId:undefined,
   orderId:typeof e.data.orderId==="string"?e.data.orderId:undefined,
   deliveryId:typeof e.data.deliveryId==="string"?e.data.deliveryId:undefined,
  });
  if(document?.sensitivity==="clinical"||e.data.sensitivity==="clinical"){
   await requireCapability(tx,actor,"clinical.review");
   if(!memberId)throw new OperationError(422,"CLINICAL_MEMBER_REQUIRED","El documento clínico requiere un socio identificado");
  }
 }
 if(kind==="route"){const scope=await objectScope(tx,actor);if(scope.memberIds)throw new OperationError(403,"ROUTE_SCOPE","La coordinación general de rutas requiere alcance comercial completo");const route=await tx.deliveryRoute.findUnique({where:{id:e.targetId},select:{driverId:true}});if(route)await requireCustodianScope(tx,actor,[route.driverId]);}
 if(kind==="stock"||kind==="stockCount"){
  const count=kind==="stockCount"?await tx.operationalStockCount.findUnique({where:{id:e.targetId}}):null;
  const balanceId=count?.balanceId??(typeof e.data.balanceId==="string"?e.data.balanceId:undefined);
  const balance=balanceId?await tx.stockBalance.findUnique({where:{id:balanceId}}):null;
  const ids=[...(balance?[balance.locationId]:[]),...(typeof e.data.toLocationId==="string"?[e.data.toLocationId]:[])];
  if(ids.length)await requireLocationScope(tx,actor,ids);
  if(balance)await requireCustodianScope(tx,actor,[balance.custodianId]);
 }
 if(memberId)await requireMemberScope(tx,actor,memberId);
}
