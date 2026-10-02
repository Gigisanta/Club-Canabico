import { mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { S3Client } from "@aws-sdk/client-s3";
import { OperationError } from "./core.js";
export interface StoredObject {key:string;version:string;checksum:string;bytes:number;mediaType:string}
const safeKey=(key:string)=>{if(!/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,250}$/.test(key)||key.includes(".."))throw new OperationError(400,"OBJECT_KEY","Identidad de archivo inválida");return key;};
const root=resolve(process.env.PRIVATE_OBJECT_ROOT??".local/private-objects");
const bucket=process.env.PRIVATE_S3_BUCKET;
let client:Promise<S3Client>|undefined;
async function s3(){if(!bucket)throw new OperationError(503,"OBJECT_STORAGE_UNCONFIGURED","Almacenamiento privado sin configurar");const endpoint=process.env.PRIVATE_S3_ENDPOINT;if(endpoint&&!endpoint.startsWith("https://")&&process.env.NODE_ENV!=="test")throw new OperationError(503,"OBJECT_STORAGE_HTTPS","El almacenamiento requiere HTTPS");return client??=import("@aws-sdk/client-s3").then(({S3Client})=>new S3Client({region:process.env.PRIVATE_S3_REGION??"us-east-1",endpoint,forcePathStyle:process.env.PRIVATE_S3_PATH_STYLE==="true"}));}
/** Content-addressed providers reveal the exact immutable version before a put. */
export function expectedPrivateObjectVersion(checksum:string):string|undefined{
 if(!/^[a-f0-9]{64}$/.test(checksum))throw new OperationError(400,"OBJECT_CHECKSUM","Checksum inválido");
 return process.env.PRIVATE_OBJECT_PROVIDER==="vercel-blob"||!bucket?checksum:undefined;
}
export async function putPrivateObject(key:string,body:Buffer,mediaType:string):Promise<StoredObject>{
 safeKey(key);const checksum=createHash("sha256").update(body).digest("hex");
 if(process.env.PRIVATE_OBJECT_PROVIDER==="vercel-blob"){
  const {put,get}=await import("@vercel/blob");
  // Content-addressed versions are append-only. A change creates a different pathname.
  const pathname=`versions/${key}/${checksum}`;
  try{await put(pathname,body,{access:"private",addRandomSuffix:false,allowOverwrite:false,contentType:mediaType});}
  catch(error){
   // A concurrent identical upload may already have created this version.
   const existing=await get(pathname,{access:"private"});
   if(!existing||existing.statusCode!==200)throw error;
   const bytes=Buffer.from(await new Response(existing.stream).arrayBuffer());
   if(createHash("sha256").update(bytes).digest("hex")!==checksum)throw new OperationError(409,"OBJECT_INTEGRITY","La versión existente no coincide con su contenido");
  }
  return {key,version:checksum,checksum,bytes:body.length,mediaType};
 }
 if(bucket){
  const {GetBucketVersioningCommand,GetObjectCommand,PutObjectCommand}=await import("@aws-sdk/client-s3");
  const client=await s3(),versioning=await client.send(new GetBucketVersioningCommand({Bucket:bucket}));
  if(versioning.Status!=="Enabled")throw new OperationError(503,"OBJECT_VERSIONING_REQUIRED","Habilitá el versionado en el bucket privado antes de escribir");
  const immutable=process.env.PRIVATE_OBJECT_IMMUTABLE_WRITES==="true";
  const kmsKeyArn=process.env.PRIVATE_S3_KMS_KEY_ARN;
  let result;
  try{
   result=await client.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:body,ContentType:mediaType,ChecksumSHA256:Buffer.from(checksum,"hex").toString("base64"),ServerSideEncryption:kmsKeyArn?"aws:kms":"AES256",...(kmsKeyArn?{SSEKMSKeyId:kmsKeyArn}:{}),...(immutable?{IfNoneMatch:"*"}:{})}));
  }catch(error){
   const conflict=immutable&&((error as {$metadata?:{httpStatusCode?:number};name?:string}).$metadata?.httpStatusCode===412||(error as {name?:string}).name==="PreconditionFailed");
   if(!conflict)throw error;
   const existing=await client.send(new GetObjectCommand({Bucket:bucket,Key:key}));
   if(!existing.Body||!existing.VersionId||existing.VersionId==="null")throw new OperationError(503,"OBJECT_VERSIONING_REQUIRED","El bucket debe devolver una versión inmutable del archivo");
   const bytes=Buffer.from(await existing.Body.transformToByteArray());
   if(bytes.length!==body.length||createHash("sha256").update(bytes).digest("hex")!==checksum)throw new OperationError(409,"OBJECT_IMMUTABLE_CONFLICT","La clave inmutable ya contiene otro archivo");
   return {key,version:existing.VersionId,checksum,bytes:body.length,mediaType};
  }
  if(!result.VersionId||result.VersionId==="null")throw new OperationError(503,"OBJECT_VERSIONING_REQUIRED","El bucket debe devolver una versión inmutable del archivo");
  return {key,version:result.VersionId,checksum,bytes:body.length,mediaType};
 }
 if(process.env.NODE_ENV==="production")throw new OperationError(503,"OBJECT_STORAGE_UNCONFIGURED","Producción requiere almacenamiento privado con versiones");
 const version=checksum;const path=resolve(root,key,version);await mkdir(dirname(path),{recursive:true,mode:0o700});
 const parent=await realpath(dirname(path));if(!parent.startsWith((await realpath(root))+"/"))throw new OperationError(400,"OBJECT_PATH","Ruta fuera de almacenamiento privado");
 try{const f=await open(path,"wx",0o600);try{await f.writeFile(body);await f.sync();}finally{await f.close();}}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;const existing=await readFile(path);if(createHash("sha256").update(existing).digest("hex")!==checksum)throw new OperationError(409,"OBJECT_INTEGRITY","Archivo existente corrupto");}
 return {key,version,checksum,bytes:body.length,mediaType};
}
export async function getPrivateObject(key:string,version:string,checksum:string){
 safeKey(key);if(!version||version==="null")throw new OperationError(400,"OBJECT_VERSION","Versión inválida");let body:Buffer;
 if(process.env.PRIVATE_OBJECT_PROVIDER==="vercel-blob"){
  if(!/^[a-f0-9]{64}$/.test(version)||version!==checksum)throw new OperationError(400,"OBJECT_VERSION","Versión de contenido inválida");
  const {get}=await import("@vercel/blob");const result=await get(`versions/${key}/${version}`,{access:"private"});
  if(!result||result.statusCode!==200)throw new OperationError(404,"OBJECT_NOT_FOUND","Archivo no disponible");
  body=Buffer.from(await new Response(result.stream).arrayBuffer());
 }
 else if(bucket){const {GetObjectCommand}=await import("@aws-sdk/client-s3");const result=await (await s3()).send(new GetObjectCommand({Bucket:bucket,Key:key,VersionId:version}));if(result.VersionId==="null")throw new OperationError(400,"OBJECT_VERSION","Versión inválida");if(!result.Body)throw new OperationError(404,"OBJECT_NOT_FOUND","Archivo no disponible");body=Buffer.from(await result.Body.transformToByteArray());}
 else{if(!/^[a-f0-9]{64}$/.test(version))throw new OperationError(400,"OBJECT_VERSION","Versión inválida");const path=resolve(root,key,version),actual=await realpath(path);if(!actual.startsWith((await realpath(root))+"/"))throw new OperationError(400,"OBJECT_PATH","Archivo fuera de almacenamiento");if(!(await stat(actual)).isFile())throw new OperationError(404,"OBJECT_NOT_FOUND","Archivo no disponible");body=await readFile(actual);}
 if(createHash("sha256").update(body).digest("hex")!==checksum)throw new OperationError(409,"OBJECT_INTEGRITY","No coincide el checksum del archivo");return body;
}
/** Delete only one immutable private object version; never issue an unversioned S3 delete. */
export async function deletePrivateObjectVersion(key:string,version:string):Promise<void>{
 safeKey(key);
 if(!version||version==="null"||version.length>1000)throw new OperationError(400,"OBJECT_VERSION","Versión inválida");
 if(process.env.PRIVATE_OBJECT_PROVIDER==="vercel-blob"){
  if(!/^[a-f0-9]{64}$/.test(version))throw new OperationError(400,"OBJECT_VERSION","Versión de contenido inválida");
  const {del}=await import("@vercel/blob");
  await del(`versions/${key}/${version}`);
  return;
 }
 if(bucket){
  const {DeleteObjectCommand}=await import("@aws-sdk/client-s3");
  await (await s3()).send(new DeleteObjectCommand({Bucket:bucket,Key:key,VersionId:version}));
  return;
 }
 if(!/^[a-f0-9]{64}$/.test(version))throw new OperationError(400,"OBJECT_VERSION","Versión de contenido inválida");
 const path=resolve(root,key,version),rootPath=await realpath(root).catch(error=>{
  if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;
  throw error;
 });
 if(!rootPath)return;
 try{
  const actual=await realpath(path);
  if(!actual.startsWith(rootPath+"/"))throw new OperationError(400,"OBJECT_PATH","Archivo fuera de almacenamiento");
  if(!(await stat(actual)).isFile())throw new OperationError(404,"OBJECT_NOT_FOUND","Archivo no disponible");
  const {unlink}=await import("node:fs/promises");
  await unlink(actual);
 }catch(error){
  if((error as NodeJS.ErrnoException).code==="ENOENT")return;
  throw error;
 }
}
