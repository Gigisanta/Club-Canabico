import { Router } from "express";
import { z } from "zod";
import { createHash, privateDecrypt, publicEncrypt, constants, createPublicKey, type KeyObject } from "node:crypto";
import { db } from "../db.js";
import { registerCommand, requireCapability, capabilities, OperationError, evidence, json, commandSpecs } from "./core.js";
import { canonicalCommandBodyHash } from "./canonical.js";
import type { CommandEnvelope } from "../../shared/operations/contracts.js";
export const recoveryRoutes=Router();
function parseRecipientPublicKey(value:string):{spki:Buffer;fingerprint:string}{
 let key:KeyObject;
 try{key=createPublicKey(value);}catch{throw new OperationError(400,"RECOVERY_RECIPIENT_KEY","La clave receptora no es una clave pública válida");}
 if(key.asymmetricKeyType!=="rsa"||(key.asymmetricKeyDetails?.modulusLength??0)<3072)throw new OperationError(400,"RECOVERY_RECIPIENT_KEY","La clave receptora debe ser RSA de al menos 3072 bits");
 const spki=Buffer.from(key.export({type:"spki",format:"der"}));
 return {spki,fingerprint:createHash("sha256").update(spki).digest("hex")};
}
function recordDetails(value:unknown):Record<string,unknown>{return value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{}}
recoveryRoutes.get("/recovery-config",async(req,res)=>{
 await requireCapability(db,req.user,"delivery.report");
 const publicKey=process.env.OFFLINE_QUEUE_RECOVERY_PUBLIC_KEY;
 const available=Boolean(publicKey&&process.env.OFFLINE_QUEUE_RECOVERY_PRIVATE_KEY);
 res.json({available,publicKey:available?publicKey:null,algorithm:"RSA-OAEP-256",scope:"queue_only"});
});
registerCommand("QueueRecoveryRequested",{kind:"queueRecovery",capability:"queue.recover",create:true,administrative:true,
 schema:z.strictObject({backupId:z.uuid(),reason:z.string().min(1).max(1000),recipientPublicKey:z.string().min(100).max(8000),evidence}),execute:async ctx=>{
 if(ctx.actor.role!=="owner")throw new OperationError(403,"RECOVERY_OWNER_REQUIRED","El propietario debe iniciar la recuperación");
 const backup=await ctx.tx.offlineBackup.findUniqueOrThrow({where:{id:ctx.envelope.data.backupId as string}});
 const packageData=backup.package as {keyring?:{queueRecoveryWrappedKey?:string}};
 if(!process.env.OFFLINE_QUEUE_RECOVERY_PRIVATE_KEY||!packageData.keyring?.queueRecoveryWrappedKey)throw new OperationError(423,"RECOVERY_UNAVAILABLE","La cola no tiene una clave recuperable; conservá el paquete cifrado");
 const recipient=parseRecipientPublicKey(ctx.envelope.data.recipientPublicKey as string);
 const recovery=await ctx.tx.offlineRecovery.create({data:{id:ctx.envelope.targetId,backupId:backup.id,ownerId:ctx.actor.id,reason:ctx.envelope.data.reason as string}});
 await ctx.tx.operationAudit.create({data:{actorId:ctx.actor.id,action:"queue.recovery_requested",objectId:recovery.id,requestId:ctx.envelope.requestId,details:json({recipientKeySpki:recipient.spki.toString("base64"),recipientKeyFingerprint:recipient.fingerprint})}});
 return {recovery,status:"independent_financial_review_required"};
}});
registerCommand("QueueRecoveryApproved",{kind:"queueRecovery",capability:"queue.recover",administrative:true,
 schema:z.strictObject({recipientKeyFingerprint:z.string().regex(/^[a-f0-9]{64}$/),evidence}),execute:async ctx=>{
 const r=await ctx.tx.offlineRecovery.findUniqueOrThrow({where:{id:ctx.envelope.targetId}});
 if(r.ownerId===ctx.actor.id||!(await capabilities(ctx.tx,ctx.actor)).includes("finance.read"))throw new OperationError(403,"RECOVERY_INDEPENDENT_FINANCE","Se requiere un revisor financiero distinto del propietario solicitante");
 if(r.status!=="requested")throw new OperationError(409,"RECOVERY_ALREADY_RESOLVED","La recuperación ya fue resuelta");
 const requested=await ctx.tx.operationAudit.findFirst({where:{objectId:r.id,action:"queue.recovery_requested"},orderBy:{createdAt:"asc"}});
 const requestedDetails=recordDetails(requested?.details);
 if(!requested||requested.actorId!==r.ownerId||requestedDetails.recipientKeyFingerprint!==ctx.envelope.data.recipientKeyFingerprint)throw new OperationError(422,"RECOVERY_RECIPIENT_MISMATCH","La aprobación debe confirmar la clave receptora fijada por el propietario");
 await ctx.tx.operationAudit.create({data:{actorId:ctx.actor.id,action:"queue.recovery_approved",objectId:r.id,requestId:ctx.envelope.requestId,details:json({recipientKeyFingerprint:requestedDetails.recipientKeyFingerprint})}});
 return {recovery:await ctx.tx.offlineRecovery.update({where:{id:r.id},data:{reviewerId:ctx.actor.id,status:"approved",approvedAt:ctx.now}}),effect:"key_recovery_only_events_remain_quarantined"};
}});
recoveryRoutes.post("/recoveries/:id/key",async(req,res)=>{
 await requireCapability(db,req.user,"queue.recover");
 z.strictObject({}).parse(req.body??{});
 const recoveryId=z.uuid().parse(req.params.id);
 let result:{wrappedQueueKey:string;backupId:string;fingerprint:string};
 try{
  result=await db.$transaction(async tx=>{
   await requireCapability(tx,req.user,"queue.recover");
   const r=await tx.offlineRecovery.findUniqueOrThrow({where:{id:recoveryId}});
   if(r.status!=="approved"||!r.reviewerId||r.reviewerId===r.ownerId){
    if(r.status==="released")throw new OperationError(409,"RECOVERY_ALREADY_RELEASED","La clave de esta recuperación ya fue entregada");
    throw new OperationError(409,"RECOVERY_NOT_APPROVED","La recuperación no está aprobada para una entrega");
   }
   if(![r.ownerId,r.reviewerId].includes(req.user.id))throw new OperationError(403,"RECOVERY_NOT_APPROVED","La entrega requiere la participación de los dos actores aprobados");
   const [owner,reviewer]=await Promise.all([tx.user.findUnique({where:{id:r.ownerId}}),tx.user.findUnique({where:{id:r.reviewerId}})]);
   if(!owner?.active||owner.role!=="owner"||!reviewer?.active||!(await capabilities(tx,reviewer)).includes("finance.read"))throw new OperationError(403,"RECOVERY_AUTHORITY_CHANGED","Las aprobaciones ya no están autorizadas");
   const [requested,approved,backup]=await Promise.all([
    tx.operationAudit.findFirst({where:{objectId:r.id,action:"queue.recovery_requested"},orderBy:{createdAt:"asc"}}),
    tx.operationAudit.findFirst({where:{objectId:r.id,action:"queue.recovery_approved"},orderBy:{createdAt:"asc"}}),
    tx.offlineBackup.findUniqueOrThrow({where:{id:r.backupId}}),
   ]);
   const requestDetails=recordDetails(requested?.details),approvalDetails=recordDetails(approved?.details);
   if(!requested||requested.actorId!==r.ownerId||!approved||approved.actorId!==r.reviewerId||requestDetails.recipientKeyFingerprint!==approvalDetails.recipientKeyFingerprint||typeof requestDetails.recipientKeySpki!=="string")throw new OperationError(422,"RECOVERY_RECIPIENT_MISMATCH","La clave receptora no coincide con la aprobada por los dos actores");
   let recipient:KeyObject;
   try{recipient=createPublicKey({key:Buffer.from(requestDetails.recipientKeySpki,"base64"),format:"der",type:"spki"});}catch{throw new OperationError(422,"RECOVERY_RECIPIENT_MISMATCH","La clave receptora registrada no es válida");}
   const recipientDer=Buffer.from(recipient.export({type:"spki",format:"der"}));
   const fingerprint=createHash("sha256").update(recipientDer).digest("hex");
   if(recipient.asymmetricKeyType!=="rsa"||(recipient.asymmetricKeyDetails?.modulusLength??0)<3072||fingerprint!==requestDetails.recipientKeyFingerprint)throw new OperationError(422,"RECOVERY_RECIPIENT_MISMATCH","La huella de la clave receptora registrada no coincide");
   const p=backup.package as {keyring?:{queueRecoveryWrappedKey?:string}};
   const privateKey=process.env.OFFLINE_QUEUE_RECOVERY_PRIVATE_KEY;
   if(!privateKey||!p.keyring?.queueRecoveryWrappedKey)throw new OperationError(423,"RECOVERY_UNAVAILABLE","La clave de cola no está disponible");
   let key:Buffer;
   try{key=privateDecrypt({key:privateKey,oaepHash:"sha256",padding:constants.RSA_PKCS1_OAEP_PADDING},Buffer.from(p.keyring.queueRecoveryWrappedKey,"base64"));}catch{throw new OperationError(422,"RECOVERY_KEY_INTEGRITY","No se pudo verificar la clave de cola de la copia");}
   if(key.length!==32){key.fill(0);throw new OperationError(422,"RECOVERY_KEY_INTEGRITY","La clave de cola es inválida");}
   try{
    const wrappedQueueKey=publicEncrypt({key:recipient,oaepHash:"sha256",padding:constants.RSA_PKCS1_OAEP_PADDING},key).toString("base64");
    const claimed=await tx.offlineRecovery.updateMany({where:{id:r.id,status:"approved"},data:{status:"released"}});
    if(claimed.count!==1)throw new OperationError(409,"RECOVERY_ALREADY_RELEASED","La clave de esta recuperación ya fue entregada");
    await tx.operationAudit.create({data:{actorId:req.user.id,action:"queue.key_recovered",objectId:r.id,details:json({backupId:backup.id,ownerId:r.ownerId,reviewerId:r.reviewerId,recipientKeyFingerprint:fingerprint,scope:"queue_only",releasedOnce:true})}});
    return {wrappedQueueKey,backupId:backup.id,fingerprint};
   }finally{key.fill(0);}
  },{isolationLevel:"Serializable"});
 }catch(error){
  if(error&&typeof error==="object"&&"code" in error&&error.code==="P2034"){
   const latest=await db.offlineRecovery.findUnique({where:{id:recoveryId},select:{status:true}});
   if(latest?.status==="released")throw new OperationError(409,"RECOVERY_ALREADY_RELEASED","La clave de esta recuperación ya fue entregada");
  }
  throw error;
 }
 res.json({algorithm:"RSA-OAEP-256",wrappedQueueKey:result.wrappedQueueKey,backupId:result.backupId,recipientKeyFingerprint:result.fingerprint,quarantineRequired:true});
});
registerCommand("QuarantineResolved",{kind:"quarantine",capability:"queue.recover",create:true,administrative:true,
 schema:z.strictObject({originalRequestId:z.uuid(),resolutionRequestId:z.uuid(),reason:z.string().min(1).max(1000),evidence}),execute:async ctx=>{
 const q=await ctx.tx.offlineQuarantine.findUniqueOrThrow({where:{requestId:ctx.envelope.data.originalRequestId as string}});
 const receipt=await ctx.tx.commandReceipt.findUnique({where:{requestId:ctx.envelope.data.resolutionRequestId as string}});
 if(!receipt)throw new OperationError(422,"NEW_AUTHORIZED_COMMAND_REQUIRED","La resolución requiere un recibo autorizado existente");
 const original=q.envelope as {schemaVersion?:unknown;requestId?:unknown;targetId?:unknown;expectedVersion?:unknown;occurredAt?:unknown;command?:unknown;data?:unknown};
 const alreadyCommitted=q.reason.endsWith(":ALREADY_COMMITTED");
 if(alreadyCommitted){
  if(receipt.requestId!==q.requestId||(ctx.envelope.data.resolutionRequestId as string)!==q.requestId)throw new OperationError(422,"NEW_AUTHORIZED_COMMAND_REQUIRED","Un evento ya confirmado solo se resuelve contra su recibo original, nunca con un UUID nuevo");
  if(receipt.actorId!==q.userId)throw new OperationError(403,"COMMAND_ACTOR_MISMATCH","El recibo original corresponde a otra autorización");
  if(receipt.targetId!==q.targetId||typeof original.command!=="string"||receipt.command!==original.command)throw new OperationError(422,"QUARANTINE_COMMAND","El recibo original no coincide con el hecho en cuarentena");
  const spec=commandSpecs.get(original.command);
  let matches=false;
  try{
   if(spec&&original.schemaVersion===1&&original.requestId===q.requestId&&original.targetId===q.targetId&&typeof original.expectedVersion==="number"&&typeof original.occurredAt==="string"){
    const normalized:CommandEnvelope={schemaVersion:1,requestId:q.requestId,targetId:q.targetId,command:original.command,data:spec.schema.parse(original.data),expectedVersion:original.expectedVersion,occurredAt:new Date(original.occurredAt).toISOString()};
    matches=receipt.bodyHash===canonicalCommandBodyHash(normalized);
   }
  }catch{matches=false;}
  if(!matches)throw new OperationError(422,"IDEMPOTENCY_KEY_REUSED","El recibo original no coincide con el contenido normalizado en cuarentena");
 }else{
  if(receipt.requestId===q.requestId)throw new OperationError(422,"NEW_AUTHORIZED_COMMAND_REQUIRED","La captura requiere un comando nuevo autorizado");
  if(receipt.committedAt<=q.createdAt)throw new OperationError(422,"NEW_AUTHORIZED_COMMAND_REQUIRED","El comando de resolución debe ser posterior a la cuarentena; un recibo anterior no resuelve esta captura");
  if(receipt.targetId!==q.targetId)throw new OperationError(422,"QUARANTINE_OBJECT","La resolución pertenece a otro objeto");
  if(typeof original.command!=="string"||receipt.command!==original.command)throw new OperationError(422,"QUARANTINE_COMMAND","La resolución debe registrar el mismo tipo de hecho con una autorización nueva");
 }
 if(q.resolutionRequestId)throw new OperationError(409,"QUARANTINE_ALREADY_RESOLVED","El evento ya tiene una resolución; su original permanece conservado");
 await ctx.tx.offlineQuarantine.update({where:{requestId:q.requestId},data:{resolvedBy:ctx.actor.id,resolutionRequestId:receipt.requestId}});
 return {requestId:q.requestId,status:"resolved",originalRetained:true,alreadyCommitted};
}});
