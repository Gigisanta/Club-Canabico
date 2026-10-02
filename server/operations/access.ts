import type { RequestHandler } from "express";
import { z } from "zod";
import { db } from "../db.js";
import { profileCapabilities, cutoverGateIds, type Capability } from "../../shared/operations/contracts.js";
import { registerCommand, OperationError, json, capabilities, requireCapability, objectId, evidence, civilDate, requireMemberScope, requireDocumentScope, objectScope, type CommandContext } from "./core.js";
import { commercialAddress, commercialPreferences } from "./member-fields.js";
const profile = z.enum(["owner","finance","commercial","stock","logistics","driver","cashier","clinical","viewer"]);
const defaultCapabilities = new Set(Object.values(profileCapabilities).flat());
registerCommand("AccessGranted",{kind:"access",capability:"access.manage",create:true,administrative:true,
 schema:z.strictObject({userId:objectId,profile,additional:z.array(z.string()).default([]),scope:z.strictObject({accountIds:z.array(objectId).optional(),memberIds:z.array(objectId).optional(),locationIds:z.array(objectId).optional(),custodianIds:z.array(objectId).optional()}).default({})}),
 execute:async ctx=>{
  const v=ctx.envelope.data as {userId:string;profile:string;additional:string[];scope:Record<string,unknown>};
  if (!await ctx.tx.user.findUnique({where:{id:v.userId}})) throw new OperationError(404,"USER_NOT_FOUND","Usuario no encontrado");
  if(v.additional.some(c=>!defaultCapabilities.has(c as Capability))) throw new OperationError(400,"UNKNOWN_CAPABILITY","Capacidad desconocida");
  const granted=[...new Set([...profileCapabilities[v.profile],...v.additional])];
  await ctx.tx.operationAccess.upsert({where:{userId:v.userId},create:{userId:v.userId,profile:v.profile,capabilities:json(granted),scope:json(v.scope)},update:{profile:v.profile,capabilities:json(granted),scope:json(v.scope),enabled:true}});
  await ctx.tx.user.update({where:{id:v.userId},data:{authorizationEpoch:{increment:1}}});
  await ctx.tx.operationSession.updateMany({where:{userId:v.userId,revokedAt:null},data:{revokedAt:ctx.now}});
  await ctx.tx.offlineLease.updateMany({where:{userId:v.userId,revokedAt:null},data:{revokedAt:ctx.now}});
  return {userId:v.userId,profile:v.profile,capabilities:granted,requiresLogin:true};
 }});
registerCommand("AccessRevoked",{kind:"access",capability:"access.manage",create:true,administrative:true,
 schema:z.strictObject({userId:objectId,reason:z.string().min(1).max(1000)}),
 execute:async ctx=>{
  const id=ctx.envelope.data.userId as string;
  if(id===ctx.actor.id)throw new OperationError(409,"SELF_REVOCATION","Otro propietario debe revisar la revocación propia");
  await ctx.tx.user.update({where:{id},data:{active:false,authorizationEpoch:{increment:1}}});
  await ctx.tx.operationAccess.updateMany({where:{userId:id},data:{enabled:false}});
  await ctx.tx.operationSession.updateMany({where:{userId:id},data:{revokedAt:ctx.now}});
  await ctx.tx.operationDevice.updateMany({where:{userId:id},data:{revokedAt:ctx.now}});
  await ctx.tx.offlineLease.updateMany({where:{userId:id},data:{revokedAt:ctx.now}});
  return {userId:id,status:"revoked"};
 }});
registerCommand("DeviceRegistered",{kind:"device",capability:"delivery.report",create:true,administrative:true,
 schema:z.strictObject({name:z.string().min(1).max(100)}),
 execute:async ctx=>{
  if(!z.uuid().safeParse(ctx.envelope.targetId).success)throw new OperationError(400,"DEVICE_UUID_REQUIRED","El dispositivo requiere UUID");
  const device=await ctx.tx.operationDevice.create({data:{id:ctx.envelope.targetId,userId:ctx.actor.id,name:ctx.envelope.data.name as string}});
  return {device};
 }});
registerCommand("DeviceCertified",{kind:"device",capability:"access.manage",administrative:true,
 schema:z.strictObject({storageCertified:z.literal(true),evidence}),
 execute:async ctx=>({device:await ctx.tx.operationDevice.update({where:{id:ctx.envelope.targetId},data:{storageCertified:true,storageCertifiedAt:ctx.now,evidence:json(ctx.envelope.data.evidence)}})})});
registerCommand("DeviceRevoked",{kind:"device",capability:"access.manage",administrative:true,
 schema:z.strictObject({reason:z.string().min(1).max(1000)}),
 execute:async ctx=>{
  await ctx.tx.operationDevice.update({where:{id:ctx.envelope.targetId},data:{revokedAt:ctx.now}});
  await ctx.tx.offlineLease.updateMany({where:{deviceId:ctx.envelope.targetId,revokedAt:null},data:{revokedAt:ctx.now}});
  return {status:"revoked"};
 }});
