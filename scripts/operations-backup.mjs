#!/usr/bin/env node
// Coordinated database + immutable object snapshot. Never takes a shell command or logs credentials.
import { PrismaClient } from "@prisma/client";
import { spawn } from "node:child_process";
import { createHash, createHmac, timingSafeEqual, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { storeDumpStream, verifyDumpStream } from "./backup-streams.mjs";
import { authorizeRestoreDestination, authorizeRestoreObjectBucket, requireEmptyRestoreDatabase, safeRestoreObjectKmsKeyArn } from "./backup-restore-policy.mjs";
import { findReusableObject, indexReusableObjects, objectReuseIdentity, planBackupDocumentObjects, verifyObjectReuseIndex } from "./backup-object-reuse.mjs";
import { S3Client } from "@aws-sdk/client-s3";
import { backupKeyId, requireEmptyVersionedBucket } from "./backup-cloud-store.mjs";

const args=process.argv.slice(2),mode=args[0],directory=resolve(args[1]??"");
if(!["backup","restore","verify"].includes(mode)||!args[1])throw new Error("Uso: operations-backup.mjs backup|restore|verify /ruta/privada");
const raw=mode==="restore"?process.env.RESTORE_DATABASE_URL:process.env.DATABASE_URL;
if(!raw&&mode!=="verify")throw new Error("Falta la conexión correspondiente al modo solicitado");
const url=raw?new URL(raw):null;
if(url&&!['postgresql:','postgres:'].includes(url.protocol))throw new Error("La conexión debe ser PostgreSQL");
const keyText=process.env.BACKUP_ENCRYPTION_KEY;
if(keyText&&!/^[a-f0-9]{64}$/i.test(keyText))throw new Error("La clave de respaldo debe contener 32 bytes hexadecimales");
const key=keyText?Buffer.from(keyText,"hex"):null;
if(mode==="backup"&&process.env.NODE_ENV==="production"&&!key)throw new Error("El respaldo de producción requiere cifrado");
process.umask(0o077);
const restoreTarget=mode==="restore"?authorizeRestoreDestination(raw,process.env):null;
if(url&&restoreTarget)url.pathname=`/${restoreTarget.database}`;
const db=url?new PrismaClient({datasources:{db:{url:url.toString()}}}):null;
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
function databaseTarget(url){
 const hostname=url.hostname.toLowerCase().replace(/^\[|\]$/g,"");
 const host=hostname==="localhost"||hostname==="::1"||hostname.startsWith("127.")?"loopback":hostname;
 const port=url.port||"5432",database=decodeURIComponent(url.pathname.slice(1)),schema=url.searchParams.get("schema")||"public";
 if(!database||!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(schema))throw new Error("El destino de base o esquema no es válido");
 const fingerprint=hash(Buffer.from(JSON.stringify({host,port,database,schema}),"utf8"));
 return {host,port,database,schema,fingerprint};
}
async function requireConnectedTarget(queryable,target){
 const [session]=await queryable.$queryRawUnsafe("SELECT current_database() AS database, current_schema() AS schema");
 if(session?.database!==target.database||session?.schema!==target.schema)throw new Error("La conexión PostgreSQL efectiva no coincide con el destino declarado");
}
const files=[];
function within(parent,child){const rel=relative(parent,child);return rel===""||rel!==".."&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel);}
function pathsOverlap(left,right){return within(left,right)||within(right,left);}
async function canonicalPath(path){
 let current=resolve(path);const suffix=[];
 for(;;){try{return resolve(await realpath(current),...suffix.reverse());}catch(error){if(error.code!=="ENOENT")throw error;const parent=dirname(current);if(parent===current)throw error;suffix.push(basename(current));current=parent;}}
}
async function validateRestoreObjectRoot(backupDirectory){
 const configured=process.env.RESTORE_PRIVATE_OBJECT_ROOT;
 if(!configured||!isAbsolute(configured))throw new Error("RESTORE_PRIVATE_OBJECT_ROOT debe ser una ruta local absoluta");
 const root=resolve(configured);let info;
 try{info=await lstat(root);}catch(error){if(error.code!=="ENOENT")throw error;}
 if(info?.isSymbolicLink())throw new Error("RESTORE_PRIVATE_OBJECT_ROOT no puede ser un enlace simbólico");
 if(info&&!info.isDirectory())throw new Error("RESTORE_PRIVATE_OBJECT_ROOT debe ser un directorio vacío");
 const source=resolve(process.env.PRIVATE_OBJECT_ROOT??".local/private-objects");
 const [canonicalRoot,canonicalSource,canonicalBackup]=await Promise.all([canonicalPath(root),canonicalPath(source),canonicalPath(backupDirectory)]);
 if(pathsOverlap(root,source)||pathsOverlap(root,backupDirectory)||pathsOverlap(canonicalRoot,canonicalSource)||pathsOverlap(canonicalRoot,canonicalBackup))
  throw new Error("RESTORE_PRIVATE_OBJECT_ROOT debe estar separado del almacenamiento normal y fuera del backup");
 if(info&&(await readdir(root)).length>0)throw new Error("RESTORE_PRIVATE_OBJECT_ROOT debe estar vacío");
 return root;
}
async function storeFile(name,bytes){
 let stored=bytes,iv,tag;
 if(key){iv=randomBytes(12);const cipher=createCipheriv("aes-256-gcm",key,iv);cipher.setAAD(Buffer.from(name));stored=Buffer.concat([cipher.update(bytes),cipher.final()]);tag=cipher.getAuthTag();}
 await writeFile(join(directory,name),stored,{flag:"wx",mode:0o600});
 return {name,bytes:bytes.length,sha256:hash(bytes),storedSha256:hash(stored),...(iv?{encryption:{algorithm:"AES-256-GCM",iv:iv.toString("base64"),tag:tag.toString("base64")}}:{})};
}
async function readStored(manifest,entry){
 if(!entry||!/^(database\.dump|objects\/\d+\.bin)$/.test(entry.name))throw new Error("Nombre de archivo de respaldo inválido");
 const bytes=await readFile(join(directory,entry.name));if(hash(bytes)!==entry.storedSha256)throw new Error("Checksum almacenado inválido");
 let plain=bytes;
 if(entry.encryption){if(!key)throw new Error("El paquete requiere su clave de respaldo");const decipher=createDecipheriv("aes-256-gcm",key,Buffer.from(entry.encryption.iv,"base64"));decipher.setAAD(Buffer.from(entry.name));decipher.setAuthTag(Buffer.from(entry.encryption.tag,"base64"));plain=Buffer.concat([decipher.update(bytes),decipher.final()]);}
 if(hash(plain)!==entry.sha256||plain.length!==entry.bytes)throw new Error("Integridad del contenido inválida");return plain;
}
function pg(tool,argv,connectionUrl=url){
 if(!connectionUrl)throw new Error("Falta la conexión PostgreSQL para el comando de restauración");
 const exe=process.env.PG_BIN?join(process.env.PG_BIN,tool):tool;
  const env={...process.env,PGHOST:connectionUrl.hostname,PGPORT:connectionUrl.port||"5432",PGUSER:decodeURIComponent(connectionUrl.username),PGDATABASE:decodeURIComponent(connectionUrl.pathname.slice(1)),PGPASSWORD:decodeURIComponent(connectionUrl.password)};
  for(const [parameter,variable] of [["sslmode","PGSSLMODE"],["sslrootcert","PGSSLROOTCERT"],["sslcert","PGSSLCERT"],["sslkey","PGSSLKEY"],["sslcrl","PGSSLCRL"],["ssl_min_protocol_version","PGSSLMINPROTOCOLVERSION"],["ssl_max_protocol_version","PGSSLMAXPROTOCOLVERSION"],["channel_binding","PGCHANNELBINDING"],["connect_timeout","PGCONNECT_TIMEOUT"],["application_name","PGAPPNAME"],["options","PGOPTIONS"]]){const value=connectionUrl.searchParams.get(parameter);if(value)env[variable]=value;}
 return new Promise((done,fail)=>{let message="";const child=spawn(exe,argv,{env,stdio:["ignore","ignore","pipe"]});child.stderr.on("data",b=>{message+=b.toString();});child.on("error",()=>fail(new Error(`No se pudo iniciar ${tool}; se requiere cliente PostgreSQL 18`)));child.on("exit",code=>code===0?done():fail(new Error(`${tool} falló (${code}); revisá el destino y permisos sin copiar credenciales (${message.replace(/postgres(?:ql)?:\/\/\S+/g,"[redacted]").slice(0,600)})`)));});
}
const counts=async tx=>({orders:await tx.operationOrder.count(),stockFacts:await tx.stockFact.count(),ledgerEvents:await tx.ledgerEvent.count(),commandReceipts:await tx.commandReceipt.count(),legacyRecords:await tx.legacySourceRecord.count(),legacyHistoricalFacts:await tx.legacyHistoricalFact.count(),legacyHistoryPublications:await tx.legacyHistoryPublication.count(),documents:await tx.operationDocument.count(),offlineBackups:await tx.offlineBackup.count()});
const migrationDirectory=new URL("../prisma/migrations/",import.meta.url);
const fingerprintGroups={
 ledger:[{name:"LedgerEvent",table:"LedgerEvent",cursor:"id"},{name:"LedgerLeg",table:"LedgerLeg",cursor:"id"}],
 reservations:[{name:"StockReservation",table:"StockReservation",cursor:"id"}],
 debt:[{name:"OperationPayable",table:"OperationPayable",cursor:"id"},{name:"PayablePayment",table:"PayablePayment",cursor:"id"},{name:"MemberCredit",table:"MemberCredit",cursor:"id"}],
 custody:[{name:"OperationAccount",table:"OperationAccount",cursor:"id"},{name:"AccountReconciliation",table:"AccountReconciliation",cursor:"id"},{name:"CollectionReport",table:"CollectionReport",cursor:"id"},{name:"Rendition",table:"Rendition",cursor:"id"},{name:"DeliveryRoute",table:"DeliveryRoute",cursor:"id"}],
 receipts:[{name:"CommandReceipt",table:"CommandReceipt",cursor:"requestId"}],
};
async function expectedMigrations(){
 const entries=(await readdir(migrationDirectory,{withFileTypes:true})).filter(entry=>entry.isDirectory()).sort((left,right)=>left.name<right.name?-1:left.name>right.name?1:0);
 if(!entries.length)throw new Error("No se encontraron migraciones de esquema para validar");
 const expected=[];
 for(const entry of entries){
  const source=await readFile(new URL(`${entry.name}/migration.sql`,migrationDirectory));
  expected.push({name:entry.name,checksum:hash(source)});
 }
 return expected;
}
function sameMigrations(actual,expected){
 return Array.isArray(actual)&&actual.length===expected.length&&actual.every((entry,index)=>entry&&entry.name===expected[index].name&&entry.checksum===expected[index].checksum);
}
async function validateAppliedMigrations(tx,expected){
 let rows;
 try{
  rows=await tx.$queryRawUnsafe('SELECT migration_name AS name, checksum, finished_at AS "finishedAt", rolled_back_at AS "rolledBackAt" FROM "_prisma_migrations" ORDER BY migration_name COLLATE "C"');
 }catch{
  throw new Error("No se pudo leer el historial _prisma_migrations del esquema respaldado");
 }
 if(rows.some(row=>row.finishedAt===null&&row.rolledBackAt===null))throw new Error("El esquema tiene una migración incompleta o fallida");
 const applied=rows.filter(row=>row.finishedAt!==null&&row.rolledBackAt===null).map(row=>({name:row.name,checksum:row.checksum}));
 if(!sameMigrations(applied,expected))throw new Error("Las migraciones aplicadas y sus checksums no coinciden con el esquema esperado");
 return expected;
}
async function financialFingerprints(tx){
 const result={};
 for(const [category,models] of Object.entries(fingerprintGroups)){
  const digest=createHash("sha256"),rowCounts={};
  for(const model of models){
   let last,modelCount=0;
   digest.update(`${model.name}\0`);
   for(;;){
    const cursorColumn=`"${model.cursor}"`;
    const query=last===undefined
     ? `SELECT to_jsonb(t)::text AS record, t.${cursorColumn}::text AS cursor FROM "${model.table}" AS t ORDER BY t.${cursorColumn}::text COLLATE "C" LIMIT 500`
     : `SELECT to_jsonb(t)::text AS record, t.${cursorColumn}::text AS cursor FROM "${model.table}" AS t WHERE t.${cursorColumn}::text COLLATE "C" > $1::text COLLATE "C" ORDER BY t.${cursorColumn}::text COLLATE "C" LIMIT 500`;
    const rows=last===undefined?await tx.$queryRawUnsafe(query):await tx.$queryRawUnsafe(query,last);
    if(!rows.length)break;
    for(const row of rows){
     const value=row.record;
     digest.update(`${Buffer.byteLength(value,"utf8")}:`);
     digest.update(value);
     digest.update("\n");
     last=row.cursor;
     modelCount++;
    }
   }
   rowCounts[model.name]=modelCount;
   digest.update(`count:${modelCount}\0`);
  }
  result[category]={sha256:digest.digest("hex"),rowCounts};
 }
 return result;
}
function validFinancialFingerprints(value){
 if(!value||typeof value!=="object"||Array.isArray(value))return false;
 const categories=Object.keys(fingerprintGroups);
 if(Object.keys(value).length!==categories.length||categories.some(category=>!Object.hasOwn(value,category)))return false;
 for(const [category,models] of Object.entries(fingerprintGroups)){
  const fingerprint=value[category];
  if(!fingerprint||typeof fingerprint.sha256!=="string"||!/^[a-f0-9]{64}$/.test(fingerprint.sha256)||!fingerprint.rowCounts||typeof fingerprint.rowCounts!=="object"||Array.isArray(fingerprint.rowCounts))return false;
  if(Object.keys(fingerprint.rowCounts).length!==models.length||models.some(model=>!Object.hasOwn(fingerprint.rowCounts,model.name)))return false;
  for(const model of models)if(!Number.isSafeInteger(fingerprint.rowCounts[model.name])||fingerprint.rowCounts[model.name]<0)return false;
 }
 return true;
}
function sameFinancialFingerprints(actual,expected){
 if(!validFinancialFingerprints(actual)||!validFinancialFingerprints(expected))return false;
 return Object.entries(fingerprintGroups).every(([category,models])=>actual[category].sha256===expected[category].sha256&&models.every(model=>actual[category].rowCounts[model.name]===expected[category].rowCounts[model.name]));
}
async function requirePostgresMajor18(tool){
 const executable=process.env.PG_BIN?join(process.env.PG_BIN,tool):tool;
 const version=await new Promise((resolveVersion,reject)=>{
  const child=spawn(executable,["--version"],{stdio:["ignore","pipe","pipe"]});let output="";
  child.stdout.on("data",chunk=>{output+=chunk.toString();});child.stderr.on("data",chunk=>{output+=chunk.toString();});
  child.on("error",()=>reject(new Error(`No se pudo iniciar ${tool}; se requiere cliente PostgreSQL 18`)));
  child.on("exit",code=>code===0?resolveVersion(output):reject(new Error(`${tool} no pudo informar su versión`)));
 });
 const match=/PostgreSQL\)\s+(\d+)(?:\.|\s|$)/.exec(version);
 if(!match||Number(match[1])!==18)throw new Error(`${tool} debe ser de PostgreSQL 18`);
}
async function requirePostgresServerMajor18(tx){
 const rows=await tx.$queryRawUnsafe("SELECT current_setting('server_version_num')::int AS version_num, current_setting('server_version') AS version");
 const numeric=Number(rows[0]?.version_num);
 if(!Number.isSafeInteger(numeric)||Math.floor(numeric/10000)!==18)throw new Error("La base debe ejecutar PostgreSQL 18 para crear o restaurar el paquete");
 return {major:18,version:String(rows[0].version)};
}
function requireLocalValidationConnection(raw){
 if(typeof raw!=="string"||!raw)throw new Error("La restauración remota requiere RESTORE_VALIDATION_DATABASE_URL loopback para prevalidar el paquete antes de escribir");
 let validationUrl;
 try{validationUrl=new URL(raw);}catch{throw new Error("RESTORE_VALIDATION_DATABASE_URL debe ser una conexión PostgreSQL loopback dedicada");}
 if(!["postgres:","postgresql:"].includes(validationUrl.protocol))throw new Error("RESTORE_VALIDATION_DATABASE_URL debe ser una conexión PostgreSQL loopback dedicada");
 const target=authorizeRestoreDestination(raw,{});
 const hostname=validationUrl.hostname.toLowerCase().replace(/^\[|\]$/g,"");
 const database=decodeURIComponent(validationUrl.pathname.slice(1));
 if(target.kind!=="loopback-rehearsal"||!(hostname==="localhost"||hostname==="::1"||hostname.startsWith("127."))||!/^bombo_ui_[a-z0-9_-]+$/i.test(database))
  throw new Error("RESTORE_VALIDATION_DATABASE_URL debe apuntar a una base loopback bombo_ui_ dedicada");
 validationUrl.searchParams.set("schema","public");
 return validationUrl;
}
async function validateRestoredState(validationDb,expected,manifest){
 const restoredState=await validationDb.$transaction(async tx=>{
  await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
  return {migrations:await validateAppliedMigrations(tx,expected),financialFingerprints:await financialFingerprints(tx),counts:await counts(tx)};
 },{isolationLevel:"RepeatableRead",timeout:300000});
 if(!sameMigrations(restoredState.migrations,manifest.migrations))throw new Error("Las migraciones restauradas en la validación previa no coinciden con el manifiesto");
 if(!sameFinancialFingerprints(restoredState.financialFingerprints,manifest.financialFingerprints))throw new Error("Las huellas financieras restauradas en la validación previa no coinciden con el manifiesto");
 if(JSON.stringify(restoredState.counts)!==JSON.stringify(manifest.counts))throw new Error("Los conteos restaurados en la validación previa no coinciden con el manifiesto");
 return restoredState;
}
async function validateRestoredDocuments(validationDb,manifest){
 const documents=await validationDb.operationDocument.findMany({where:{state:"available"},select:{id:true,objectKey:true,objectVersion:true,checksum:true,bytes:true,mediaType:true}});
 if(documents.length!==manifest.objects.length||new Set(manifest.objects.map(object=>object?.id)).size!==documents.length)
  throw new Error("El manifiesto de objetos no coincide con los documentos disponibles de la validación previa");
 const documentsById=new Map(documents.map(document=>[document.id,document]));
 for(const object of manifest.objects){
  const document=object&&typeof object.id==="string"?documentsById.get(object.id):undefined;
  if(!document||document.objectKey!==object.objectKey||document.objectVersion!==object.objectVersion||document.checksum!==object.checksum||document.bytes!==object.bytes||document.mediaType!==object.mediaType)
   throw new Error("Las identidades de objetos del manifiesto no coinciden con la base de la validación previa");
  const entry=manifest.files.find(file=>file.name===object.file);
  const bytes=await readStored(manifest,entry);
  if(bytes.length!==document.bytes||hash(bytes)!==document.checksum)
   throw new Error("El contenido de un objeto no coincide con los metadatos de la validación previa");
 }
}
async function preflightRestore(manifest,expected,dumpPath,validationBaseUrl){
 const baseTarget=authorizeRestoreDestination(validationBaseUrl.toString(),{});
 const hostname=validationBaseUrl.hostname.toLowerCase().replace(/^\[|\]$/g,"");
 if(baseTarget.kind!=="loopback-rehearsal"||!(hostname==="localhost"||hostname==="::1"||hostname.startsWith("127.")))
  throw new Error("La validación previa requiere un servidor PostgreSQL 18 loopback");
 const database=decodeURIComponent(validationBaseUrl.pathname.slice(1));
 if(!/^bombo_ui_[a-z0-9_-]+$/i.test(database))throw new Error("La conexión de validación previa debe apuntar a una base bombo_ui_ dedicada");
 await requirePostgresMajor18("createdb");
 await requirePostgresMajor18("dropdb");
 const baseDb=new PrismaClient({datasources:{db:{url:validationBaseUrl.toString()}}});
 let validationDb,created=false,primaryError,cleanupError;
 const validationDatabase=`bombo_ui_restore_validation_${randomBytes(12).toString("hex")}`;
 try{
  await requireConnectedTarget(baseDb,databaseTarget(validationBaseUrl));
  await requirePostgresServerMajor18(baseDb);
  await pg("createdb",["--maintenance-db=postgres","--template=template0",validationDatabase],validationUrlForDatabase(validationBaseUrl,"postgres"));
  created=true;
  const validationUrl=validationUrlForDatabase(validationBaseUrl,validationDatabase);
  validationUrl.searchParams.set("schema",manifest.schema);
  validationDb=new PrismaClient({datasources:{db:{url:validationUrl.toString()}}});
  await requireEmptyRestoreDatabase(validationDb);
  await requirePostgresServerMajor18(validationDb);
  await pg("pg_restore",["--clean","--if-exists","--single-transaction","--exit-on-error","--no-owner","--no-privileges","--dbname",validationDatabase,dumpPath],validationUrl);
  await validateRestoredState(validationDb,expected,manifest);
  await validateRestoredDocuments(validationDb,manifest);
 }catch(error){primaryError=error;}
 try{await validationDb?.$disconnect();}catch(error){cleanupError=error;}
 if(created){
  try{await pg("dropdb",["--if-exists","--force","--maintenance-db=postgres",validationDatabase],validationUrlForDatabase(validationBaseUrl,"postgres"));}
  catch(error){cleanupError=cleanupError?new AggregateError([cleanupError,error]):error;}
 }
 try{await baseDb.$disconnect();}catch(error){cleanupError=cleanupError?new AggregateError([cleanupError,error]):error;}
 if(primaryError&&cleanupError)throw new AggregateError([primaryError,cleanupError],"La validación previa falló y no se pudo limpiar por completo su base temporal");
 if(cleanupError)throw cleanupError;
 if(primaryError)throw primaryError;
}
function validationUrlForDatabase(baseUrl,database){
 const connectionUrl=new URL(baseUrl);
 connectionUrl.pathname=`/${database}`;
 return connectionUrl;
}
async function backupReuseIndex(snapshotAt){
 const path=process.env.BACKUP_OBJECT_REUSE_INDEX;
 if(!path)return undefined;
 if(!key)throw new Error("El índice incremental requiere la clave del paquete cifrado");
 let index;
 try{index=JSON.parse(await readFile(path,"utf8"));}catch{throw new Error("El índice incremental autenticado no se pudo leer");}
 const tier=process.env.BACKUP_TIER||"frequent",bucket=process.env.BACKUP_S3_BUCKET,region=process.env.BACKUP_S3_REGION,prefix=process.env.BACKUP_S3_PREFIX||"bombo";
 if(process.env.BACKUP_KEY_ID!==backupKeyId(key)||!verifyObjectReuseIndex(index,key,{tier,bucket,region,prefix,keyId:backupKeyId(key)}))throw new Error("El índice incremental no está autenticado o no coincide con esta tarea");
 const slot=tier==="monthly"?snapshotAt.slice(0,7):snapshotAt.slice(0,10);
 return index.slot===slot?index:undefined;
}
try{
 const expected=await expectedMigrations();
 if(mode==="backup"){
  const target=databaseTarget(url);
  const {getPrivateObject}=await import("../dist-server/server/operations/object-store.js");
  try{await stat(directory);throw new Error("El destino ya existe; creá un directorio nuevo");}catch(e){if(e.code!=="ENOENT")throw e;}
  await requirePostgresMajor18("pg_dump");
  await mkdir(join(directory,"objects"),{recursive:true,mode:0o700});
  const startedAt=new Date().toISOString(),temporary=join(directory,"snapshot.tmp");let result;
  try{
   result=await db.$transaction(async tx=>{
    const database=await requirePostgresServerMajor18(tx);
    await requireConnectedTarget(tx,target);
    const [row]=await tx.$queryRawUnsafe("SELECT pg_export_snapshot() AS snapshot, statement_timestamp() AS snapshot_at");
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
    const schema=target.schema;
    const migrations=await validateAppliedMigrations(tx,expected);
    await pg("pg_dump",["--format=custom","--no-owner","--no-privileges",`--schema=${schema}`,`--snapshot=${row.snapshot}`,"--file",temporary]);
    const documents=await tx.operationDocument.findMany({where:{state:"available"},select:{id:true,objectKey:true,objectVersion:true,checksum:true,bytes:true,mediaType:true}});
    return {schema,targetFingerprint:target.fingerprint,database,migrations,financialFingerprints:await financialFingerprints(tx),counts:await counts(tx),documents,snapshotAt:row.snapshot_at.toISOString()};
   },{isolationLevel:"RepeatableRead",timeout:300000});
   files.push(await storeDumpStream(temporary,join(directory,"database.dump"),"database.dump",key));
  }finally{await rm(temporary,{force:true});}
  const reuseIndex=await backupReuseIndex(result.snapshotAt);
  for(const doc of result.documents){if(!doc.objectKey||!doc.objectVersion||doc.objectVersion==="null"||!doc.checksum||!Number.isSafeInteger(doc.bytes)||doc.bytes<0||typeof doc.mediaType!=="string"||!doc.mediaType)throw new Error("Documento disponible sin identidad íntegra");}
  const objectPlan=await planBackupDocumentObjects({
   documents:result.documents,
   reuseIndex,
   loadSourceObject:doc=>getPrivateObject(doc.objectKey,doc.objectVersion,doc.checksum),
   storeSourceObject:(name,bytes)=>storeFile(name,bytes),
  });
  files.push(...objectPlan.files);
  const objects=objectPlan.objects;
  const manifest={schemaVersion:2,startedAt,snapshotAt:result.snapshotAt,finishedAt:new Date().toISOString(),schema:result.schema,targetFingerprint:result.targetFingerprint,databaseMajor:result.database.major,databaseVersion:result.database.version,migrations:result.migrations,financialFingerprints:result.financialFingerprints,counts:result.counts,files,objects,encrypted:Boolean(key),scope:"confirmed-server-state-only"};
  await writeFile(join(directory,"manifest.json"),JSON.stringify(manifest,null,2),{flag:"wx",mode:0o600});
  await writeFile(join(directory,"manifest.sha256"),hash(await readFile(join(directory,"manifest.json"))),{flag:"wx",mode:0o600});
  if(key)await writeFile(join(directory,"manifest.hmac"),createHmac("sha256",key).update(await readFile(join(directory,"manifest.json"))).digest("hex"),{flag:"wx",mode:0o600});
  console.log(JSON.stringify({mode:"backup",files:files.length,counts:result.counts,encrypted:Boolean(key),scope:manifest.scope,objectReuse:{sourceObjectReads:objectPlan.sourceObjectReads,reusedDocuments:objectPlan.reusedDocuments}}));
 }else{
  const manifestBytes=await readFile(join(directory,"manifest.json"));if(hash(manifestBytes)!==(await readFile(join(directory,"manifest.sha256"),"utf8")).trim())throw new Error("Manifiesto alterado");
  const manifest=JSON.parse(manifestBytes);if(manifest.schemaVersion!==2||!Array.isArray(manifest.files)||!Array.isArray(manifest.objects))throw new Error("Formato de respaldo no reconocido");
  if(manifest.targetFingerprint!==undefined&&(typeof manifest.targetFingerprint!=="string"||!/^[a-f0-9]{64}$/.test(manifest.targetFingerprint)))throw new Error("La huella del destino del respaldo es inválida");
  if(!sameMigrations(manifest.migrations,expected))throw new Error("Las migraciones del paquete no coinciden con el esquema esperado");
  if(!validFinancialFingerprints(manifest.financialFingerprints))throw new Error("Las huellas financieras del manifiesto son inválidas");
  if(manifest.encrypted){if(!key)throw new Error("El respaldo requiere su clave");const signature=Buffer.from((await readFile(join(directory,"manifest.hmac"),"utf8")).trim(),"hex"),expected=createHmac("sha256",key).update(manifestBytes).digest();if(signature.length!==expected.length||!timingSafeEqual(signature,expected))throw new Error("Autenticación del manifiesto inválida");}
  let reuseIndex;
  let reusableByIdentity=new Map();
  if(process.env.BACKUP_OBJECT_REUSE_INDEX){
   if(!key)throw new Error("El índice incremental requiere la clave del paquete cifrado");
   try{reuseIndex=JSON.parse(await readFile(process.env.BACKUP_OBJECT_REUSE_INDEX,"utf8"));}catch{throw new Error("El índice incremental autenticado no se pudo leer");}
   if(process.env.BACKUP_KEY_ID!==backupKeyId(key)||!verifyObjectReuseIndex(reuseIndex,key))throw new Error("El índice incremental no está autenticado");
   reusableByIdentity=indexReusableObjects(reuseIndex);
  }
  const referencesByFile=new Map();
  for(const object of manifest.objects){const entries=referencesByFile.get(object.file)??[];entries.push(object);referencesByFile.set(object.file,entries);}
  for(const file of manifest.files){
   if(file.name==="database.dump")await verifyDumpStream(join(directory,file.name),file,key);
   else if(await stat(join(directory,file.name)).then(()=>true).catch(error=>{if(error.code==="ENOENT")return false;throw error;}))await readStored(manifest,file);
   else{
    const references=referencesByFile.get(file.name)??[];
    if(!reuseIndex||!references.length||references.some(object=>{
     const reusable=findReusableObject(object,reusableByIdentity);
     return !reusable||reusable.file!==file.name||JSON.stringify(reusable.packageEntry)!==JSON.stringify(file);
    }))throw new Error("Falta un archivo cifrado del paquete y su referencia cloud no está autenticada");
   }
  }
  if(mode==="verify"){
   const configuredTarget=url?databaseTarget(url):null;
   let targetVerified=false;
   if(configuredTarget&&manifest.targetFingerprint){
    if(manifest.targetFingerprint!==configuredTarget.fingerprint)throw new Error("El respaldo pertenece a otro destino PostgreSQL");
    await requireConnectedTarget(db,configuredTarget);
    targetVerified=true;
   }
   console.log(JSON.stringify({mode:"verify",files:manifest.files.length,integrity:true,migrationsValid:true,scope:manifest.scope,...(url?{targetVerified,...(targetVerified?{targetFingerprint:manifest.targetFingerprint}:{})}:{})}));
  }
  else{
   if(!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(manifest.schema))throw new Error("Esquema del paquete inválido");
   const destinationSchema=databaseTarget(url).schema;
   if(destinationSchema!==manifest.schema)throw new Error("El esquema del destino de restauración no coincide con el del manifiesto");
   const validationBaseUrl=restoreTarget.kind==="allowlisted-remote"
    ?requireLocalValidationConnection(process.env.RESTORE_VALIDATION_DATABASE_URL)
    :new URL(url);
   if(restoreTarget.kind==="loopback-rehearsal")validationBaseUrl.searchParams.set("schema","public");
   if(process.env.RESTORE_OBJECT_PROVIDER&&process.env.RESTORE_OBJECT_PROVIDER!=="s3")throw new Error("RESTORE_OBJECT_PROVIDER sólo admite s3 para restauración coordinada");
   const coordinated=process.env.RESTORE_OBJECT_PROVIDER==="s3";
   let restoreBucket,restoreRegion,restoreObjectKmsKeyArn,destinationClient;
   if(coordinated){
    if(restoreTarget.kind!=="allowlisted-remote")throw new Error("La restauración coordinada sólo admite una base remota allowlisted");
    restoreBucket=authorizeRestoreObjectBucket(process.env.RESTORE_OBJECT_BUCKET,process.env);
    if(restoreBucket===process.env.BACKUP_S3_BUCKET)throw new Error("El destino de objetos debe ser distinto del bucket de backups");
    if(typeof process.env.RESTORE_OBJECT_REGION!=="string"||!/^[a-z0-9-]{3,32}$/.test(process.env.RESTORE_OBJECT_REGION))throw new Error("RESTORE_OBJECT_REGION inválida");
    restoreRegion=process.env.RESTORE_OBJECT_REGION;
    restoreObjectKmsKeyArn=safeRestoreObjectKmsKeyArn(process.env.RESTORE_OBJECT_KMS_KEY_ARN,restoreRegion);
    destinationClient=new S3Client({region:restoreRegion});
    try{await requireEmptyVersionedBucket(destinationClient,restoreBucket);}finally{destinationClient.destroy();destinationClient=undefined;}
    const backupId=process.env.BACKUP_RESTORE_BACKUP_ID;
    if(typeof backupId!=="string"||!/^[A-Za-z0-9T.-]{1,100}$/.test(backupId))throw new Error("BACKUP_RESTORE_BACKUP_ID inválido");
   }else{
    if(restoreTarget.kind!=="loopback-rehearsal")throw new Error("El restore local sólo es válido como verificación en una base loopback dedicada");
   }
   const restoreObjectRoot=coordinated?undefined:await validateRestoreObjectRoot(directory);
   await requireEmptyRestoreDatabase(db);
   await requirePostgresServerMajor18(db);
   await requirePostgresMajor18("pg_restore");
   const started=Date.now(),temporary=join(directory,`restore-${randomBytes(8).toString("hex")}.tmp`);let objectStore;
   try{
    await verifyDumpStream(join(directory,"database.dump"),manifest.files.find(f=>f.name==="database.dump"),key,temporary);
    await preflightRestore(manifest,expected,temporary,validationBaseUrl);
    if(restoreObjectRoot){await mkdir(restoreObjectRoot,{recursive:true,mode:0o700});await validateRestoreObjectRoot(directory);process.env.PRIVATE_OBJECT_ROOT=restoreObjectRoot;process.env.PRIVATE_S3_BUCKET="";process.env.PRIVATE_OBJECT_PROVIDER="local";process.env.PRIVATE_OBJECT_IMMUTABLE_WRITES="false";process.env.NODE_ENV="test";}
    else{process.env.PRIVATE_OBJECT_PROVIDER="s3";process.env.PRIVATE_S3_BUCKET=process.env.RESTORE_OBJECT_BUCKET;process.env.PRIVATE_S3_REGION=process.env.RESTORE_OBJECT_REGION;process.env.PRIVATE_S3_ENDPOINT="";process.env.PRIVATE_S3_PATH_STYLE="false";process.env.PRIVATE_S3_KMS_KEY_ARN=restoreObjectKmsKeyArn;process.env.PRIVATE_OBJECT_IMMUTABLE_WRITES="true";}
    objectStore=await import("../dist-server/server/operations/object-store.js");
    // PostgreSQL schema changes are atomic in pg_restore; private object writes have a separate lifecycle.
    await requireEmptyRestoreDatabase(db);
    await pg("pg_restore",["--clean","--if-exists","--single-transaction","--exit-on-error","--no-owner","--no-privileges","--dbname",restoreTarget.database,temporary]);
   }finally{await rm(temporary,{force:true});}
   const {getPrivateObject,putPrivateObject}=objectStore;
   const originalDocuments=await db.operationDocument.findMany({where:{state:"available"},select:{id:true,objectKey:true,objectVersion:true,checksum:true,bytes:true,mediaType:true}});
   if(originalDocuments.length!==manifest.objects.length||new Set(manifest.objects.map(o=>o.id)).size!==originalDocuments.length)throw new Error("El manifiesto omite o duplica documentos");
   const objectMappings=[];
   if(coordinated){
    destinationClient=new S3Client({region:restoreRegion});
    await requireEmptyVersionedBucket(destinationClient,restoreBucket);
    destinationClient.destroy();
    destinationClient=undefined;
   }
   for(const doc of manifest.objects){
    const original=originalDocuments.find(o=>o.id===doc.id);if(!original||original.objectKey!==doc.objectKey||original.objectVersion!==doc.objectVersion||original.checksum!==doc.checksum||original.bytes!==doc.bytes||original.mediaType!==doc.mediaType)throw new Error("Las identidades de objetos no coinciden con la base restaurada");
    const bytes=await readStored(manifest,manifest.files.find(f=>f.name===doc.file));
    const stored=await putPrivateObject(doc.objectKey,bytes,doc.mediaType??"application/octet-stream");
    if(stored.key!==doc.objectKey||!stored.version||stored.version==="null"||stored.checksum!==doc.checksum||stored.bytes!==doc.bytes||stored.mediaType!==(doc.mediaType??"application/octet-stream"))throw new Error("Checksum, versión o tamaño del archivo restaurado inválido");
    const verified=await getPrivateObject(stored.key,stored.version,stored.checksum);
    if(verified.length!==doc.bytes||hash(verified)!==doc.checksum)throw new Error("La lectura de comprobación del objeto restaurado no coincide");
    objectMappings.push({id:doc.id,objectKey:stored.key,sourceVersion:doc.objectVersion,destinationVersion:stored.version,checksum:stored.checksum,bytes:stored.bytes,mediaType:stored.mediaType});
   }
   const restoredState=await db.$transaction(async tx=>{
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
    return {migrations:await validateAppliedMigrations(tx,expected),financialFingerprints:await financialFingerprints(tx),counts:await counts(tx)};
   },{isolationLevel:"RepeatableRead",timeout:300000});
   const restoredMigrations=restoredState.migrations;
   const restoredFinancialFingerprints=restoredState.financialFingerprints;
   if(!sameMigrations(restoredMigrations,manifest.migrations))throw new Error("Las migraciones restauradas no coinciden con el manifiesto");
   if(!sameFinancialFingerprints(restoredFinancialFingerprints,manifest.financialFingerprints))throw new Error("Las huellas financieras restauradas no coinciden con el manifiesto");
   const restored=restoredState.counts;if(JSON.stringify(restored)!==JSON.stringify(manifest.counts))throw new Error("Conteos de restauración distintos");
   const manifestHash=hash(manifestBytes),orderedMappings=[...objectMappings].sort((left,right)=>left.id<right.id?-1:left.id>right.id?1:0),objectMappingsSha256=hash(Buffer.from(JSON.stringify(orderedMappings)));
   let auditId;
   if(coordinated){
    const backupId=process.env.BACKUP_RESTORE_BACKUP_ID;
    const audit=await db.$transaction(async tx=>{
     for(const mapping of orderedMappings){
      const result=await tx.operationDocument.updateMany({where:{id:mapping.id,state:"available",objectKey:mapping.objectKey,objectVersion:mapping.sourceVersion,checksum:mapping.checksum,bytes:mapping.bytes,mediaType:mapping.mediaType},data:{objectVersion:mapping.destinationVersion}});
      if(result.count!==1)throw new Error("Una referencia de documento cambió antes del commit de restauración");
      await tx.operationAudit.create({data:{actorId:"restore-operator",action:"restore.object-reference",objectId:mapping.id,details:{backupId,manifestHash,destinationBucket:process.env.RESTORE_OBJECT_BUCKET,objectKey:mapping.objectKey,sourceVersion:mapping.sourceVersion,destinationVersion:mapping.destinationVersion,checksum:mapping.checksum,bytes:mapping.bytes,mediaType:mapping.mediaType}}});
     }
     return tx.operationAudit.create({data:{actorId:"restore-operator",action:"restore.coordinated",objectId:"operations",details:{backupId,manifestHash,originalSnapshotAt:manifest.snapshotAt,destinationBucket:process.env.RESTORE_OBJECT_BUCKET,objectReferenceCount:orderedMappings.length,objectMappingsSha256}}});
    },{timeout:300000});
    auditId=audit.id;
   }else{
    const audit=await db.operationAudit.create({data:{actorId:"restore-operator",action:"restore.verification",objectId:"operations",details:{manifestHash,originalSnapshotAt:manifest.snapshotAt,objectCount:orderedMappings.length,objectMappingsSha256,scope:"verification-only"}}});
    auditId=audit.id;
   }
   console.log(JSON.stringify({mode:"restore",integrity:true,preflightValidated:true,migrationsValid:true,committed:coordinated,financialFingerprints:restoredFinancialFingerprints,counts:restored,objects:manifest.objects.length,objectReferencesCommitted:coordinated,objectReferenceCount:coordinated?orderedMappings.length:0,objectsVerified:orderedMappings.length,objectMappingsSha256,auditId,manifestHash,destinationBucket:coordinated?restoreBucket:undefined,elapsedMilliseconds:Date.now()-started,scope:coordinated?"coordinated-cloud":"verification-only"}));
  }
 }
}finally{await db?.$disconnect();key?.fill(0);}
