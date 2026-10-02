import { Router } from "express";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../../shared/operations/exact.js";
import type { CommandContext } from "./core.js";
import { db } from "../db.js";
import { registerCommand, requireCapability, OperationError, json, objectId, evidence, civilDate, objectScope, requireDocumentScope } from "./core.js";
import { authorizeDocument } from "./access.js";
import { putPrivateObject, getPrivateObject, expectedPrivateObjectVersion, type StoredObject } from "./object-store.js";
registerCommand("DocumentReferenced",{kind:"document",capability:"documents.write",create:true,administrative:true,
 schema:z.strictObject({memberId:objectId.optional(),orderId:objectId.optional(),deliveryId:objectId.optional(),kind:z.string().min(1).max(80),sensitivity:z.enum(["commercial","clinical","transport"]),validUntil:civilDate.optional(),metadata:z.record(z.string(),z.unknown()).default({})}),execute:async ctx=>{
 if(!z.uuid().safeParse(ctx.envelope.targetId).success)throw new OperationError(400,"DOCUMENT_UUID_REQUIRED","El documento requiere UUID");
 if(ctx.envelope.data.sensitivity==="clinical")await requireCapability(ctx.tx,ctx.actor,"clinical.review");
 return {document:await ctx.tx.operationDocument.create({data:{id:ctx.envelope.targetId,...ctx.envelope.data as {kind:string;sensitivity:string},metadata:json(ctx.envelope.data.metadata),createdBy:ctx.actor.id}})};
}});
registerCommand("DocumentAuthorized",{kind:"document",capability:"documents.write",administrative:true,
 schema:z.strictObject({userId:objectId,deliveryId:objectId.optional(),expiresAt:z.iso.datetime({offset:true}),evidence}),execute:async ctx=>{
 const doc=await ctx.tx.operationDocument.findUniqueOrThrow({where:{id:ctx.envelope.targetId}});
 if(doc.sensitivity==="clinical")await requireCapability(ctx.tx,ctx.actor,"clinical.review");
 const user=await ctx.tx.user.findUnique({where:{id:ctx.envelope.data.userId as string}});if(!user?.active)throw new OperationError(422,"DOCUMENT_USER","Destinatario no habilitado");
 const expires=new Date(ctx.envelope.data.expiresAt as string);if(expires<=ctx.now||expires>new Date(ctx.now.getTime()+12*3600000))throw new OperationError(422,"DOCUMENT_GRANT_DATES","Autorización de hasta doce horas");
 if(ctx.envelope.data.deliveryId){const d=await ctx.tx.deliveryAssignment.findUnique({where:{id:ctx.envelope.data.deliveryId as string}});if(doc.sensitivity==="clinical"||!d||d.driverId!==user.id||doc.deliveryId!==d.id)throw new OperationError(422,"DOCUMENT_DELIVERY_SCOPE","Sólo documentos de la entrega asignada");}
 const auth=await ctx.tx.documentAuthorization.upsert({where:{documentId_userId:{documentId:doc.id,userId:user.id}},create:{documentId:doc.id,userId:user.id,deliveryId:ctx.envelope.data.deliveryId as string|undefined,expiresAt:expires,grantedBy:ctx.actor.id},update:{deliveryId:ctx.envelope.data.deliveryId as string|undefined,expiresAt:expires,grantedBy:ctx.actor.id}});
 return {authorization:auth};
}});
registerCommand("DocumentTemplateProposed",{kind:"template",capability:"documents.write",create:true,administrative:true,
 schema:z.strictObject({version:z.number().int().positive(),kind:z.enum(["transport","member_contract","credential"]),definition:z.record(z.string(),z.unknown())}),execute:async ctx=>({template:await ctx.tx.documentTemplate.create({data:{id:ctx.envelope.targetId,version:ctx.envelope.data.version as number,kind:ctx.envelope.data.kind as string,definition:json(ctx.envelope.data.definition)}})})});