registerCommand("MemberCreated",{kind:"member",capability:"members.write",create:true,
 schema:z.strictObject({name:z.string().min(1).max(200),email:z.union([z.email(),z.literal("")]).default(""),phone:z.string().max(80).default(""),address:commercialAddress.default({}),preferences:commercialPreferences.default({})}),
 execute:async ctx=>({member:await ctx.tx.operationMember.create({data:{id:ctx.envelope.targetId,...ctx.envelope.data as {name:string;email:string;phone:string},address:json(ctx.envelope.data.address),preferences:json(ctx.envelope.data.preferences)}})})});
registerCommand("MemberUpdated",{kind:"member",capability:"members.write",
 schema:z.strictObject({name:z.string().min(1).max(200),email:z.union([z.email(),z.literal("")]),phone:z.string().max(80),address:commercialAddress,preferences:commercialPreferences}),
 execute:async ctx=>({member:await ctx.tx.operationMember.update({where:{id:ctx.envelope.targetId},data:{...ctx.envelope.data as {name:string;email:string;phone:string},address:json(ctx.envelope.data.address),preferences:json(ctx.envelope.data.preferences)}})})});
registerCommand("PermissionVerified",{kind:"member",capability:"permissions.verify",
 schema:z.strictObject({kind:z.string().min(1).max(80),validFrom:civilDate,validUntil:civilDate,evidenceDocumentId:z.uuid()}),
 execute:async ctx=>{
  const v=ctx.envelope.data as {kind:string;validFrom:string;validUntil:string;evidenceDocumentId:string};
  if(v.validUntil<v.validFrom)throw new OperationError(400,"PERMISSION_DATES","La vigencia está invertida");
  const document=await ctx.tx.operationDocument.findUnique({where:{id:v.evidenceDocumentId}});
  if(!document||document.memberId!==ctx.envelope.targetId||document.state!=="available")throw new OperationError(422,"PERMISSION_EVIDENCE","Se requiere documento disponible del socio");
  if(document.sensitivity==="clinical")await requireCapability(ctx.tx,ctx.actor,"clinical.review");
  const permission=await ctx.tx.memberPermission.create({data:{memberId:ctx.envelope.targetId,...v,status:"verified",reviewerId:ctx.actor.id,reviewedAt:ctx.now}});
  return {permission};
 }});
registerCommand("ClinicalRecordReviewed",{kind:"member",capability:"clinical.review",administrative:true,
 schema:z.strictObject({status:z.enum(["verified","rejected","needs_information"]),evidenceDocumentId:z.uuid(),evidence}),execute:async ctx=>{
  const document=await ctx.tx.operationDocument.findUnique({where:{id:ctx.envelope.data.evidenceDocumentId as string}});
  if(!document||document.memberId!==ctx.envelope.targetId||document.sensitivity!=="clinical"||document.state!=="available")throw new OperationError(422,"CLINICAL_EVIDENCE_REQUIRED","La revisión requiere un documento clínico disponible del socio");
  const provenance=json({evidenceDocumentId:document.id,checksum:document.checksum,reference:ctx.envelope.data.evidence});
  const clinical=await ctx.tx.memberClinicalRecord.upsert({where:{memberId:ctx.envelope.targetId},create:{memberId:ctx.envelope.targetId,provenance,encryptedObjectKey:document.objectKey,verification:ctx.envelope.data.status as string,reviewedBy:ctx.actor.id,reviewedAt:ctx.now},update:{provenance,encryptedObjectKey:document.objectKey,verification:ctx.envelope.data.status as string,reviewedBy:ctx.actor.id,reviewedAt:ctx.now}});
  return {clinical};
 }});
registerCommand("CutoverGateReviewed",{kind:"cutover",capability:"cutover.approve",create:true,administrative:true,
 schema:z.strictObject({gateId:z.enum(cutoverGateIds),evidence,authorId:objectId}),
 execute:async ctx=>{
  const v=ctx.envelope.data as {gateId:string;evidence:Record<string,unknown>;authorId:string};
  if(v.authorId===ctx.actor.id)throw new OperationError(409,"INDEPENDENT_REVIEW_REQUIRED","Autor y revisor deben ser personas distintas");
  if(!await ctx.tx.user.findUnique({where:{id:v.authorId}}))throw new OperationError(404,"AUTHOR_NOT_FOUND","Autor no encontrado");
  await ctx.tx.cutoverGate.upsert({where:{id:v.gateId},create:{id:v.gateId,status:"approved",evidence:json(v.evidence),approvedBy:v.authorId,reviewedBy:ctx.actor.id,approvedAt:ctx.now},update:{status:"approved",evidence:json(v.evidence),approvedBy:v.authorId,reviewedBy:ctx.actor.id,approvedAt:ctx.now}});
  return {gateId:v.gateId,status:"approved"};
 }});
