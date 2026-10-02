import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import bcrypt from "bcryptjs";
import ExcelJS from "exceljs";
import { parse as parseCsv } from "csv-parse/sync";
import { splitSqlStatements } from "./migration-sql.js";
import { readLegacyWorkbook, legacyReaderVersion } from "../server/operations/legacy-reader.js";
import { legacyPayloadHash } from "../server/operations/legacy-upload-contract.js";
import type { CommandEnvelope } from "../shared/operations/contracts.js";
// Primary owner: observable API effects, receipts and authorization. Fixtures establish only pre-existing objects.
test("canonical financial commands preserve cash custody, debt and global replay",{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const url=new URL(process.env.TEST_DATABASE_URL!);assert.ok(["127.0.0.1","localhost","[::1]"].includes(url.hostname));assert.match(url.pathname,/test|ci/i);
 const schema=`operations_${randomUUID().replaceAll("-","")}`;url.searchParams.set("schema",schema);
 process.env.DATABASE_URL=url.toString();process.env.DEMO_MODE="true";process.env.NODE_ENV="test";process.env.JWT_SECRET="operations-test-only-secret-more-than-32-characters";process.env.ALLOWED_ORIGIN="http://test.local";
 const {db}=await import("../server/db.js");await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
 const root=new URL("../prisma/migrations/",import.meta.url);
 for(const f of(await readdir(root,{withFileTypes:true})).filter(f=>f.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name))){for(const sql of splitSqlStatements(await readFile(new URL(`${f.name}/migration.sql`,root),"utf8")))await db.$executeRawUnsafe(sql);}
 const pass=await bcrypt.hash("Only-a-local-test-123",4);
 for(const [id,role] of [["owner","owner"],["finance","admin"],["driver","viewer"],["cashier","cashier"]] as const)await db.user.create({data:{id,name:id,email:`${id}@test.local`,password:pass,role}});
  const {profileCapabilities}=await import("../shared/operations/contracts.js");
  for(const id of ["finance","driver"])await db.operationAccess.create({data:{userId:id,profile:id,capabilities:profileCapabilities[id]}});
  await db.user.create({data:{id:"importer",name:"Importer",email:"importer@test.local",password:pass,role:"admin"}});
  await db.operationAccess.create({data:{userId:"importer",profile:"finance",capabilities:["imports.write"]}});
 const {app}=await import("../server/app.js");const server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api`;
 const cookies:Record<string,string>={};
 async function login(id:string){const r=await fetch(base+"/auth/login",{method:"POST",headers:{Origin:"http://test.local","Content-Type":"application/json"},body:JSON.stringify({email:`${id}@test.local`,password:"Only-a-local-test-123"})});assert.equal(r.status,200);cookies[id]=r.headers.get("set-cookie")!.split(";")[0];}
 async function call(path:string,actor="owner",body?:unknown){return fetch(base+path,{method:body?"POST":"GET",headers:{Cookie:cookies[actor],Origin:"http://test.local","Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});}
 const e=(targetId:string,command:string,data:Record<string,unknown>,expectedVersion=0):CommandEnvelope=>({schemaVersion:1,requestId:randomUUID(),targetId,command,data,expectedVersion,occurredAt:new Date().toISOString()});
 const cmd=async(envelope:CommandEnvelope,actor="owner")=>{const r=await call("/operations/commands",actor,envelope);const body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body;};
 async function stageWorkbook(bytes:Buffer,sourceSystem:string,actor="importer"){
  const snapshot=await readLegacyWorkbook(bytes,{sourceSystem});
  const targetId=`fixture-${randomUUID()}`;
  const contentHash=legacyPayloadHash(snapshot.records);
  const manifest={chunks:snapshot.records.length?[{index:0,contentHash,recordCount:snapshot.records.length}]:[],recordsByTable:Object.fromEntries(snapshot.sheets.filter(s=>s.recordCount).map(s=>[s.name,s.recordCount]))};
  const begin=await call("/legacy-imports/batches",actor,e(targetId,"LegacyUploadBegun",{sourceSystem,filename:"synthetic.xlsx",fileHash:snapshot.fileHash,importerVersion:snapshot.importerVersion,manifestHash:legacyPayloadHash(manifest),manifest,controls:snapshot.summary,coverage:snapshot.sheets}));
  assert.equal(begin.status,201);let version=(await begin.json()).version;
  if(snapshot.records.length){const chunk=await call(`/legacy-imports/batches/${targetId}/chunks`,actor,e(targetId,"LegacyUploadChunkStored",{index:0,contentHash,records:snapshot.records},version));assert.equal(chunk.status,200,await chunk.clone().text());version=(await chunk.json()).version;}
  const finalized=await call(`/legacy-imports/batches/${targetId}/finalize`,actor,e(targetId,"LegacyUploadFinalized",{manifestHash:legacyPayloadHash(manifest)},version));
  assert.equal(finalized.status,200);const response=await finalized.json();return {snapshotId:targetId,version:response.version,importerVersion:snapshot.importerVersion,controls:{excludedCredentialColumns:snapshot.sheets.reduce((n,s)=>n+s.excludedCredentialColumns,0)}};
 }
 try{
  for(const id of ["owner","finance","driver","cashier","importer"])await login(id);
  await t.test("legacy preview is transient and creates no source rows or command receipts",async()=>{
   const workbook=new ExcelJS.Workbook();const sheet=workbook.addWorksheet("C_Cliente");sheet.addRow(["Id_Cliente","Nombre"]);sheet.addRow(["preview-only","Fixture"]);
   const before=[await db.legacyImportSnapshot.count(),await db.legacySourceRecord.count(),await db.commandReceipt.count()];
   const input={requestId:randomUUID(),sourceSystem:"transient-preview",filename:"fixture.xlsx",xlsxBase64:Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64")};
   for(let attempt=0;attempt<2;attempt++){const response=await call("/legacy-imports/preview","importer",input);assert.equal(response.status,200);const body=await response.json();assert.equal(body.status,"preview");assert.equal(body.persisted,false);assert.equal(body.snapshotId,undefined);}
   assert.deepEqual([await db.legacyImportSnapshot.count(),await db.legacySourceRecord.count(),await db.commandReceipt.count()],before);
  });
  await t.test("public commands reject internal legacy staging before parsing credential-bearing payloads",async()=>{
   const before={
    snapshots:await db.legacyImportSnapshot.count(),
    records:await db.legacySourceRecord.count(),
    exceptions:await db.legacyException.count(),
   };
   const marker="SYNTHETIC_CREDENTIAL_SENTINEL_NOT_A_SECRET";
   const logs:string[]=[];
   const originalConsoleError=console.error;
   console.error=(...args:unknown[])=>{logs.push(args.map(value=>typeof value==="string"?value:"[non-string log entry]").join(" "));};
   try{
    for(const rejectedLayer of ["original","normalized"] as const){
     const request=e(`manual-stage-${randomUUID()}`,"LegacySnapshotStaged",{
      sourceSystem:"manual-stage-security-test",filename:"synthetic.xlsx",fileHash:"a".repeat(64),importerVersion:"manual-security-test",
      controls:{},coverage:[],records:[{
       sourceTable:"T_Usuarios",sourceKey:"synthetic-user",sourceRow:2,fileHash:"a".repeat(64),contentHash:"b".repeat(64),importerVersion:"manual-security-test",
       original:{columns:[{coordinate:"A2",header:"Nombre",value:"Synthetic user"},...(rejectedLayer==="original"?[{coordinate:"B2",header:"Password",value:marker}]:[])]},
       normalized:{columns:[{coordinate:"A2",header:"Nombre",value:"Synthetic user"},...(rejectedLayer==="normalized"?[{coordinate:"B2",header:"Password",value:marker}]:[])],overlapEvidence:{targetTable:"Movimiento_Nueva",targetSourceRow:null,status:"comparison_incomplete",comparedFields:0}},
       treatment:"archive_only",exceptions:[],
      }],
     });
     const response=await call("/operations/commands","importer",request);
     const body=await response.text();
     assert.equal(response.status,403);
     assert.equal(JSON.parse(body).code,"INTERNAL_COMMAND");
     assert.equal(body.includes(marker),false);
     assert.equal(body.toLowerCase().includes("password"),false);
     assert.equal(await db.commandReceipt.count({where:{requestId:request.requestId}}),0);
     assert.equal(await db.operationAudit.count({where:{requestId:request.requestId}}),0);
     assert.equal(await db.operationOutbox.count({where:{requestId:request.requestId}}),0);
     assert.equal(await db.operationObject.count({where:{id:request.targetId}}),0);
    }
   }finally{console.error=originalConsoleError;}
   assert.equal(logs.some(line=>line.includes(marker)||line.toLowerCase().includes("password")),false);
   assert.equal(await db.legacyImportSnapshot.count(),before.snapshots);
   assert.equal(await db.legacySourceRecord.count(),before.records);
   assert.equal(await db.legacyException.count(),before.exceptions);
  });
  await t.test("sanitized batches preserve C_Cliente document references without treating them as auth credentials",async()=>{
   const reference="SYNTHETIC_DOCUMENT_REFERENCE";
   const passwordMarker="SYNTHETIC_PASSWORD_SENTINEL";
   const workbook=new ExcelJS.Workbook();const sheet=workbook.addWorksheet("C_Cliente");
   sheet.addRow(["Id_Cliente","Nombre","Credencial"]);sheet.addRow(["synthetic-client","Socio de prueba",reference]);
   const users=workbook.addWorksheet("T_Usuarios");users.addRow(["ID_Usuarios","Contraseña"]);users.addRow(["synthetic-user",passwordMarker]);
   const body=await stageWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()),"preview-reference-test");
   assert.equal(body.importerVersion,legacyReaderVersion);
   assert.equal(body.controls.excludedCredentialColumns,1);
   const stored=await db.legacySourceRecord.findMany({where:{snapshotId:body.snapshotId as string},select:{sourceTable:true,original:true,normalized:true}});
   const client=stored.find((record)=>record.sourceTable==="C_Cliente");
   const user=stored.find((record)=>record.sourceTable==="T_Usuarios");
   assert.ok(client);assert.ok(user);
   assert.equal(JSON.stringify(client.original).includes(reference),true);
   assert.equal(JSON.stringify(client.normalized).includes(reference),true);
   assert.equal(JSON.stringify(user.original).includes(passwordMarker),false);
   assert.equal(JSON.stringify(user.normalized).includes(passwordMarker),false);
   assert.equal(JSON.stringify(user).includes("Contraseña"),false);
  });
  await t.test("sanitized batches exclude recognizable tokens under ordinary headers before DB storage and review",async()=>{
   const token="sk-proj-"+"synthetic".repeat(8),workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet("C_Cliente");sheet.addRow(["Id_Cliente","Nombre"]);sheet.addRow(["ordinary-header-fixture",token]);
   const body=await stageWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()),"ordinary-header-test");
   const stored=await db.legacySourceRecord.findMany({where:{snapshotId:body.snapshotId}}),exceptions=await db.legacyException.findMany({where:{snapshotId:body.snapshotId}});assert.equal(stored.length,1);assert.equal(JSON.stringify({stored,exceptions}).includes(token),false);assert.ok(exceptions.some(exception=>exception.kind==="credential_value_excluded"));
   const review=await call(`/legacy-imports/staged-records?snapshotId=${body.snapshotId}`,"finance");assert.equal(review.status,200);assert.equal(JSON.stringify(await review.json()).includes(token),false);
   const historicalId=randomUUID(),historicalToken="Bearer "+"synthetic".repeat(5);
   await db.legacyImportSnapshot.create({data:{id:historicalId,sourceSystem:historicalToken,filename:historicalToken,fileHash:"0".repeat(64),importerVersion:"historical-test-fixture",createdBy:"importer",coverage:{sheets:[{name:historicalToken}]},controls:{note:historicalToken}}});
   await db.legacySourceRecord.create({data:{id:randomUUID().replaceAll("-","").padEnd(64,"0"),snapshotId:historicalId,sourceTable:historicalToken,sourceKey:"ordinary-key",sourceRow:2,fileHash:"0".repeat(64),contentHash:"1".repeat(64),importerVersion:"historical-test-fixture",original:{columns:[{header:"Nombre",value:"Visible history"}]},normalized:{columns:[]},treatment:"archive_only"}});
   for(const path of ["/legacy-imports/coverage",`/legacy-imports/staged-records?snapshotId=${historicalId}`]){const projected=await call(path,"finance");assert.equal(projected.status,200);assert.equal(JSON.stringify(await projected.json()).includes(historicalToken),false);}
  });
  await t.test("catalog SKU commands accept request evidence and persist it only in audit",async()=>{
   const skuId=`sku-${randomUUID()}`,code=`SKU-${randomUUID()}`;
   const created=await cmd(e(skuId,"CatalogSkuCreated",{code,name:"Integration flower",variety:"Fixture cultivar",category:"flower",unit:"g",evidence:{reference:"catalog-create"}}));
   assert.equal(created.version,1);
   const stored=await db.catalogSku.findUniqueOrThrow({where:{id:skuId}});
   assert.equal(stored.minQuantity.toString(),"0");assert.equal(stored.minVarieties,0);assert.equal("evidence" in stored,false);
   const createAudits=await db.operationAudit.findMany({where:{objectId:skuId,requestId:created.requestId}});
   assert.ok(createAudits.some(row=>JSON.stringify(row.details).includes("catalog-create")));

   const updated=await cmd(e(skuId,"CatalogSkuUpdated",{code,name:"Integration flower updated",variety:"Fixture cultivar",category:"flower",unit:"g",minQuantity:"0.500",minVarieties:1,active:true,evidence:{reference:"catalog-update"}},1));
   assert.equal(updated.version,2);
   const storedUpdated=await db.catalogSku.findUniqueOrThrow({where:{id:skuId}});
   assert.equal(storedUpdated.name,"Integration flower updated");assert.equal(storedUpdated.minQuantity.toString(),"0.5");assert.equal("evidence" in storedUpdated,false);
   const updateAudits=await db.operationAudit.findMany({where:{objectId:skuId,requestId:updated.requestId}});
   assert.ok(updateAudits.some(row=>JSON.stringify(row.details).includes("catalog-update")));
  });
  for(const [id,kind,custodianId] of [["club","cash",undefined],["bank","bank",undefined],["courier","custody","driver"]] as const){
   await cmd(e(id,"AccountCreated",{name:id,currency:"ARS",kind,holder:id,purpose:"Local test",...(custodianId?{custodianId}:{})}));
   await cmd(e(id,"AccountVerified",{evidence:{reference:"local-account-check"}},1));
   await cmd(e(id,"AccountOpeningApproved",{amountMinor:id==="club"?"10000000000":"0",preparedBy:"finance",evidence:{reference:"local-count"}},2));
  }
  const member="member-fixture",order="order-fixture",delivery=randomUUID();
  await db.operationMember.create({data:{id:member,name:"Fixture member",address:{},preferences:{}}});
  await db.operationOrder.create({data:{id:order,memberId:member,channel:"delivery",currency:"ARS",commercialState:"confirmed",quote:{fixture:true},totalMinor:5000000000n,subtotalMinor:5000000000n,address:{},createdBy:"owner"}});
  await db.operationObject.create({data:{id:order,kind:"order",version:1,createdBy:"owner"}});
  await db.deliveryAssignment.create({data:{id:delivery,orderId:order,driverId:"driver",status:"dispatched",address:{},incidents:[]}});
  await db.operationObject.create({data:{id:delivery,kind:"delivery",version:1,createdBy:"owner"}});
  await t.test("historical invoice pages use real importer identities, reject tampering and bind the reviewed source",async()=>{
   const sourceSystem=`history-${randomUUID()}`,snapshotId=`legacy-${"a".repeat(64)}`;
   await db.legacyIdentity.create({data:{id:randomUUID(),sourceSystem,sourceTable:"C_Cliente",sourceKey:"legacy-person",destinationType:"member",destinationId:member,approvedBy:"finance"}});
   await db.legacyImportSnapshot.create({data:{id:snapshotId,sourceSystem,filename:"synthetic.xlsx",fileHash:"a".repeat(64),importerVersion:"history-fixture",createdBy:"importer",reviewedBy:"finance",status:"reviewed",coverage:[],controls:{}}});
   await db.legacyHistoryPublication.create({data:{sourceSystem,snapshotId,fileHash:"a".repeat(64),mappingId:"synthetic-policy",fingerprint:"d".repeat(64),publishedBy:"owner",evidence:{reference:"preexisting-reviewed-source"}}});
   await db.legacySourceRecord.createMany({data:[2,3,4].map(sourceRow=>({id:`invoice-${snapshotId}-${sourceRow}`,snapshotId,sourceTable:"C_Facturacion",sourceKey:`legacy-invoice-${sourceRow}`,sourceRow,fileHash:"a".repeat(64),contentHash:"b".repeat(64),importerVersion:"history-fixture",original:{columns:[]},normalized:{columns:[null,{header:"Cliente",value:"legacy-person"},{header:"Total_Facturado",value:"10",moneyMinorUnits:"1000"}]},treatment:"fact_candidate"}))});
   await db.legacyHistoricalFact.createMany({data:[2,3,4].map(sourceRow=>({id:"b".repeat(63)+sourceRow,sourceRecordId:`invoice-${snapshotId}-${sourceRow}`,snapshotId,sourceTable:"C_Facturacion",sourceKey:`legacy-invoice-${sourceRow}`,sourceRow,sourceHash:"b".repeat(64),mappingId:"synthetic-policy",kind:"invoice",occurredOn:null,dateState:"absent",currency:"ARS",currencyState:"known",unit:null,unitState:"not-applicable",amountMinor:1000n,amountState:"known",quantity:null,quantityState:"not-applicable",attributes:{fields:{amountField:"Total_Facturado"}},createdBy:"finance"}))});
   const secondSource=`history-other-${randomUUID()}`,secondSnapshot=`legacy-${"e".repeat(64)}`;
   await db.legacyIdentity.create({data:{id:randomUUID(),sourceSystem:secondSource,sourceTable:"C_Cliente",sourceKey:"legacy-person-other",destinationType:"member",destinationId:member,approvedBy:"finance"}});
   await db.legacyImportSnapshot.create({data:{id:secondSnapshot,sourceSystem:secondSource,filename:"other.xlsx",fileHash:"f".repeat(64),importerVersion:"history-fixture",createdBy:"importer",reviewedBy:"finance",status:"reviewed",coverage:[],controls:{}}});
   await db.legacyHistoryPublication.create({data:{sourceSystem:secondSource,snapshotId:secondSnapshot,fileHash:"f".repeat(64),mappingId:"synthetic-policy",fingerprint:"9".repeat(64),publishedBy:"owner",evidence:{reference:"second-independent-source"}}});
   for(const sourceRow of [2,3]){
    const recordId=`invoice-${secondSnapshot}-${sourceRow}`;
    await db.legacySourceRecord.create({data:{id:recordId,snapshotId:secondSnapshot,sourceTable:"C_Facturacion",sourceKey:`second-invoice-${sourceRow}`,sourceRow,fileHash:"f".repeat(64),contentHash:"b".repeat(64),importerVersion:"history-fixture",original:{columns:[]},normalized:{columns:[{header:"Cliente",value:"legacy-person-other"}]},treatment:"fact_candidate"}});
    await db.legacyHistoricalFact.create({data:{id:`fact-${recordId}`,sourceRecordId:recordId,snapshotId:secondSnapshot,sourceTable:"C_Facturacion",sourceKey:`second-invoice-${sourceRow}`,sourceRow,sourceHash:"b".repeat(64),mappingId:"synthetic-policy",kind:"invoice",dateState:"absent",currency:"USD",currencyState:"known",unitState:"not-applicable",amountMinor:123n,amountState:"known",quantityState:"not-applicable",attributes:{fields:{amountField:"Total_Facturado"}},createdBy:"finance"}});
   }
   const first=await call(`/operations/members/${member}/history?limit=2`);assert.equal(first.status,200);const page=await first.json();assert.equal(page.legacyInvoices.length,2);assert.equal(page.historicalHasMore,true);assert.ok(page.historicalNextCursor);assert.equal(page.coverage.historyCreatesBalances,false);
   const token=JSON.parse(Buffer.from(page.historicalNextCursor,"base64url").toString("utf8"));const altered=JSON.parse(token.payload);altered.row=999;token.payload=JSON.stringify(altered);
   const tampered=await call(`/operations/members/${member}/history?limit=2&historicalCursor=${encodeURIComponent(Buffer.from(JSON.stringify(token)).toString("base64url"))}`);assert.equal(tampered.status,400);
   const collected=[...page.legacyInvoices];let nextCursor=page.historicalNextCursor;
   while(nextCursor){const next=await call(`/operations/members/${member}/history?limit=2&historicalCursor=${encodeURIComponent(nextCursor)}`);assert.equal(next.status,200);const rest=await next.json();collected.push(...rest.legacyInvoices);nextCursor=rest.historicalNextCursor;if(!nextCursor)assert.equal(rest.historicalHasMore,false);}
   assert.equal(collected.length,5);assert.equal(new Set(collected.map((row:{id:string})=>row.id)).size,5);assert.deepEqual(new Set(collected.map((row:{currency:string})=>row.currency)),new Set(["ARS","USD"]));
   await db.legacyImportSnapshot.create({data:{id:`new-${snapshotId}`,sourceSystem,filename:"new-synthetic.xlsx",fileHash:"c".repeat(64),importerVersion:"history-fixture",createdBy:"importer",reviewedBy:"finance",status:"reviewed",coverage:[],controls:{},createdAt:new Date(Date.now()+1000)}});
   assert.equal((await call(`/operations/members/${member}/history?limit=2&historicalCursor=${encodeURIComponent(page.historicalNextCursor)}`)).status,200,"reviewing another snapshot must not select or double historical sales");
   await db.legacyHistoryPublication.update({where:{sourceSystem},data:{snapshotId:`new-${snapshotId}`,fileHash:"c".repeat(64),fingerprint:"e".repeat(64)}});
   const changed=await call(`/operations/members/${member}/history?limit=2&historicalCursor=${encodeURIComponent(page.historicalNextCursor)}`);assert.equal(changed.status,409);assert.equal((await changed.json()).code,"HISTORY_POPULATION_CHANGED");
  });
  await t.test("approved historical projection preserves unknowns and corrections without booking stock or money",async()=>{
   const before={stock:await db.stockFact.count(),ledger:await db.ledgerLeg.count()};
   const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet("C_Facturacion");sheet.addRow(["Id_Factura","Cliente","Fecha","Total_Facturado"]);sheet.addRow(["typed-known","typed-person","fecha inválida",123456789.12]);sheet.addRow(["typed-unknown","typed-person",null,null]);
   const sourceSystem=`typed-${randomUUID()}`,staged=await stageWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()),sourceSystem);
   const snapshot=await db.legacyImportSnapshot.findUniqueOrThrow({where:{id:staged.snapshotId}});
   let version=(await cmd(e(snapshot.id,"LegacySnapshotReviewed",{fileHash:snapshot.fileHash,changedContentReviewed:false,evidence:{reference:"independent-fixture-review"}},staged.version),"finance")).version;
   const policy=`mapping-${randomUUID()}`;
   await cmd(e(policy,"ConfigurationProposed",{name:policy,kind:"legacy_history_mapping",version:1,validFrom:"2026-01-01",definition:{tables:[{table:"C_Facturacion",kind:"invoice",dateField:"Fecha",amountField:"Total_Facturado",quantityField:null,currencyField:null,unitField:null,defaultCurrency:"ARS",defaultUnit:null}]},evidence:{reference:"synthetic-source-semantics"}}));
   const financeAccess=await db.operationAccess.findUniqueOrThrow({where:{userId:"finance"}});
   await db.operationAccess.update({where:{userId:"finance"},data:{capabilities:[...financeAccess.capabilities,"access.manage"]}});
   const delegated=await call("/operations/commands","finance",e(policy,"ConfigurationApproved",{evidence:{reference:"delegated-is-not-owner"}},1));assert.equal(delegated.status,403);assert.equal((await delegated.json()).code,"OWNER_APPROVAL_REQUIRED");
   await cmd(e(policy,"ConfigurationApproved",{evidence:{reference:"owner-policy-approval"}},1));
   const records=await db.legacySourceRecord.findMany({where:{snapshotId:snapshot.id},orderBy:{sourceRow:"asc"},select:{id:true,contentHash:true}});
   const progressPath=`/legacy-imports/history/projection-status?snapshotId=${snapshot.id}&mappingId=${policy}`;
   assert.equal((await call(progressPath,"driver")).status,403);
   assert.equal((await call(progressPath,"importer")).status,403);
   const beforeProgress=await call(progressPath,"finance");assert.equal(beforeProgress.status,200);const metadata=await beforeProgress.json();
   assert.equal(metadata.expectedRecords,2);assert.equal(metadata.remainingRecords,2);assert.deepEqual(metadata.nextRecords,records);
   assert.deepEqual(new Set(metadata.tables[0].headers),new Set(["Id_Factura","Cliente","Fecha","Total_Facturado"]));
   assert.equal(JSON.stringify(metadata).includes("typed-person"),false,"progress exposes metadata and row hashes, never source values");
   const unmapped=`mapping-empty-${randomUUID()}`;
   await cmd(e(unmapped,"ConfigurationProposed",{name:unmapped,kind:"legacy_history_mapping",version:1,validFrom:"2026-01-01",definition:{tables:[]},evidence:{reference:"synthetic-incomplete-mapping"}}));
   await cmd(e(unmapped,"ConfigurationApproved",{evidence:{reference:"owner-cannot-infer-table-treatment"}},1));
   const omission=await call("/operations/commands","finance",e(snapshot.id,"LegacyHistoryProjected",{fileHash:snapshot.fileHash,mappingId:unmapped,records},version));
   assert.equal(omission.status,422);assert.equal((await omission.json()).code,"HISTORY_TABLE_UNMAPPED");
   assert.equal(await db.legacyHistoricalFact.count({where:{snapshotId:snapshot.id,mappingId:unmapped}}),0);
   const publication=()=>({fileHash:snapshot.fileHash,mappingId:policy,evidence:{reference:"source-publication"}});
   const incomplete=await call("/operations/commands","owner",e(snapshot.id,"LegacyHistoryPublished",publication(),version));assert.equal(incomplete.status,423);assert.equal((await incomplete.json()).code,"HISTORY_PROJECTION_INCOMPLETE");
   version=(await cmd(e(snapshot.id,"LegacyHistoryProjected",{fileHash:snapshot.fileHash,mappingId:policy,records},version),"finance")).version;
   const afterProgress=await call(progressPath,"finance");assert.equal(afterProgress.status,200);const completed=await afterProgress.json();
   assert.equal(completed.projectedRecords,2);assert.equal(completed.remainingRecords,0);assert.deepEqual(completed.nextRecords,[]);
   const facts=await db.legacyHistoricalFact.findMany({where:{snapshotId:snapshot.id},orderBy:{sourceRow:"asc"}});assert.equal(facts.length,2);assert.equal(facts[0]!.amountMinor,12345678912n);assert.equal(facts[0]!.dateState,"invalid");assert.equal(facts[0]!.occurredOn,null);assert.equal(facts[1]!.amountState,"absent");assert.equal(facts[1]!.amountMinor,null);assert.equal(facts[1]!.quantityState,"not-applicable");
   const delegatedPublish=await call("/operations/commands","finance",e(snapshot.id,"LegacyHistoryPublished",publication(),version));assert.equal(delegatedPublish.status,403);assert.equal((await delegatedPublish.json()).code,"OWNER_APPROVAL_REQUIRED");
   await db.operationAccess.update({where:{userId:"finance"},data:{capabilities:financeAccess.capabilities}});
   version=(await cmd(e(snapshot.id,"LegacyHistoryPublished",publication(),version))).version;
   await db.legacyIdentity.create({data:{id:randomUUID(),sourceSystem,sourceTable:"C_Cliente",sourceKey:"typed-person",destinationType:"member",destinationId:member,approvedBy:"finance"}});
   await assert.rejects(db.legacyHistoricalFact.update({where:{id:facts[0]!.id},data:{amountMinor:1n}}),/append-only|check constraint/i);
   const beforeCorrection=await (await call(`/operations/members/${member}/history?limit=1`)).json();assert.ok(beforeCorrection.historicalNextCursor);
   const correction={factId:facts[0]!.id,replacement:{occurredOn:null,dateState:"invalid",currency:"ARS",currencyState:"known",unit:null,unitState:"not-applicable",amountValue:"12345678911",amountState:"known",quantityValue:null,quantityState:"not-applicable"},evidence:{reference:"separate-correction-evidence"}};
   version=(await cmd(e(snapshot.id,"LegacyHistoryCorrected",correction,version))).version;
   const history=await call(`/operations/members/${member}/history?limit=100`);assert.equal(history.status,200);const result=await history.json();const corrected=result.legacyInvoices.find((row:{sourceId:string})=>row.sourceId==="typed-known");assert.equal(corrected.totalMinor,"12345678911");assert.equal(corrected.correctionOf,facts[0]!.id);assert.equal(result.legacyInvoices.filter((row:{sourceId:string})=>row.sourceId==="typed-known").length,1);
   assert.equal((await db.legacyHistoricalFact.findUniqueOrThrow({where:{id:facts[0]!.id}})).amountMinor,12345678912n,"the original remains intact");
   const correctionCursor=await call(`/operations/members/${member}/history?limit=1&historicalCursor=${encodeURIComponent(beforeCorrection.historicalNextCursor)}`);assert.equal(correctionCursor.status,409);assert.equal((await correctionCursor.json()).code,"HISTORY_POPULATION_CHANGED");
   const replacementWorkbook=new ExcelJS.Workbook(),replacementSheet=replacementWorkbook.addWorksheet("C_Facturacion");replacementSheet.addRow(["Id_Factura","Cliente","Fecha","Total_Facturado"]);replacementSheet.addRow(["typed-known","typed-person","2026-09-01",100]);
   const nextSource=await stageWorkbook(Buffer.from(await replacementWorkbook.xlsx.writeBuffer()),sourceSystem),nextSnapshot=await db.legacyImportSnapshot.findUniqueOrThrow({where:{id:nextSource.snapshotId}});
   let nextVersion=(await cmd(e(nextSnapshot.id,"LegacySnapshotReviewed",{fileHash:nextSnapshot.fileHash,changedContentReviewed:true,evidence:{reference:"replacement-independent-review",previousFileHash:snapshot.fileHash}},nextSource.version),"finance")).version;
   const nextRecords=await db.legacySourceRecord.findMany({where:{snapshotId:nextSnapshot.id},select:{id:true,contentHash:true}});
   nextVersion=(await cmd(e(nextSnapshot.id,"LegacyHistoryProjected",{fileHash:nextSnapshot.fileHash,mappingId:policy,records:nextRecords},nextVersion),"finance")).version;
   const nextPublication={fileHash:nextSnapshot.fileHash,mappingId:policy,evidence:{reference:"replacement-publication"}};
   const blockedReplacement=await call("/operations/commands","owner",e(nextSnapshot.id,"LegacyHistoryPublished",nextPublication,nextVersion));assert.equal(blockedReplacement.status,409);const replacementReview=await blockedReplacement.json();assert.equal(replacementReview.code,"HISTORY_REPLACEMENT_REVIEW_REQUIRED");assert.equal(replacementReview.details.missingRecordCount,1);
   assert.equal((await db.legacyHistoryPublication.findUniqueOrThrow({where:{sourceSystem}})).snapshotId,snapshot.id,"a reviewed replacement cannot remove history silently");
   await cmd(e(nextSnapshot.id,"LegacyHistoryPublished",{...nextPublication,replacementReview:{previousFingerprint:replacementReview.details.previousFingerprint,missingRecordHash:replacementReview.details.missingRecordHash,reason:"Explicit reduced source accepted with evidence"}},nextVersion));
   assert.equal((await db.legacyHistoryPublication.findUniqueOrThrow({where:{sourceSystem}})).snapshotId,nextSnapshot.id);assert.equal(await db.legacyHistoricalFact.count({where:{snapshotId:snapshot.id}}),3,"old facts and correction remain conserved");

   assert.deepEqual({stock:await db.stockFact.count(),ledger:await db.ledgerLeg.count()},before);
  });
  await t.test("product history links sale lines through unique receipts and preserves unknown units",async()=>{
   const skuId=`history-sku-${randomUUID()}`,sourceSystem=`products-${randomUUID()}`,snapshotId=`product-source-${randomUUID()}`;
   await db.catalogSku.create({data:{id:skuId,code:skuId,name:"Historia de producto",variety:"Fixture",category:"Fixture",unit:"ud"}});
   await db.legacyImportSnapshot.create({data:{id:snapshotId,sourceSystem,filename:"products.xlsx",fileHash:"a".repeat(64),importerVersion:"fixture",status:"reviewed",createdBy:"importer",reviewedBy:"finance",coverage:[],controls:{}}});
   await db.legacyHistoryPublication.create({data:{sourceSystem,snapshotId,fileHash:"a".repeat(64),mappingId:"product-mapping",fingerprint:"c".repeat(64),publishedBy:"owner",evidence:{reference:"preexisting-approved-history"}}});
   await db.legacyIdentity.create({data:{id:randomUUID(),sourceSystem,sourceTable:"D_Catalogo_Mercaderia",sourceKey:"legacy-code",destinationType:"sku",destinationId:skuId,approvedBy:"finance"}});
   const rows=[
    {table:"C_Mercaderia",key:"receipt-identity",kind:"purchase",columns:[{header:"Codigo_Detalle",value:"legacy-code"}]},
    {table:"C_Detalle_Fact",key:"linked-line",kind:"sale-line",columns:[{header:"Artículo",value:"receipt-identity"},{header:"Detalle_Codigo_Detalle",value:"conflicting-code"}]},
    {table:"Mov_Stock1",key:"stock-history",kind:"stock",columns:[{header:"Codigo_Detalle",value:"legacy-code"}]},
    {table:"C_Detalle_Fact",key:"orphan-line",kind:"sale-line",columns:[{header:"Artículo",value:"legacy-code"},{header:"Detalle_Codigo_Detalle",value:"legacy-code"}]},
    {table:"ArchivedFixture",key:"archived-reference",kind:"archive",columns:[{header:"Codigo_Detalle",value:"legacy-code"}]},
    {table:"C_Detalle_Fact",key:"archived-sale-line",kind:"archive",columns:[{header:"Artículo",value:"receipt-identity"}]},
   ];
   for(const [index,row] of rows.entries()){
    const id=`row-${snapshotId}-${index}`;
    await db.legacySourceRecord.create({data:{id,snapshotId,sourceTable:row.table,sourceKey:row.key,sourceRow:index+2,fileHash:"a".repeat(64),contentHash:"b".repeat(64),importerVersion:"fixture",original:{columns:[]},normalized:{columns:row.columns},treatment:"fact_candidate"}});
    await db.legacyHistoricalFact.create({data:{id:`fact-${id}`,sourceRecordId:id,snapshotId,sourceTable:row.table,sourceKey:row.key,sourceRow:index+2,sourceHash:"b".repeat(64),mappingId:"product-mapping",kind:row.kind,dateState:"absent",quantity:"1.001",quantityState:"known",unitState:"absent",amountMinor:5000000000n,amountState:"known",currency:"USD",currencyState:"known",attributes:{},createdBy:"finance"}});
   }
   const path=`/operations/catalog/${skuId}/history?limit=1`;
   assert.equal((await call(path,"driver")).status,403);
   const first=await call(path);assert.equal(first.status,200);let page=await first.json();const seen=[...page.historicalItems];
   assert.equal(page.coverage.historyCreatesBalances,false);assert.equal(page.historicalHasMore,true);
   const altered=JSON.parse(Buffer.from(page.historicalNextCursor,"base64url").toString());if(typeof altered.payload==="string")altered.payload=JSON.stringify({...JSON.parse(altered.payload),row:999999});else altered.row=999999;
   assert.equal((await call(path+`&historicalCursor=${encodeURIComponent(Buffer.from(JSON.stringify(altered)).toString("base64url"))}`)).status,400,"an edited cursor cannot silently skip history");
   while(page.historicalNextCursor){const response=await call(path+`&historicalCursor=${encodeURIComponent(page.historicalNextCursor)}`);assert.equal(response.status,200);page=await response.json();seen.push(...page.historicalItems);}
   assert.equal(seen.length,5);assert.equal(new Set(seen.map(row=>row.id)).size,5);assert.equal(seen.some(row=>row.sourceKey==="orphan-line"),false);assert.ok(seen.some(row=>row.kind==="archive"&&row.sourceKey==="archived-reference"));
   assert.equal(seen.find(row=>row.sourceKey==="archived-sale-line").relationship,"archive-via-receipt-to-catalogue");
   const linked=seen.find(row=>row.sourceKey==="linked-line");assert.equal(linked.receiptKey,"receipt-identity");assert.equal(linked.codeConflict,true);assert.equal(linked.relationship,"sale-line-to-purchase-to-catalogue");
   assert.equal(linked.unit,null);assert.equal(linked.unitState,"absent");assert.equal(linked.quantity,"1.001");assert.equal(linked.amountMinor,"5000000000");assert.equal(linked.currency,"USD");
   const prior=await db.operationAccess.findUniqueOrThrow({where:{userId:"finance"}});
   await db.operationAccess.update({where:{userId:"finance"},data:{capabilities:[...prior.capabilities,"stock.read"],scope:{locationIds:["limited-location"]}}});
   const restricted=await call(path,"finance");assert.equal(restricted.status,200);const filtered=await restricted.json();assert.deepEqual(filtered.historicalItems,[]);assert.equal(filtered.coverage.historical,"location-custody-mapping-pending");
   await db.operationAccess.update({where:{userId:"finance"},data:{capabilities:prior.capabilities,scope:prior.scope}});
  });
  await t.test("customer segmentation preserves the strict 20 g boundary through the reports API",async()=>{
   for(const [memberId,orderId,grams] of [["member-threshold-20","order-threshold-20","20"],["member-threshold-20-001","order-threshold-20-001","20.001"]] as const){
    await db.operationMember.create({data:{id:memberId,name:"Synthetic threshold fixture",address:{},preferences:{}}});
    await db.operationOrder.create({data:{
     id:orderId,memberId,channel:"local",currency:"ARS",commercialState:"confirmed",quote:{fixture:true},subtotalMinor:100n,address:{},createdBy:"owner",confirmedAt:new Date("2026-09-15T12:00:00.000Z"),
     lines:{create:{id:`${orderId}-line`,skuId:"threshold-fixture",unit:"g",requested:grams,delivered:grams,unitPrice:"1",referenceMinor:100n,revenueMinor:100n,costMinor:0n}},
    }});
   }
   const response=await call("/reports/operations/metrics/customer-segmentation?from=2026-09-01&to=2026-09-30");
   const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));
   const counts=(body.summary as {metrics:{segmentCounts:Array<{segment:string;memberCount:number|null;suppressed:boolean}>}}).metrics.segmentCounts;
   assert.deepEqual(counts.filter(row=>row.segment==="occasional"||row.segment==="large-purchase"),[
    {segment:"large-purchase",memberCount:null,suppressed:true},
    {segment:"occasional",memberCount:null,suppressed:true},
   ]);
  });
  let report:CommandEnvelope;
  await t.test("a report never books money; verification clears debt in actual courier custody",async()=>{
   report=e(randomUUID(),"CollectionReported",{orderId:order,deliveryId:delivery,method:"cash",currency:"ARS",amountMinor:"2500000000",custodianId:"driver",evidence:{reference:"cash-reported"}});
   const before=await db.ledgerLeg.count();await cmd(report,"driver");assert.equal(await db.ledgerLeg.count(),before);assert.equal((await db.operationOrder.findUniqueOrThrow({where:{id:order}})).verifiedMinor,0n);
   await cmd(e(report.targetId,"CollectionVerified",{accountId:"courier",evidence:{reference:"cash-counted"}},1),"finance");
   const updated=await db.operationOrder.findUniqueOrThrow({where:{id:order}});assert.equal(updated.verifiedMinor,2500000000n);assert.equal(updated.financialState,"partially_paid");
   assert.equal((await db.ledgerLeg.aggregate({where:{accountId:"courier"},_sum:{amountMinor:true}}))._sum.amountMinor,2500000000n);
   assert.equal((await db.ledgerLeg.aggregate({where:{accountId:"club"},_sum:{amountMinor:true}}))._sum.amountMinor,10000000000n);
  });
  await t.test("replay precedes expected version; changed body and another actor reveal no receipt",async()=>{
   const replay=await cmd(report!,"driver");assert.equal(replay.replay,true);assert.equal(replay.version,1);
   const changed=await call("/operations/commands","driver",{...report!,data:{...report!.data,amountMinor:"1"}});assert.equal(changed.status,409);assert.equal((await changed.json()).code,"IDEMPOTENCY_KEY_REUSED");
   const other=await call("/operations/commands","finance",report!);assert.equal(other.status,403);const body=await other.json();assert.equal(body.code,"COMMAND_ACTOR_MISMATCH");assert.equal(body.result,undefined);
   assert.equal(await db.collectionReport.count(),1);
  });
  await t.test("rendition moves custody once without cancelling debt or recognizing revenue twice",async()=>{
   const request=e(randomUUID(),"RenditionAccepted",{driverId:"driver",fromAccountId:"courier",toAccountId:"club",grossMinor:"2500000000",deliveredMinor:"2500000000",mode:"gross",evidence:{reference:"received-at-club"}});
   await cmd(request,"finance");await cmd(request,"finance");
   assert.equal((await db.operationOrder.findUniqueOrThrow({where:{id:order}})).verifiedMinor,2500000000n);
   assert.equal((await db.ledgerLeg.aggregate({where:{accountId:"courier"},_sum:{amountMinor:true}}))._sum.amountMinor,0n);
   assert.equal((await db.ledgerLeg.aggregate({where:{accountId:"club"},_sum:{amountMinor:true}}))._sum.amountMinor,12500000000n);
   assert.equal(await db.ledgerEvent.count({where:{kind:"collection"}}),1);assert.equal(await db.ledgerEvent.count({where:{kind:"rendition"}}),1);
  });
  await t.test("a concurrent retry creates one receipt, event and financial effect",async()=>{
   const request=e("club","AccountTransferred",{toAccountId:"bank",amountMinor:"100",reason:"Local concurrency"},3);
   const responses=await Promise.all([call("/operations/commands","owner",request),call("/operations/commands","owner",request)]);
   for(const r of responses){assert.equal(r.status,200,JSON.stringify(await r.clone().json()));}
   const bodies=await Promise.all(responses.map(r=>r.json()));assert.equal(bodies.filter(b=>b.replay).length,1);
   assert.equal(await db.commandReceipt.count({where:{requestId:request.requestId}}),1);assert.equal(await db.ledgerEvent.count({where:{requestId:request.requestId}}),1);
   assert.equal((await db.ledgerLeg.aggregate({where:{accountId:"bank"},_sum:{amountMinor:true}}))._sum.amountMinor,100n);
  });
  await t.test("unknown openings stay unknown; local cash cannot be booked directly into a bank",async()=>{
   await cmd(e("unknown-opening","AccountCreated",{name:"Uncounted account",currency:"ARS",kind:"cash",holder:"club",purpose:"Await opening"}));
   await cmd(e("unknown-opening","AccountVerified",{evidence:{reference:"account-identity-only"}},1));
   const accounts=await(await call("/operations/accounts")).json();const unknown=accounts.items.find((a:{id:string})=>a.id==="unknown-opening");assert.equal(unknown.balanceMinor,null);assert.equal(unknown.coverage,"opening_pending");
   const reconciliation=await call("/operations/commands","owner",e("unknown-opening","AccountReconciled",{date:"2026-09-30",countedMinor:"0",evidence:{reference:"not-an-opening"}},2));assert.equal(reconciliation.status,423);
   const cash=e(randomUUID(),"CollectionReported",{orderId:order,method:"cash",currency:"ARS",amountMinor:"100",evidence:{reference:"received-at-club"}});await cmd(cash);
   const before=(await db.operationOrder.findUniqueOrThrow({where:{id:order}})).verifiedMinor;
   const denied=await call("/operations/commands","finance",e(cash.targetId,"CollectionVerified",{accountId:"bank",evidence:{reference:"cash-not-a-bank-deposit"}},1));assert.equal(denied.status,422);assert.equal((await denied.json()).code,"CASH_ACCOUNT_REQUIRED");assert.equal((await db.operationOrder.findUniqueOrThrow({where:{id:order}})).verifiedMinor,before);
  });
  await t.test("member write scopes also apply to permissions, before any record is revealed",async()=>{
   await db.user.create({data:{id:"scoped-editor",name:"Scoped editor",email:"scoped-editor@test.local",password:pass,role:"admin"}});
   await db.operationAccess.create({data:{userId:"scoped-editor",profile:"commercial",capabilities:[...profileCapabilities.commercial,"permissions.verify","documents.read","documents.write"],scope:{memberIds:["allowed-member"]}}});await login("scoped-editor");
   const edit=await call("/operations/commands","scoped-editor",e(member,"MemberUpdated",{name:"Changed",email:"",phone:"",address:{},preferences:{}},0));assert.equal(edit.status,403);assert.equal((await edit.json()).code,"MEMBER_SCOPE");
   const permit=await call("/operations/commands","scoped-editor",e(member,"PermissionVerified",{kind:"operations",validFrom:"2026-09-30",validUntil:"2026-10-30",evidenceDocumentId:randomUUID()},0));assert.equal(permit.status,403);assert.equal((await permit.json()).code,"MEMBER_SCOPE");
   assert.equal((await db.operationMember.findUniqueOrThrow({where:{id:member}})).name,"Fixture member");assert.equal(await db.memberPermission.count({where:{memberId:member}}),0);
  });
  await t.test("delivery-only documents use the same member scope on commands, replay and listings",async()=>{
   const document=randomUUID();await cmd(e(document,"DocumentReferenced",{deliveryId:delivery,kind:"transport-reference",sensitivity:"transport"}));
   const authorize=e(document,"DocumentAuthorized",{userId:"driver",deliveryId:delivery,expiresAt:new Date(Date.now()+3600000).toISOString(),evidence:{reference:"document-grant"}},1);
   const denied=await call("/operations/commands","scoped-editor",authorize);assert.equal(denied.status,403);assert.equal((await denied.json()).code,"MEMBER_SCOPE");assert.equal(await db.documentAuthorization.count({where:{documentId:document}}),0);
   await db.operationAccess.update({where:{userId:"scoped-editor"},data:{scope:{memberIds:[member]}}});
   const visible=await(await call("/operations/documents","scoped-editor")).json();assert.ok(visible.items.some((v:{id:string})=>v.id===document));
   await cmd(authorize,"scoped-editor");await db.operationAccess.update({where:{userId:"scoped-editor"},data:{scope:{memberIds:["allowed-member"]}}});
   const replay=await call("/operations/commands","scoped-editor",authorize);assert.equal(replay.status,403);assert.equal((await replay.json()).code,"MEMBER_SCOPE");
   assert.ok(!(await(await call("/operations/documents","scoped-editor")).json()).items.some((v:{id:string})=>v.id===document));
  });
  await t.test("account-scoped pending reviews require an explicit member or custodian scope",async()=>{
   await db.user.create({data:{id:"scoped-finance",name:"Scoped finance",email:"scoped-finance@test.local",password:pass,role:"admin"}});
   await db.operationAccess.create({data:{userId:"scoped-finance",profile:"finance",capabilities:profileCapabilities.finance,scope:{accountIds:["club"]}}});await login("scoped-finance");
   const pending=e(randomUUID(),"CollectionReported",{orderId:order,method:"cash",currency:"ARS",amountMinor:"100",evidence:{reference:"scoped-pending"}});await cmd(pending);
   const foreignMember="other-member",foreignOrder="other-order";await db.operationMember.create({data:{id:foreignMember,name:"Other fixture member",address:{},preferences:{}}});await db.operationOrder.create({data:{id:foreignOrder,memberId:foreignMember,channel:"local",currency:"ARS",commercialState:"confirmed",totalMinor:1000n,quote:{fixture:true},address:{},createdBy:"owner"}});await db.operationObject.create({data:{id:foreignOrder,kind:"order",version:0,createdBy:"owner"}});
   const hidden=e(randomUUID(),"CollectionReported",{orderId:foreignOrder,method:"cash",currency:"ARS",amountMinor:"10",evidence:{reference:"outside-member-scope"}});await cmd(hidden);
   const initial=await(await call("/operations/collections","scoped-finance")).json();assert.equal(initial.pendingScopeRequired,true);assert.ok(!initial.items.some((v:{id:string})=>v.id===pending.targetId));
   const decision=e(pending.targetId,"CollectionReportRejected",{reason:"Reported in error",evidence:{reference:"review"}},1);assert.equal((await call("/operations/commands","scoped-finance",decision)).status,403);
   await db.operationAccess.update({where:{userId:"scoped-finance"},data:{scope:{accountIds:["club"],memberIds:[member]}}});
   const visible=await(await call("/operations/collections","scoped-finance")).json();assert.equal(visible.pendingScopeRequired,false);assert.ok(visible.items.some((v:{id:string})=>v.id===pending.targetId));assert.ok(!visible.items.some((v:{id:string})=>v.id===hidden.targetId));
   const denied=await call("/operations/commands","scoped-finance",e(hidden.targetId,"CollectionReportRejected",{reason:"Outside scope",evidence:{reference:"review"}},1));assert.equal(denied.status,403);
   const before=await db.ledgerLeg.count();await cmd(decision,"scoped-finance");assert.equal(await db.ledgerLeg.count(),before);assert.equal((await db.collectionReport.findUniqueOrThrow({where:{id:pending.targetId}})).status,"rejected");
  });
  await t.test("canonical exports preserve exact values, unknowns, pages and current scopes",async()=>{
   const sourceSystem=`export-${randomUUID()}`,snapshotId=`export-${randomUUID()}`;
   await db.legacyImportSnapshot.create({data:{id:snapshotId,sourceSystem,filename:"synthetic.csv",fileHash:"4".repeat(64),importerVersion:"export-fixture",createdBy:"importer",reviewedBy:"finance",status:"reviewed",coverage:[],controls:{}}});
   await db.legacyHistoryPublication.create({data:{sourceSystem,snapshotId,fileHash:"4".repeat(64),mappingId:"export-mapping",fingerprint:"5".repeat(64),publishedBy:"owner",evidence:{reference:"fixture-independent-review"}}});
   for(const n of [1,2,3]){
    const id=`export-record-${snapshotId}-${n}`;
    await db.legacySourceRecord.create({data:{id,snapshotId,sourceTable:"ExportFixture",sourceKey:n===3?"=UNTRUSTED()":`key-${n}`,sourceRow:n,fileHash:"4".repeat(64),contentHash:"6".repeat(64),importerVersion:"export-fixture",original:{columns:[]},normalized:{columns:[]},treatment:"fact_candidate"}});
    await db.legacyHistoricalFact.create({data:{id:`export-fact-${id}`,snapshotId,sourceRecordId:id,sourceTable:"ExportFixture",sourceKey:n===3?"=UNTRUSTED()":`key-${n}`,sourceRow:n,sourceHash:"6".repeat(64),mappingId:"export-mapping",kind:"cash",dateState:"absent",currency:n===1?"USD":null,currencyState:n===1?"known":"absent",amountMinor:n===1?9007199254740993n:null,amountState:n===1?"known":"absent",quantityState:"absent",unitState:"absent",attributes:{},createdBy:"finance"}});
   }
   let cursor:string|null=null;let csv="";let pages=0;
   do{const response=await call(`/reports/operations/exports/history?limit=2${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`);assert.equal(response.status,200,await response.clone().text());assert.match(response.headers.get("cache-control")!,/no-store/);const block=await response.json();assert.ok(block.rows<=2);assert.equal(block.coverage.money,"exact-minor-unit-strings");csv+=block.csv;cursor=block.nextCursor;pages++;assert.ok(pages<20);}while(cursor);
   assert.ok(csv.includes('"9007199254740993"'));assert.ok(csv.includes('"USD","known"'));assert.ok(csv.includes('"absent"'));assert.ok(csv.includes("\"'=UNTRUSTED()\""));assert.ok(csv.includes(sourceSystem));assert.equal(csv.split(`export-fact-export-record-${snapshotId}-`).length-1,3);
   const first=await(await call("/reports/operations/exports/history?limit=1")).json();assert.ok(first.nextCursor);
   const tampered=JSON.parse(Buffer.from(first.nextCursor,"base64url").toString());if(typeof tampered.payload==="string")tampered.payload=JSON.stringify({...JSON.parse(tampered.payload),id:"zzzzzzzz"});else tampered.id="zzzzzzzz";
   const altered=await call(`/reports/operations/exports/history?limit=1&cursor=${encodeURIComponent(Buffer.from(JSON.stringify(tampered)).toString("base64url"))}`);assert.equal(altered.status,400);assert.equal((await altered.json()).code,"EXPORT_CURSOR");
   await db.legacyHistoryPublication.update({where:{sourceSystem},data:{fingerprint:"7".repeat(64)}});
   const changed=await call(`/reports/operations/exports/history?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`);assert.equal(changed.status,409);assert.equal((await changed.json()).code,"EXPORT_POPULATION_CHANGED");
   assert.equal((await call("/reports/operations/exports/ledger","driver")).status,403);
   const financeGrant=await db.operationAccess.findUniqueOrThrow({where:{userId:"finance"}});
   await db.operationAccess.update({where:{userId:"finance"},data:{scope:{accountIds:["bank"]}}});
   try{assert.equal((await call("/reports/operations/exports/history","finance")).status,403);const ledger=await call("/reports/operations/exports/ledger","finance");assert.equal(ledger.status,200);const block=await ledger.json();const rows=parseCsv(block.csv,{bom:true,columns:true,skip_empty_lines:true}) as Array<{accountId:string}>;assert.ok(rows.length>0);assert.ok(rows.every(row=>row.accountId==="bank"));}finally{await db.operationAccess.update({where:{userId:"finance"},data:{scope:financeGrant.scope??{}}});}
  });
  await t.test("stock histories and exports reject crossed endpoints and preserve signed quantities",async()=>{
   const skuId=`scoped-stock-${randomUUID()}`,lotId=`lot-${randomUUID()}`;
   await db.catalogSku.create({data:{id:skuId,code:skuId,name:"Scoped quantity",variety:"Fixture",category:"Fixture",unit:"g"}});
   await db.inventoryLot.create({data:{id:lotId,skuId,label:"Fixture",unit:"g",unitCost:"1",costCurrency:"ARS",receivedAt:new Date()}});
   const visible=randomUUID(),crossed=randomUUID(),foreign=randomUUID();
   for(const [id,fromLocationId,toLocationId,fromCustodianId,toCustodianId]of [[visible,"allowed",null,"custodian",null],[crossed,"allowed","foreign","foreign","custodian"],[foreign,"allowed","foreign","custodian","foreign"]]as const)
    await db.stockFact.create({data:{id,requestId:randomUUID(),lotId,kind:"count_adjustment",quantity:"-0.001",unit:"g",fromLocationId,toLocationId,fromCustodianId,toCustodianId,costMinor:-100n,currency:"ARS",reason:"Scoped fixture",actorId:"owner",occurredAt:new Date()}});
   const prior=await db.operationAccess.findUniqueOrThrow({where:{userId:"finance"}});
   await db.operationAccess.update({where:{userId:"finance"},data:{capabilities:[...prior.capabilities,"stock.read"],scope:{locationIds:["allowed"],custodianIds:["custodian"]}}});
   try{
    const response=await call(`/operations/catalog/${skuId}/history`,"finance");assert.equal(response.status,200);const history=await response.json();assert.deepEqual(history.items.map((item:{id:string})=>item.id),[visible]);
    const exported=await call('/reports/operations/exports/stock',"finance");assert.equal(exported.status,200);const block=await exported.json();
    const rows=parseCsv(block.csv,{bom:true,columns:true,skip_empty_lines:true})as Array<{id:string;quantity:string;amountMinor:string}>;
    const item=rows.find(row=>row.id===visible)!;assert.equal(item.quantity,"-0.001");assert.equal(item.amountMinor,"-100");assert.ok(!rows.some(row=>row.id===crossed||row.id===foreign));
   }finally{await db.operationAccess.update({where:{userId:"finance"},data:{capabilities:prior.capabilities,scope:prior.scope}});}
  });
  await t.test("negative numeric export fields remain exact while free text remains escaped",async()=>{
   const fact=await db.stockFact.findFirstOrThrow({where:{kind:"count_adjustment",quantity:{lt:0}}});
   const exported=await call('/reports/operations/exports/stock');assert.equal(exported.status,200);
   const block=await exported.json();const rows=parseCsv(block.csv,{bom:true,columns:true,skip_empty_lines:true})as Array<{id:string;quantity:string;amountMinor:string}>;
   const row=rows.find(item=>item.id===fact.id)!;assert.equal(row.quantity,fact.quantity.toString());assert.equal(row.amountMinor,fact.costMinor!.toString());
  });
  await t.test("malformed historical column payloads preserve invalid states and do not abort projection",async()=>{
   const {projectHistoricalRecord}=await import('../server/operations/legacy-history.js');
   const snapshotId=`malformed-${randomUUID()}`;
   await db.legacyImportSnapshot.create({data:{id:snapshotId,sourceSystem:snapshotId,filename:"fixture",fileHash:"8".repeat(64),importerVersion:"old",createdBy:"importer",coverage:[],controls:{}}});
   for(const [index,columns] of [{invalid:"old-shape"},[null,"bad",{header:"Monto",value:42}]].entries()){
    const record=await db.legacySourceRecord.create({data:{id:randomUUID(),snapshotId,sourceTable:"Malformed",sourceKey:randomUUID(),sourceRow:index+2,fileHash:"8".repeat(64),contentHash:"9".repeat(64),importerVersion:"old",original:{columns:[]},normalized:{columns},treatment:"fact_candidate"}});
    const fact=projectHistoricalRecord(record,{tables:[{table:"Malformed",kind:"cash",amountField:"Monto",dateField:null,quantityField:null,currencyField:null,unitField:null,defaultCurrency:"ARS",defaultUnit:null}]},"mapping","finance");
    assert.equal(fact.amountMinor,null);assert.equal(fact.amountState,"invalid");assert.equal(fact.currency,"ARS");assert.equal((fact.attributes as {payloadMalformed:boolean}).payloadMalformed,true);
   }
  });
  await t.test("current scopes protect commands, legacy views, documents and revoked sessions",async()=>{
   await db.operationAccess.update({where:{userId:"finance"},data:{scope:{accountIds:["bank"]}}});
   const list=await(await call("/operations/accounts","finance")).json();assert.deepEqual(list.items.map((a:{id:string})=>a.id),["bank"]);
   assert.equal((await call("/operations/accounts/club/ledger","finance")).status,403);
   assert.deepEqual((await(await call("/operations/collections","finance")).json()).items,[]);
   assert.deepEqual((await(await call("/operations/settlements","finance")).json()).items,[]);
   assert.equal((await call("/operations/commands","finance",e("club","AccountReconciled",{date:"2026-09-30",countedMinor:"0",evidence:{reference:"wrong-account"}},4))).status,403);
   assert.equal((await call("/views/finance","finance")).status,403);
   assert.equal((await call("/views/customers","driver")).status,403);
   assert.equal((await call(`/operations/members/${member}/clinical`,"owner")).status,403);
   const denied=await call("/operations/commands","finance",e("club","AccountTransferred",{toAccountId:"bank",amountMinor:"1",reason:"out of scope"},4));assert.equal(denied.status,403);
   await db.user.update({where:{id:"driver"},data:{active:false,authorizationEpoch:{increment:1}}});
   assert.equal((await call("/operations/context","driver")).status,401);
  });
 }finally{await new Promise<void>(r=>server.close(()=>r()));await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);await db.$disconnect();}
});