registerCommand("DocumentTemplateApproved",{kind:"template",capability:"prices.approve",administrative:true,schema:z.strictObject({evidence}),execute:async ctx=>{const template=await ctx.tx.documentTemplate.findUniqueOrThrow({where:{id:ctx.envelope.targetId}});if(template.approvedAt)throw new OperationError(409,"TEMPLATE_FROZEN","Publicá una versión nueva para modificar una plantilla aprobada");return {template:await ctx.tx.documentTemplate.update({where:{id:template.id},data:{approvedBy:ctx.actor.id,approvedAt:ctx.now}})};}});
export const documentRoutes=Router();
// Upload is a reviewed object write; availability is a canonical command after immutable bytes exist.
const upload=z.strictObject({contentBase64:z.string().min(1).max(4_000_000),mediaType:z.enum(["application/pdf","image/png","image/jpeg"]),checksum:z.string().regex(/^[a-f0-9]{64}$/)});
registerCommand("DocumentMadeAvailable",{kind:"document",capability:"documents.write",administrative:true,schema:z.strictObject({key:z.string().min(1).max(250),version:z.string().min(1).max(1000),checksum:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().min(1).max(3_000_000),mediaType:z.enum(["application/pdf","image/png","image/jpeg"])}),prepare:async ctx=>{
 const v=ctx.envelope.data as {key:string;version:string;checksum:string;bytes:number;mediaType:string};
 const d=await ctx.tx.operationDocument.findUniqueOrThrow({where:{id:ctx.envelope.targetId}});
 if(d.state==="available")throw new OperationError(409,"DOCUMENT_VERSION_FROZEN","El archivo disponible queda conservado");
 if(!v.key.startsWith(`documents/${d.id}/`))throw new OperationError(422,"DOCUMENT_OBJECT_BINDING","El archivo corresponde a otro documento");
 const body=await getPrivateObject(v.key,v.version,v.checksum);
 if(body.length!==v.bytes)throw new OperationError(422,"DOCUMENT_BYTES","Tamaño de archivo distinto");
 const magic=v.mediaType==="application/pdf"?body.subarray(0,5).toString()==="%PDF-":v.mediaType==="image/png"?body.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):body[0]===255&&body[1]===216;
 if(!magic)throw new OperationError(422,"DOCUMENT_INTEGRITY","El contenido no corresponde al tipo de archivo declarado");
 return {key:v.key,version:v.version,checksum:v.checksum,bytes:body.length};
 },execute:async ctx=>{
 const d=await ctx.tx.operationDocument.findUniqueOrThrow({where:{id:ctx.envelope.targetId}});if(d.sensitivity==="clinical")await requireCapability(ctx.tx,ctx.actor,"clinical.review");
 if(d.state==="available")throw new OperationError(409,"DOCUMENT_VERSION_FROZEN","Conservá el archivo disponible y referenciá una nueva versión con otra identidad");
 const v=ctx.envelope.data as {key:string;version:string;checksum:string;bytes:number;mediaType:string};
 if(!v.key.startsWith(`documents/${d.id}/`))throw new OperationError(422,"DOCUMENT_OBJECT_BINDING","El archivo corresponde a otro documento");
 const prepared=ctx.prepared as {key:string;version:string;checksum:string;bytes:number}|undefined;
 if(!prepared||prepared.key!==v.key||prepared.version!==v.version||prepared.checksum!==v.checksum||prepared.bytes!==v.bytes)throw new OperationError(422,"DOCUMENT_PREPARATION_REQUIRED","El archivo requiere verificación antes de registrar disponibilidad");
 const intents=await ctx.tx.$queryRaw<Array<{id:string;status:string;payload:unknown}>>`SELECT "id","status","payload" FROM "OperationOutbox" WHERE "topic"='document.asset-intent' AND "payload"->>'documentId'=${d.id} AND "payload"->>'key'=${v.key} FOR UPDATE`;
 const intent=intents[0],payload=intent?.payload as {stored?:StoredObject}|undefined;
 if(intents.length!==1||intent.status!=="asset-ready"||payload?.stored?.version!==v.version||payload.stored.checksum!==v.checksum||payload.stored.bytes!==v.bytes||payload.stored.mediaType!==v.mediaType)throw new OperationError(409,"DOCUMENT_ASSET_UNAVAILABLE","El archivo requiere una carga durable y no puede estar en limpieza o revisión");
 const document=await ctx.tx.operationDocument.update({where:{id:d.id},data:{state:"available",objectKey:v.key,objectVersion:v.version,checksum:v.checksum,bytes:v.bytes,mediaType:v.mediaType}});
 await ctx.tx.operationOutbox.update({where:{id:intent.id},data:{status:"processed",processedAt:ctx.now}});
 return {document};
}});
documentRoutes.post("/:id/upload",async(req,res)=>{
 await requireCapability(db,req.user,"documents.write");const id=z.uuid().parse(req.params.id);const doc=await authorizeDocument({tx:db,actor:req.user,now:new Date()},id);
 if(doc.sensitivity==="clinical")await requireCapability(db,req.user,"clinical.review");
 if(doc.state==="available")throw new OperationError(409,"DOCUMENT_VERSION_FROZEN","Referenciá otra identidad para cargar una nueva versión; el archivo disponible queda conservado");
 const v=upload.parse(req.body),body=Buffer.from(v.contentBase64,"base64");if(body.length<1||body.length>3_000_000||body.toString("base64")!==v.contentBase64)throw new OperationError(400,"DOCUMENT_ENCODING","Archivo inválido o demasiado grande");
 const magic=v.mediaType==="application/pdf"?body.subarray(0,5).toString()==="%PDF-":v.mediaType==="image/png"?body.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):body[0]===255&&body[1]===216;
 if(!magic||createHash("sha256").update(body).digest("hex")!==v.checksum)throw new OperationError(422,"DOCUMENT_INTEGRITY","Tipo o checksum de archivo inválido");
 const asset=await stagePrivateDocumentAsset({documentId:id,requestId:randomUUID(),body,mediaType:v.mediaType,sourceHash:v.checksum});
 res.json(asset.stored);
});
documentRoutes.get("/:id/content",async(req,res)=>{
 const doc=await authorizeDocument({tx:db,actor:req.user,now:new Date()},z.uuid().parse(req.params.id));
 if(doc.state!=="available"||!doc.objectKey||!doc.objectVersion||!doc.checksum)throw new OperationError(404,"DOCUMENT_NOT_AVAILABLE","La referencia no acredita archivo disponible");
 const body=await getPrivateObject(doc.objectKey,doc.objectVersion,doc.checksum);
 await db.operationAudit.create({data:{actorId:req.user.id,action:"document.read",objectId:doc.id,details:{version:doc.objectVersion}}});
 res.set({"Cache-Control":"no-store","Content-Type":doc.mediaType??"application/octet-stream","Content-Disposition":`attachment; filename="bombo-${doc.id}.${doc.mediaType==="application/pdf"?"pdf":"bin"}"`,"X-Content-Type-Options":"nosniff"});res.send(body);
});
documentRoutes.get("/",async(req,res)=>{
 await requireCapability(db,req.user,"documents.read");const clinical=(await import("./core.js")).capabilities;const caps=await clinical(db,req.user);
 const scope=await objectScope(db,req.user);
 const orders=scope.memberIds?await db.operationOrder.findMany({where:{memberId:{in:scope.memberIds}},select:{id:true}}):null;
 const deliveries=orders?await db.deliveryAssignment.findMany({where:{orderId:{in:orders.map(o=>o.id)}},select:{id:true}}):null;
 const docs=await db.operationDocument.findMany({where:{...(caps.includes("clinical.read")?{}:{sensitivity:{not:"clinical"}}),...(scope.memberIds?{OR:[{memberId:{in:scope.memberIds}},{orderId:{in:orders!.map(o=>o.id)}},{deliveryId:{in:deliveries!.map(d=>d.id)}}]}:{})},take:200,select:{id:true,memberId:true,orderId:true,deliveryId:true,kind:true,sensitivity:true,state:true,checksum:true,validUntil:true,templateId:true,templateVersion:true}});
 const items=[];for(const doc of docs){try{await requireDocumentScope(db,req.user,doc);items.push(doc);}catch(error){if(!(error instanceof OperationError&&error.status===403))throw error;}}
 res.json({items});
});
type TransportInput={orderId:string;deliveryId:string;templateId:string;transportistName:string;vehiclePlate:string;origin:string;destination:string;evidence:Record<string,unknown>};
async function transportSnapshot(ctx:CommandContext){
 const v=ctx.envelope.data as TransportInput;
 if(!z.uuid().safeParse(ctx.envelope.targetId).success)throw new OperationError(400,"DOCUMENT_UUID_REQUIRED","El documento requiere UUID");
 const [template,order,delivery]=await Promise.all([ctx.tx.documentTemplate.findUnique({where:{id:v.templateId}}),ctx.tx.operationOrder.findUnique({where:{id:v.orderId}}),ctx.tx.deliveryAssignment.findUnique({where:{id:v.deliveryId}})]);
 if(!template?.approvedAt||template.kind!=="transport")throw new OperationError(423,"TRANSPORT_TEMPLATE_PENDING","Se requiere plantilla de transporte validada y aprobada");
 if(!order||delivery?.orderId!==order.id||!delivery.driverId)throw new OperationError(422,"TRANSPORT_DELIVERY","Pedido y transportista deben estar asignados");
 const allocations=await ctx.tx.preparationAllocation.findMany({where:{orderId:order.id,state:{in:["prepared","dispatched"]}},orderBy:{id:"asc"}});
 if(!allocations.length)throw new OperationError(422,"TRANSPORT_PREPARATION","El documento requiere cantidades físicas preparadas");
 const definition=template.definition as {title?:string;footer?:string;requiredFields?:string[]};
 if(!definition.requiredFields?.length)throw new OperationError(423,"TRANSPORT_REQUIREMENTS_PENDING","La plantilla necesita requisitos documentales validados");
 const member=await ctx.tx.operationMember.findUniqueOrThrow({where:{id:order.memberId}});
 const date=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Argentina/Buenos_Aires"}).format(ctx.now);
 const permission=await ctx.tx.memberPermission.findFirst({where:{memberId:member.id,kind:"operations",status:"verified",validFrom:{lte:date},validUntil:{gte:date}},orderBy:[{validUntil:"desc"},{id:"asc"}]});
 if(!permission)throw new OperationError(423,"TRANSPORT_PERMISSION","El permiso operativo no está vigente");
 const lots=await ctx.tx.inventoryLot.findMany({where:{id:{in:[...new Set(allocations.map(a=>a.lotId))]}},include:{sku:true}}),lotById=new Map(lots.map(l=>[l.id,l]));
 const items=allocations.map(a=>{const lot=lotById.get(a.lotId);if(!lot)throw new OperationError(409,"TRANSPORT_LOT_PENDING","Falta la trazabilidad física del lote");return {allocationId:a.id,lineId:a.lineId,lotId:a.lotId,name:lot.sku.name,label:lot.label,unit:lot.unit,quantity:a.actualQuantity.toString(),state:a.state};});
 const fields={...v,memberName:member.name,permissionId:permission.id,driverId:delivery.driverId,physicalItems:items.map(a=>({lineId:a.lineId,lotId:a.lotId,quantity:a.quantity})),templateVersion:template.version};
 const missing=definition.requiredFields.filter(f=>f!=="generatedAt"&&((fields as Record<string,unknown>)[f]===undefined||(fields as Record<string,unknown>)[f]===null||(fields as Record<string,unknown>)[f]===""));if(missing.length)throw new OperationError(423,"TRANSPORT_FIELDS_PENDING","Faltan datos exigidos por la plantilla",{missing});
 const snapshot={fields,items,definition,templateId:template.id,templateVersion:template.version,templateApprovedBy:template.approvedBy,templateApprovedAt:template.approvedAt.toISOString(),memberId:member.id,orderId:order.id,deliveryId:delivery.id,validUntil:permission.validUntil};
 return {snapshot,fingerprint:createHash("sha256").update(canonicalJson(snapshot)).digest("hex")};
}
async function prepareTransportDocument(ctx:CommandContext){
 const source=await db.$transaction(tx=>transportSnapshot({...ctx,tx}),{isolationLevel:"RepeatableRead",timeout:15000});
 const {snapshot}=source,v=ctx.envelope.data as TransportInput,generatedAt=ctx.now.toISOString();
 const {default:PDFDocument}=await import("pdfkit");const pdf=new PDFDocument({size:"A4",margin:50});
 const chunks:Buffer[]=[];const complete=new Promise<Buffer>((resolve,reject)=>{pdf.on("data",c=>chunks.push(Buffer.from(c)));pdf.on("end",()=>resolve(Buffer.concat(chunks)));pdf.on("error",reject);});
 pdf.fontSize(18).text(snapshot.definition.title??"Documento operativo de transporte");pdf.moveDown().fontSize(10);
 for(const [label,value] of [["Pedido",snapshot.orderId],["Socio",snapshot.fields.memberName],["Transportista",v.transportistName],["Vehículo",v.vehiclePlate],["Origen",v.origin],["Destino",v.destination],["Plantilla",`${snapshot.templateId} · versión ${snapshot.templateVersion}`],["Emitido",generatedAt]])pdf.text(`${label}: ${value}`);
 pdf.moveDown().text("Cantidades físicas preparadas:");
 for(const item of snapshot.items)pdf.text(`${item.name} · lote ${item.label} (${item.lotId}) · ${item.quantity} ${item.unit}`);
 if(snapshot.definition.footer)pdf.moveDown().text(snapshot.definition.footer);pdf.end();const body=await complete;
 if(body.length>3_000_000)throw new OperationError(413,"TRANSPORT_DOCUMENT_LIMIT","El documento excede el límite autorizado");
 const asset=await stagePrivateDocumentAsset({documentId:ctx.envelope.targetId,requestId:ctx.envelope.requestId,body,mediaType:"application/pdf",sourceHash:source.fingerprint});
 return {...asset,sourceHash:source.fingerprint,fields:{...snapshot.fields,generatedAt}};
}
/** All private document writes leave a durable intent before object-store I/O. */
export async function stagePrivateDocumentAsset(input:{documentId:string;requestId:string;body:Buffer;mediaType:"application/pdf"|"image/png"|"image/jpeg";sourceHash:string}){
 const {documentId,requestId,body,mediaType,sourceHash}=input;
 const key=`documents/${documentId}/${randomUUID()}`,checksum=createHash("sha256").update(body).digest("hex"),intentId=randomUUID();
 const expectedVersion=expectedPrivateObjectVersion(checksum);
 const payload={version:1,requestId,documentId,key,checksum,bytes:body.length,mediaType,sourceHash,...(expectedVersion?{expectedVersion}:{})};
 await db.operationOutbox.create({data:{id:intentId,requestId,topic:"document.asset-intent",payload:json(payload),status:"asset-preparing"}});
 const stored=await putPrivateObject(key,body,mediaType);
 if(stored.key!==key||stored.checksum!==checksum||stored.bytes!==body.length||stored.mediaType!==mediaType||(expectedVersion&&stored.version!==expectedVersion))throw new OperationError(409,"TRANSPORT_OBJECT_IDENTITY","El almacenamiento devolvió una identidad de archivo distinta");
 await db.$transaction(async tx=>{
  const rows=await tx.$queryRaw<Array<{id:string;requestId:string;topic:string;status:string;payload:unknown}>>`SELECT "id","requestId","topic","status","payload" FROM "OperationOutbox" WHERE "id"=${intentId}::uuid FOR UPDATE`;
  const row=rows[0],current=row?.payload as Record<string,unknown>|undefined;
  if(!row||row.requestId!==requestId||row.topic!=="document.asset-intent"||!current||current.documentId!==documentId||current.key!==key||current.checksum!==checksum||current.sourceHash!==sourceHash)throw new OperationError(409,"TRANSPORT_ASSET_INTENT","No se pudo validar la intención durable del documento");
  const referenced=await tx.operationDocument.findUnique({where:{id:documentId},select:{objectKey:true,objectVersion:true}});
  const isReferenced=referenced?.objectKey===key&&referenced.objectVersion===stored.version;
  const status=isReferenced?"processed":row.status==="asset-preparing"||row.status==="asset-ready"?"asset-ready":"asset-cleaning";
  const updated:Record<string,unknown>={...current,stored};delete updated.cleanupClaimToken;delete updated.cleanupClaimedAt;delete updated.cleanupError;delete updated.reviewReason;
  await tx.operationOutbox.update({where:{id:intentId},data:{status,payload:json(updated),...(status==="processed"?{processedAt:new Date()}:{})}});
 },{timeout:15000});
 return {stored,intentId};
}
registerCommand("TransportDocumentGenerated",{kind:"document",capability:"documents.write",create:true,
 schema:z.strictObject({orderId:objectId,deliveryId:z.uuid(),templateId:objectId,transportistName:z.string().min(1).max(200),vehiclePlate:z.string().min(1).max(80),origin:z.string().min(1).max(1000),destination:z.string().min(1).max(1000),evidence}),
 prepare:prepareTransportDocument,execute:async ctx=>{
 const current=await transportSnapshot(ctx),prepared=ctx.prepared as {sourceHash:string;stored:StoredObject;fields:Record<string,unknown>;intentId:string}|undefined;
 if(!prepared||prepared.sourceHash!==current.fingerprint)throw new OperationError(409,"TRANSPORT_PREPARATION_CHANGED","Cambió la preparación, asignación o plantilla; revisá el documento antes de emitirlo");
 const {snapshot}=current,{stored}=prepared;
 const intentRows=await ctx.tx.$queryRaw<Array<{requestId:string;topic:string;status:string;payload:unknown}>>`SELECT "requestId","topic","status","payload" FROM "OperationOutbox" WHERE "id"=${prepared.intentId}::uuid FOR UPDATE`;
 const intent=intentRows[0],payload=intent?.payload as Record<string,unknown>|undefined,storedIntent=payload?.stored as Record<string,unknown>|undefined;
 if(!intent||intent.requestId!==ctx.envelope.requestId||intent.topic!=="document.asset-intent"||intent.status!=="asset-ready"||payload?.documentId!==ctx.envelope.targetId||payload?.key!==stored.key||payload?.sourceHash!==prepared.sourceHash||storedIntent?.version!==stored.version||storedIntent.checksum!==stored.checksum||storedIntent.bytes!==stored.bytes)throw new OperationError(409,"TRANSPORT_ASSET_UNAVAILABLE","El PDF preparado está en limpieza o requiere revisión; no se puede registrar como disponible");
 const document=await ctx.tx.operationDocument.create({data:{id:ctx.envelope.targetId,memberId:snapshot.memberId,orderId:snapshot.orderId,deliveryId:snapshot.deliveryId,kind:"transport",sensitivity:"transport",state:"available",objectKey:stored.key,objectVersion:stored.version,checksum:stored.checksum,bytes:stored.bytes,mediaType:stored.mediaType,templateId:snapshot.templateId,templateVersion:snapshot.templateVersion,validUntil:snapshot.validUntil,metadata:json(prepared.fields),createdBy:ctx.actor.id}});
 await ctx.tx.operationOutbox.update({where:{id:prepared.intentId},data:{status:"processed",processedAt:ctx.now}});
 return {document};
}});