registerCommand("AuthorityActivated",{kind:"authority",capability:"cutover.approve",create:true,administrative:true,
 schema:z.strictObject({evidence}),
 execute:async ctx=>{
  if(ctx.envelope.targetId!=="operations")throw new OperationError(400,"AUTHORITY_ID","Circuito inválido");
  const gates=await ctx.tx.cutoverGate.findMany({where:{id:{in:[...cutoverGateIds]},status:"approved"}});
  const missing=cutoverGateIds.filter(id=>!gates.some(g=>g.id===id&&g.reviewedBy&&g.approvedBy!==g.reviewedBy));
  if(missing.length)throw new OperationError(422,"CUTOVER_GATES_PENDING","Faltan controles para el cambio de autoridad",{missing});
  const old=await ctx.tx.operationAuthority.findUnique({where:{id:"operations"}});
  if(old?.mode==="active")throw new OperationError(409,"AUTHORITY_ALREADY_ACTIVE","El circuito ya está activo");
  const authority=await ctx.tx.operationAuthority.upsert({where:{id:"operations"},create:{id:"operations",mode:"active",epoch:2,approvedBy:ctx.actor.id,evidence:json(ctx.envelope.data.evidence)},update:{mode:"active",epoch:{increment:1},approvedBy:ctx.actor.id,evidence:json(ctx.envelope.data.evidence)}});
  return {authority};
 }});
/** Field/route enforcement for compatibility APIs. Driver and clinical profiles have no broad legacy views. */
export const legacyAccessGuard: RequestHandler = async (req,res,next)=>{
  try {
    if(/^\/(operations|delivery|legacy-imports)(\/|$)/.test(req.path)||/^\/reports\/operations(\/|$)/.test(req.path))return next();
    const grant=await db.operationAccess.findUnique({where:{userId:req.user.id}});
    const caps=await capabilities(db,req.user);
    if(grant&&(!grant.enabled||["driver","clinical"].includes(grant.profile)))throw new OperationError(403,"LEGACY_SCOPE","Usá las vistas autorizadas de tu perfil");
    const scope=grant?.scope as {accountIds?:string[];memberIds?:string[];locationIds?:string[]}|undefined;
    if(scope&&Object.values(scope).some(v=>Array.isArray(v)))throw new OperationError(403,"LEGACY_SCOPE","Las vistas antiguas no permiten comprobar tu alcance por objeto; usá operación");
    const finance=/^\/(finance|cash|expenses|closures|decision-analysis\/(cash|finance))/.test(req.path)||req.path==="/views/finance";
    if(finance&&grant&&!caps.includes("finance.read"))throw new OperationError(403,"CAPABILITY_REQUIRED","Acceso financiero restringido");
    if(/^\/reports/.test(req.path)&&grant&&!caps.includes("reports.read"))throw new OperationError(403,"CAPABILITY_REQUIRED","Exportación restringida");
    if(req.method!=="GET"&&req.method!=="HEAD"){
      const authority=await db.operationAuthority.findUnique({where:{id:"operations"}});
      if(authority?.mode==="active")throw new OperationError(410,"LEGACY_WRITER_RETIRED","Este circuito usa los comandos operativos de Bombo");
    }
    next();
  }catch(e){next(e);}
};
export async function authorizeDocument(ctx: Pick<CommandContext,"tx"|"actor"|"now">, documentId: string) {
  const doc=await ctx.tx.operationDocument.findUnique({where:{id:documentId}});
  if(!doc)throw new OperationError(404,"DOCUMENT_NOT_FOUND","Documento no encontrado");
  const caps=await capabilities(ctx.tx,ctx.actor);
  await requireDocumentScope(ctx.tx,ctx.actor,doc);
  if(doc.sensitivity==="clinical"){
    await requireCapability(ctx.tx,ctx.actor,"clinical.read");
  }else if(!caps.includes("documents.read")){
    const grant=await ctx.tx.documentAuthorization.findUnique({where:{documentId_userId:{documentId,userId:ctx.actor.id}}});
    const delivery=doc.deliveryId?await ctx.tx.deliveryAssignment.findUnique({where:{id:doc.deliveryId}}):null;
    if(!caps.includes("delivery.report")||!grant||grant.expiresAt<=ctx.now||delivery?.driverId!==ctx.actor.id||grant.deliveryId!==doc.deliveryId)
      throw new OperationError(403,"DOCUMENT_SCOPE","Documento fuera de tu autorización");
  }
  if(doc.validUntil&&doc.validUntil<new Intl.DateTimeFormat("en-CA",{timeZone:"America/Argentina/Buenos_Aires"}).format(ctx.now))throw new OperationError(403,"DOCUMENT_EXPIRED","Documento vencido");
  return doc;
}
