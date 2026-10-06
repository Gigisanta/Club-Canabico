import { Router } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "../db.js";
import { executeCommand, envelopeSchema, commandSpecs, OperationError, requireCapability, json, wire, type Tx } from "./core.js";
import { canonicalCommandBodyHash } from "./canonical.js";
import { canonicalJson } from "../../shared/operations/exact.js";
import { isAppSheetInvoiceTotalPending } from "../../shared/operations/appsheet.js";
export const deliverySyncRoutes=Router();
const allowed=new Set(["DeliveryRecorded","DeliveryIncident","CollectionReported"]);
const eventSchema=envelopeSchema.extend({sequence:z.number().int().min(1).optional(),dependsOn:z.uuid().nullable().optional()});
const sync=z.strictObject({leaseId:z.uuid(),deviceId:z.uuid(),events:z.array(eventSchema).max(500)});
const OFFLINE_DOCUMENT_MEDIA_TYPES = new Set(["application/pdf", "image/png", "image/jpeg"]);

export interface OfflineManifestDocumentSource {
 id:string;deliveryId:string|null;sensitivity:string;state:string;kind:string;
 checksum:string|null;objectVersion:string|null;mediaType:string|null;bytes:number|null;
}

/** Only project an immutable, size-bounded document whose bytes can be verified by the client. */
export function projectOfflineManifestDocument(doc:OfflineManifestDocumentSource,deliveryId:string){
 if(doc.deliveryId!==deliveryId||!["commercial","transport"].includes(doc.sensitivity)||doc.state!=="available"||
  typeof doc.checksum!=="string"||!/^[a-f0-9]{64}$/.test(doc.checksum)||typeof doc.objectVersion!=="string"||!doc.objectVersion||
  typeof doc.mediaType!=="string"||!OFFLINE_DOCUMENT_MEDIA_TYPES.has(doc.mediaType)||!Number.isSafeInteger(doc.bytes)||doc.bytes===null||doc.bytes<1||doc.bytes>3_000_000)return undefined;
 return {id:doc.id,name:doc.kind,url:`/api/operations/documents/${encodeURIComponent(doc.id)}/content`,
  sha256:doc.checksum,byteLength:doc.bytes,mimeType:doc.mediaType,version:doc.objectVersion};
}
type OfflineManifestDocument = NonNullable<ReturnType<typeof projectOfflineManifestDocument>>;
async function preserveQuarantine(userId:string,deviceId:string,leaseId:string,envelope:z.infer<typeof envelopeSchema>,reason:string){
 // PostgreSQL's unique UUID arbitrates concurrent submissions; inspect the row returned by upsert.
 const saved=await db.offlineQuarantine.upsert({where:{requestId:envelope.requestId},create:{requestId:envelope.requestId,userId,deviceId,leaseId,targetId:envelope.targetId,envelope:json(envelope),reason},update:{}});
 if(saved.userId!==userId)throw new OperationError(403,"COMMAND_ACTOR_MISMATCH","El evento corresponde a otra autorización");
 if(canonicalJson(saved.envelope)!==canonicalJson(envelope))throw new OperationError(409,"IDEMPOTENCY_KEY_REUSED","El UUID ya tiene otro contenido conservado");
}
deliverySyncRoutes.get("/devices/current",async(req,res)=>{
 await requireCapability(db,req.user,"delivery.report");const id=z.uuid().parse(req.query.deviceId);
 const device=await db.operationDevice.findUnique({where:{id}});if(!device||device.userId!==req.user.id)throw new OperationError(404,"DEVICE_NOT_FOUND","Registrá este dispositivo antes de preparar el turno");
 if(device.revokedAt)throw new OperationError(403,"DEVICE_REVOKED","El dispositivo fue revocado");
 res.json({device:{id:device.id,name:device.name,storageCertified:Boolean(device.storageCertified&&device.storageCertifiedAt),storageCertifiedAt:device.storageCertifiedAt?.toISOString()??null},version:(await db.operationObject.findUnique({where:{id}}))?.version??0});
});
async function leaseCurrent(userId:string,deviceId:string,leaseId:string,reader:Tx=db){
 const [lease,device,user,authority]=await Promise.all([reader.offlineLease.findUnique({where:{id:leaseId}}),reader.operationDevice.findUnique({where:{id:deviceId}}),reader.user.findUnique({where:{id:userId}}),reader.operationAuthority.findUnique({where:{id:"operations"}})]);
 const now=new Date();
 const reason=!lease||lease.userId!==userId||lease.deviceId!==deviceId?"LEASE_SCOPE":!user?.active?"USER_REVOKED":!device||device.userId!==userId||device.revokedAt?"DEVICE_REVOKED":lease.revokedAt?"LEASE_REVOKED":lease.expiresAt<=now?"LEASE_EXPIRED":lease.authorizationEpoch!==user.authorizationEpoch?"AUTHORIZATION_CHANGED":lease.authorityEpoch!==(authority?.epoch??1)?"AUTHORITY_CHANGED":null;
 return {lease,device,user,reason};
}
deliverySyncRoutes.get("/manifests/current",async(req,res)=>{
 await requireCapability(db,req.user,"delivery.report");
 const deviceId=z.uuid().parse(req.query.deviceId);
 const device=await db.operationDevice.findUnique({where:{id:deviceId}});
 if(!device||device.userId!==req.user.id||device.revokedAt)throw new OperationError(403,"DEVICE_SCOPE","Dispositivo no autorizado");
 if(!device.storageCertified||!device.storageCertifiedAt)throw new OperationError(423,"DEVICE_NOT_CERTIFIED","El dispositivo requiere prueba de almacenamiento y reinicio");
 const foundAssignments=await db.deliveryAssignment.findMany({where:{driverId:req.user.id,status:{in:["assigned","dispatched","partially_delivered"]}},orderBy:[{routeId:"asc"},{stopSequence:"asc"}]});
 const now=new Date(),orderIds=[...new Set(foundAssignments.map(a=>a.orderId))];
 const foundOrders=await db.operationOrder.findMany({where:{id:{in:orderIds}},include:{lines:true}});
 if(foundOrders.length!==orderIds.length)throw new OperationError(409,"DELIVERY_ORDER_PENDING","Una entrega asignada no tiene un pedido disponible");
 const pendingTotalIds=new Set(foundOrders.filter(order=>isAppSheetInvoiceTotalPending(order.quote)).map(order=>order.id));
 const assignments=foundAssignments.filter(assignment=>!pendingTotalIds.has(assignment.orderId));
 const orders=foundOrders.filter(order=>!pendingTotalIds.has(order.id));
 const ids=assignments.map(a=>a.id),routeIds=[...new Set(assignments.flatMap(a=>a.routeId?[a.routeId]:[]))];
 const orderById=new Map(orders.map(order=>[order.id,order]));
 const memberIds=[...new Set(orders.map(order=>order.memberId))];
 const skuIds=[...new Set(orders.flatMap(order=>order.lines.map(line=>line.skuId)))];
 const civilToday=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Argentina/Buenos_Aires"}).format(now);
 const [versions,members,skus,documents,permissions,routes]=await Promise.all([
  db.operationObject.findMany({where:{id:{in:ids}}}),
  db.operationMember.findMany({where:{id:{in:memberIds}},select:{id:true,name:true,phone:true}}),
  db.catalogSku.findMany({where:{id:{in:skuIds}},select:{id:true,name:true}}),
  db.operationDocument.findMany({where:{deliveryId:{in:ids},sensitivity:{not:"clinical"},state:"available"},select:{id:true,deliveryId:true,kind:true,sensitivity:true,state:true,validUntil:true,checksum:true,objectVersion:true,mediaType:true,bytes:true}}),
  db.memberPermission.findMany({where:{memberId:{in:memberIds},kind:"operations",status:"verified",validFrom:{lte:civilToday},validUntil:{gte:civilToday}},select:{memberId:true,validUntil:true}}),
  db.deliveryRoute.findMany({where:{id:{in:routeIds},driverId:req.user.id},select:{id:true,shiftDate:true}}),
 ]);
 const memberById=new Map(members.map(member=>[member.id,member]));
 const skuNameById=new Map(skus.map(sku=>[sku.id,sku.name]));
 const routeById=new Map(routes.map(route=>[route.id,route]));
 const latestPermissionEndByMember=new Map<string,string>();
 for(const permission of permissions){
  if(!permission.validUntil)continue;
  const previous=latestPermissionEndByMember.get(permission.memberId);
  if(!previous||permission.validUntil>previous)latestPermissionEndByMember.set(permission.memberId,permission.validUntil);
 }
 const assignmentMemberIds=[...new Set(orders.map(order=>order.memberId))];
 for(const memberId of assignmentMemberIds)if(!memberById.has(memberId))throw new OperationError(409,"DELIVERY_MEMBER_PENDING","Un pedido asignado no tiene datos de socio disponibles");
 const permissionEndByMember=new Map<string,Date>();
 for(const memberId of assignmentMemberIds){
  const validUntil=latestPermissionEndByMember.get(memberId);
  if(!validUntil)throw new OperationError(423,"MEMBER_PERMISSION_PENDING","Un pedido asignado requiere permiso vigente");
  const end=new Date(`${validUntil}T23:59:59-03:00`);
  if(!Number.isFinite(end.getTime()))throw new OperationError(423,"MEMBER_PERMISSION_PENDING","Un permiso de pedido tiene una vigencia inválida");
  permissionEndByMember.set(memberId,end);
 }
 const documentIds=documents.map(document=>document.id);
 const grants=documentIds.length?await db.documentAuthorization.findMany({where:{userId:req.user.id,documentId:{in:documentIds},deliveryId:{in:ids},expiresAt:{gt:now}},select:{documentId:true,deliveryId:true,expiresAt:true}}):[];
 const grantsByDocument=new Map<string,typeof grants[number]>();
 for(const grant of grants)grantsByDocument.set(grant.documentId,grant);
 const documentsByDelivery=new Map<string,typeof documents>();
 for(const document of documents){if(!document.deliveryId)continue;const list=documentsByDelivery.get(document.deliveryId)??[];list.push(document);documentsByDelivery.set(document.deliveryId,list);}
 const versionById=new Map(versions.map(version=>[version.id,version.version]));
 let expiresAt=new Date(now.getTime()+12*3600000);
 for(const end of permissionEndByMember.values())if(end<expiresAt)expiresAt=end;
 const docsByAssignment=new Map<string,OfflineManifestDocument[]>();
 for(const assignment of assignments){
  const order=orderById.get(assignment.orderId)!;
  const docs:OfflineManifestDocument[]=[];
  for(const doc of documentsByDelivery.get(assignment.id)??[]){
   const grant=grantsByDocument.get(doc.id);
   if(!grant||grant.deliveryId!==assignment.id||(doc.validUntil&&doc.validUntil<civilToday))continue;
   const projected=projectOfflineManifestDocument(doc,assignment.id);
   if(!projected)continue;
   docs.push(projected);
   if(grant.expiresAt<expiresAt)expiresAt=grant.expiresAt;
   if(doc.validUntil){const documentEnd=new Date(`${doc.validUntil}T23:59:59-03:00`);if(Number.isFinite(documentEnd.getTime())&&documentEnd<expiresAt)expiresAt=documentEnd;}
  }
  docsByAssignment.set(assignment.id,docs);
 }
 const payload=assignments.map(a=>{
  const order=orderById.get(a.orderId)!;const member=memberById.get(order.memberId)!;
  const route=a.routeId?routeById.get(a.routeId):undefined;
  const lines=order.lines.map(line=>{const name=skuNameById.get(line.skuId);if(!name)throw new OperationError(409,"DELIVERY_CATALOG_PENDING","Un pedido asignado contiene un artículo sin nombre de catálogo");const remaining=line.prepared.sub(line.delivered);return {id:line.id,skuId:line.skuId,name,unit:line.unit,requested:line.requested.toString(),prepared:line.prepared.toString(),delivered:line.delivered.toString(),remaining:remaining.gt(0)?remaining.toString():"0",actualQuantity:line.prepared.toString()};});
  return {id:a.id,orderId:order.id,version:versionById.get(a.id)??0,customerName:member.name,contact:member.phone,address:a.address,window:[a.windowStart,a.windowEnd].filter(Boolean).join(" – "),...(route?{route:{date:route.shiftDate,stop:a.stopSequence+1,...(a.eta?{eta:a.eta}:{}),etaIsEstimate:a.etaIsEstimate}}:{}),lines,documents:docsByAssignment.get(a.id)??[],totalMinor:order.totalMinor.toString(),verifiedMinor:order.verifiedMinor.toString(),currency:order.currency};
 });
 const authority=await db.operationAuthority.findUnique({where:{id:"operations"}});
 const lease=await db.offlineLease.create({data:{userId:req.user.id,deviceId,sessionId:req.sessionId,authorizationEpoch:req.user.authorizationEpoch,authorityEpoch:authority?.epoch??1,assignments:json(ids),expiresAt}});
 res.json(wire({version:1,userId:req.user.id,deviceId,leaseId:lease.id,authorizationEpoch:req.user.authorizationEpoch,expiresAt,assignments:payload,storageCertification:{persistent:true,requested:true,storageCertifiedAt:device.storageCertifiedAt.toISOString()}}));
});
deliverySyncRoutes.post("/sync",async(req,res)=>{
 const input=sync.parse(req.body);const state=await leaseCurrent(req.user.id,input.deviceId,input.leaseId);const lease=state.lease,reason=req.offlineArchiveOnly?"ONLINE_SESSION_UNAUTHORIZED":state.reason;
 const assigned=Array.isArray(lease?.assignments)?lease.assignments as string[]:[];
 const results:Record<string,unknown>[]=[];const statuses=new Map<string,string>();
 const seen=new Set<string>();
 for(const event of [...input.events].sort((a,b)=>(a.sequence??0)-(b.sequence??0))){
  if(seen.has(event.requestId)){results.push({requestId:event.requestId,status:"rejected",code:"DUPLICATE_BATCH_UUID"});continue;}seen.add(event.requestId);
  const {sequence,dependsOn,...envelope}=event;
  const deliveryId=envelope.command==="CollectionReported"?envelope.data.deliveryId as string:envelope.targetId;
  let quarantineReason=reason;
  const delivery=deliveryId?await db.deliveryAssignment.findUnique({where:{id:deliveryId}}):null;
  if(!quarantineReason&&(!assigned.includes(deliveryId)||delivery?.driverId!==req.user.id))quarantineReason="ASSIGNMENT_CHANGED";
  if(!quarantineReason&&envelope.command==="CollectionReported"&&delivery){
   const order=await db.operationOrder.findUnique({where:{id:delivery.orderId},select:{quote:true}});
   if(order&&isAppSheetInvoiceTotalPending(order.quote)){
    results.push({requestId:event.requestId,status:"rejected",code:"INVOICE_TOTAL_DEFINITION_PENDING"});statuses.set(event.requestId,"rejected");continue;
   }
  }
  if(quarantineReason){
   let alreadyCommitted=false;
   try{
    const receipt=await db.commandReceipt.findUnique({where:{requestId:envelope.requestId}});
    if(receipt){
     if(receipt.actorId!==req.user.id)throw new OperationError(403,"COMMAND_ACTOR_MISMATCH","El evento corresponde a otra autorización");
     const spec=commandSpecs.get(envelope.command);
     let matches=false;
     try{matches=Boolean(spec&&receipt.bodyHash===canonicalCommandBodyHash({...envelope,data:spec.schema.parse(envelope.data),occurredAt:new Date(envelope.occurredAt).toISOString()}));}catch{matches=false;}
     if(!matches)throw new OperationError(409,"IDEMPOTENCY_KEY_REUSED","El UUID ya tiene otro contenido confirmado");
     alreadyCommitted=true;
    }
    // Even an acknowledged replay is retained under the current loss of authority. It must
    // be closed against its original receipt, never reproduced with a fresh command UUID.
    await preserveQuarantine(req.user.id,input.deviceId,input.leaseId,envelope,quarantineReason+(alreadyCommitted?":ALREADY_COMMITTED":""));
   }catch(e){if(!(e instanceof OperationError))throw e;results.push({requestId:event.requestId,status:"rejected",code:e.code});statuses.set(event.requestId,"rejected");continue;}
   results.push({requestId:event.requestId,status:"quarantined",code:quarantineReason,alreadyCommitted});statuses.set(event.requestId,"quarantined");continue;
  }
  if(!allowed.has(envelope.command)){results.push({requestId:event.requestId,status:"rejected",code:"OFFLINE_COMMAND_NOT_ALLOWED"});statuses.set(event.requestId,"rejected");continue;}
  if(dependsOn){
   const status=statuses.get(dependsOn);const receipt=await db.commandReceipt.findUnique({where:{requestId:dependsOn}});
   if(!["accepted","duplicate"].includes(status??"")&&(!receipt||receipt.actorId!==req.user.id)){results.push({requestId:event.requestId,status:"blocked",code:"DEPENDENCY_PENDING"});statuses.set(event.requestId,"blocked");continue;}
  }
  try{const result=await executeCommand(req.user,envelope,async ctx=>{
   const fresh=await leaseCurrent(ctx.actor.id,input.deviceId,input.leaseId,ctx.tx);
   const permitted=Array.isArray(fresh.lease?.assignments)?fresh.lease.assignments as string[]:[];
   const currentDelivery=await ctx.tx.deliveryAssignment.findUnique({where:{id:deliveryId}});
   if(fresh.reason||!permitted.includes(deliveryId)||currentDelivery?.driverId!==ctx.actor.id)throw new OperationError(403,"OFFLINE_AUTHORITY_QUARANTINE",fresh.reason??"ASSIGNMENT_CHANGED");
  });const status=result.replay?"duplicate":"accepted";statuses.set(event.requestId,status);results.push({requestId:event.requestId,status,version:result.version,result:result.result,replay:Boolean(result.replay)});}
  catch(e){if(e instanceof OperationError){let status=e.code==="VERSION_CONFLICT"?"conflict":"rejected";
   if(["OFFLINE_AUTHORITY_QUARANTINE","AUTHORIZATION_REVOKED"].includes(e.code)){
    try{await preserveQuarantine(req.user.id,input.deviceId,input.leaseId,envelope,e.code);status="quarantined";}catch(collision){if(!(collision instanceof OperationError))throw collision;statuses.set(event.requestId,"rejected");results.push({requestId:event.requestId,status:"rejected",code:collision.code});continue;}
   }
   statuses.set(event.requestId,status);results.push({requestId:event.requestId,status,code:e.code,message:e.message});}else if(e instanceof z.ZodError){statuses.set(event.requestId,"rejected");results.push({requestId:event.requestId,status:"rejected",code:"INVALID_EVENT"});}else throw e;}
 }
 res.json({results});
});
const backup=z.strictObject({leaseId:z.uuid(),deviceId:z.uuid(),package:z.record(z.string(),z.unknown()),sha256:z.string().regex(/^[a-f0-9]{64}$/)});
deliverySyncRoutes.post("/backups",async(req,res)=>{
 const v=backup.parse(req.body);const lease=await db.offlineLease.findUnique({where:{id:v.leaseId}});
 // Storing encrypted evidence remains safe after expiry; it never reauthorizes a command.
 if(!lease||lease.userId!==req.user.id||lease.deviceId!==v.deviceId)throw new OperationError(403,"BACKUP_SCOPE","La copia corresponde a otro usuario o dispositivo");
 const p=v.package as {schemaVersion?:number;userId?:string;sourceDeviceId?:string;queuePayload?:{algorithm?:string;iv?:string;ciphertext?:string};documentsPayload?:{algorithm?:string;iv?:string;ciphertext?:string}};
 if(p.schemaVersion!==1||p.userId!==req.user.id||p.sourceDeviceId!==v.deviceId||[p.queuePayload,p.documentsPayload].some(part=>part?.algorithm!=="AES-256-GCM"||typeof part.ciphertext!=="string"||typeof part.iv!=="string"))throw new OperationError(422,"BACKUP_FORMAT","Paquete cifrado inválido");
 const hash=createHash("sha256").update(canonicalJson(v.package)).digest("hex");
 if(hash!==v.sha256)throw new OperationError(422,"BACKUP_INTEGRITY","No coincide la integridad de la copia");
 const saved=await db.offlineBackup.upsert({where:{userId_deviceId_sha256:{userId:req.user.id,deviceId:v.deviceId,sha256:hash}},create:{userId:req.user.id,deviceId:v.deviceId,leaseId:v.leaseId,sha256:hash,package:json(v.package)},update:{}});
 res.json({backupId:saved.id,sha256:hash,durable:true});
});
deliverySyncRoutes.get("/quarantine",async(req,res)=>{await requireCapability(db,req.user,"queue.recover");const items=await db.offlineQuarantine.findMany({where:{resolvedBy:null},select:{requestId:true,userId:true,deviceId:true,leaseId:true,targetId:true,reason:true,createdAt:true}});res.json({items});});
