import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash, createCipheriv, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import bcrypt from "bcryptjs";
import { splitSqlStatements } from "./migration-sql.js";
import { canonicalJson } from "../shared/operations/exact.js";
import type { CommandEnvelope } from "../shared/operations/contracts.js";

// Exercises integrated public commands; fixtures establish identities, supplier and location only.
test("purchase, physical delivery, debt, offline custody and recovery share one canonical circuit",{skip:!process.env.TEST_DATABASE_URL},async t=>{
 // Keep this multi-step HTTP journey on one civil day even when the runner crosses midnight.
 t.mock.timers.enable({apis:["Date"],now:new Date("2026-10-01T15:00:00-03:00")});
 const url=new URL(process.env.TEST_DATABASE_URL!);assert.ok(["127.0.0.1","localhost","[::1]"].includes(url.hostname));assert.match(url.pathname,/test|ci/i);
 const schema=`journey_${randomUUID().replaceAll("-","")}`;url.searchParams.set("schema",schema);
 process.env.DATABASE_URL=url.toString();process.env.DEMO_MODE="true";process.env.NODE_ENV="test";process.env.JWT_SECRET="journey-test-only-secret-more-than-32-characters";process.env.ALLOWED_ORIGIN="http://journey.local";
 const {db}=await import("../server/db.js");await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
 const root=new URL("../prisma/migrations/",import.meta.url);
 for(const f of(await readdir(root,{withFileTypes:true})).filter(f=>f.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name)))for(const sql of splitSqlStatements(await readFile(new URL(`${f.name}/migration.sql`,root),"utf8")))await db.$executeRawUnsafe(sql);
 const pass=await bcrypt.hash("Only-a-local-journey-123",4);
 for(const [id,role] of [["owner","owner"],["finance","admin"],["driver","viewer"],["clinical","viewer"],["stock","viewer"],["commercial","admin"]] as const)await db.user.create({data:{id,name:id,email:`${id}@journey.local`,password:pass,role}});
 const {profileCapabilities}=await import("../shared/operations/contracts.js");for(const id of ["finance","driver","clinical","stock","commercial"])await db.operationAccess.create({data:{userId:id,profile:id,capabilities:profileCapabilities[id]}});
 await db.supplier.create({data:{id:"supplier",name:"Synthetic supplier",key:"synthetic-supplier"}});await db.location.create({data:{id:"warehouse",name:"Synthetic warehouse",key:"synthetic-warehouse"}});
 const {app}=await import("../server/app.js");const server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api`;
 const cookies:Record<string,string>={},proof={reference:"synthetic-journey"},today=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Argentina/Buenos_Aires"}).format(new Date()),future=String(Number(today.slice(0,4))+1)+today.slice(4);
 async function call(path:string,actor="owner",body?:unknown){return fetch(base+path,{method:body?"POST":"GET",headers:{Cookie:cookies[actor],Origin:"http://journey.local","Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});}
 async function login(id:string){const r=await fetch(base+"/auth/login",{method:"POST",headers:{Origin:"http://journey.local","Content-Type":"application/json"},body:JSON.stringify({email:`${id}@journey.local`,password:"Only-a-local-journey-123"})});assert.equal(r.status,200);cookies[id]=r.headers.get("set-cookie")!.split(";")[0];}
 async function envelope(targetId:string,command:string,data:Record<string,unknown>):Promise<CommandEnvelope>{return {schemaVersion:1,requestId:randomUUID(),targetId,command,data,expectedVersion:(await db.operationObject.findUnique({where:{id:targetId}}))?.version??0,occurredAt:new Date().toISOString()};}
 async function cmd(target:string,name:string,data:Record<string,unknown>,actor="owner"){const r=await call("/operations/commands",actor,await envelope(target,name,data)),b=await r.json();assert.equal(r.status,200,JSON.stringify(b));return b;}
 async function privateEvidence(memberId:string,sensitivity="commercial",actor="owner"){
  const id=randomUUID();await cmd(id,"DocumentReferenced",{memberId,kind:"synthetic",sensitivity},actor);
  const bytes=Buffer.from("%PDF-1.4\n% Local synthetic evidence\n%%EOF"),checksum=createHash("sha256").update(bytes).digest("hex");
  const r=await call(`/operations/documents/${id}/upload`,actor,{contentBase64:bytes.toString("base64"),checksum,mediaType:"application/pdf"});const object=await r.json();assert.equal(r.status,200,JSON.stringify(object));await cmd(id,"DocumentMadeAvailable",object,actor);return id;
 }
 let lots:Array<{lotId:string;balanceId:string}>=[],deliveryId="",allocationId="",manifest:{leaseId:string;deviceId:string;assignments:Array<{id:string;version:number}>};
 try{
  for(const id of ["owner","finance","driver","clinical","stock","commercial"])await login(id);
  await cmd("cash","AccountCreated",{name:"Synthetic cash",currency:"ARS",kind:"cash",holder:"club",purpose:"test"});await cmd("cash","AccountVerified",{evidence:proof});await cmd("cash","AccountOpeningApproved",{amountMinor:"100000000",preparedBy:"finance",evidence:proof});
  await cmd("custody","AccountCreated",{name:"Synthetic courier",currency:"ARS",kind:"custody",holder:"driver",purpose:"test",custodianId:"driver"});await cmd("custody","AccountVerified",{evidence:proof});await cmd("custody","AccountOpeningApproved",{amountMinor:"0",preparedBy:"finance",evidence:proof});
  await cmd("member","MemberCreated",{name:"Synthetic member"});const doc=await privateEvidence("member");await cmd("member","PermissionVerified",{kind:"operations",validFrom:today,validUntil:future,evidenceDocumentId:doc});
  await t.test("clinical files remain private even to an owner; review uses actual available evidence",async()=>{
   const clinicalDoc=await privateEvidence("member","clinical","clinical");assert.equal((await call(`/operations/documents/${clinicalDoc}/content`)).status,403);assert.equal((await call(`/operations/documents/${clinicalDoc}/content`,"driver")).status,403);
   await cmd("member","ClinicalRecordReviewed",{status:"needs_information",evidenceDocumentId:clinicalDoc,evidence:proof},"clinical");const record=await(await call("/operations/members/member/clinical","clinical")).json();assert.equal(record.clinical.verification,"needs_information");assert.equal((await call("/operations/members/member/clinical")).status,403);
  });
  await t.test("commercial member data cannot store restricted clinical or credential fields",async()=>{
   const marker="Restricted-value-must-not-appear-in-responses";
   for(const preferences of [{notes:{diagnóstico:marker}},{api_key:marker},{allergies:[marker]},{symptoms:marker},{alergias:[marker]}]){
    const request=await envelope(randomUUID(),"MemberCreated",{name:"Forbidden field fixture",preferences});const r=await call("/operations/commands","commercial",request),body=await r.json();assert.equal(r.status,422);assert.equal(body.code,"COMMERCIAL_FIELDS_RESTRICTED");assert.equal(JSON.stringify(body).includes(marker),false);assert.equal(await db.operationMember.count({where:{id:request.targetId}}),0);assert.equal(await db.commandReceipt.count({where:{requestId:request.requestId}}),0);
   }
   const created=await cmd("commercial-member","MemberCreated",{name:"Commercial fixture",address:{street:"Synthetic street",number:"1"},preferences:{preferredChannel:"delivery",preferredCategories:["Test"]}},"commercial");assert.equal(created.result.member.preferences.preferredChannel,"delivery");
   const update=await call("/operations/commands","owner",await envelope("member","MemberUpdated",{name:"Synthetic member",email:"",phone:"",address:{details:{clinicalRecord:marker}},preferences:{}}));assert.equal(update.status,422);assert.deepEqual((await db.operationMember.findUniqueOrThrow({where:{id:"member"}})).address,{});
  });
  await t.test("an available document rejects a second upload before writing another private object",async()=>{
   const bytes=Buffer.from("%PDF-1.4\n% Replacement forbidden\n%%EOF"),checksum=createHash("sha256").update(bytes).digest("hex");
   const before=await db.operationDocument.findUniqueOrThrow({where:{id:doc}});
   const r=await call(`/operations/documents/${doc}/upload`,"owner",{contentBase64:bytes.toString("base64"),checksum,mediaType:"application/pdf"});assert.equal(r.status,409);assert.equal((await r.json()).code,"DOCUMENT_VERSION_FROZEN");
   const after=await db.operationDocument.findUniqueOrThrow({where:{id:doc}});assert.equal(after.objectKey,before.objectKey);assert.equal(after.checksum,before.checksum);assert.equal((await call(`/operations/documents/${doc}/content`)).status,200);
  });
  await t.test("document availability verifies immutable bytes and declared type before recording effects",async()=>{
   const id=randomUUID();await cmd(id,"DocumentReferenced",{memberId:"member",kind:"synthetic-type-check",sensitivity:"commercial"});
   const bytes=Buffer.from("%PDF-1.4\n% Type integrity regression\n%%EOF"),checksum=createHash("sha256").update(bytes).digest("hex");
   const uploadedResponse=await call(`/operations/documents/${id}/upload`,"owner",{contentBase64:bytes.toString("base64"),checksum,mediaType:"application/pdf"});assert.equal(uploadedResponse.status,200);const object=await uploadedResponse.json();
   const invalid=await envelope(id,"DocumentMadeAvailable",{...object,mediaType:"image/png"}),rejected=await call("/operations/commands","owner",invalid);assert.equal(rejected.status,422);assert.equal((await rejected.json()).code,"DOCUMENT_INTEGRITY");assert.equal((await db.operationDocument.findUniqueOrThrow({where:{id}})).state,"referenced");assert.equal(await db.commandReceipt.count({where:{requestId:invalid.requestId}}),0);
   const valid=await envelope(id,"DocumentMadeAvailable",object);const accepted=await call("/operations/commands","owner",valid);assert.equal(accepted.status,200);const replay=await call("/operations/commands","owner",valid);assert.equal(replay.status,200);assert.equal((await replay.json()).replay,true);assert.equal(await db.commandReceipt.count({where:{requestId:valid.requestId}}),1);
  });
  await cmd("sku","CatalogSkuCreated",{code:"SYN-1",name:"Synthetic SKU",variety:"Synthetic",category:"Test",unit:"g",minQuantity:"0",minVarieties:1,evidence:proof});
  await t.test("payment and reception are independent; repeated labels identify distinct lots",async()=>{
   await cmd("purchase","PurchaseOrderCreated",{supplierId:"supplier",agreementDate:today,currency:"ARS",items:[{lineId:"buy-line",skuId:"sku",unit:"g",quantity:"30",unitCost:"2000"}],evidence:proof},"stock");await cmd("purchase","PurchaseOrderApproved",{evidence:proof});
   await cmd("payable","PayableCreated",{purchaseId:"purchase",beneficiaryId:"supplier",kind:"purchase",currency:"ARS",amountMinor:"6000000",dueDate:today,evidence:proof});await cmd("payable","PayableVerified",{evidence:proof},"finance");await cmd("payable","PayablePaid",{accountId:"cash",amountMinor:"2000000",date:today,evidence:proof},"finance");assert.equal(await db.inventoryLot.count(),0);
   for(const id of ["receipt-1","receipt-2"]){const r=await cmd(id,"GoodsReceived",{purchaseId:"purchase",receivedDate:today,locationId:"warehouse",items:[{lineId:"buy-line",quantity:"15",lotLabel:"REPEATED-LABEL"}],evidence:proof});lots.push(r.result.lots[0]);}
   assert.notEqual(lots[0].lotId,lots[1].lotId);assert.equal((await db.operationPayable.findUniqueOrThrow({where:{id:"payable"}})).paidMinor,2000000n);assert.equal((await db.stockBalance.aggregate({_sum:{quantity:true}}))._sum.quantity!.toString(),"30");
   const excess=await call("/operations/commands","owner",await envelope("receipt-3","GoodsReceived",{purchaseId:"purchase",receivedDate:today,locationId:"warehouse",items:[{lineId:"buy-line",quantity:"1",lotLabel:"LATE"}],evidence:proof}));assert.equal(excess.status,409);assert.equal(await db.goodsReceipt.count(),2);
  });
  await cmd("limits","ConfigurationProposed",{name:"Synthetic limits",kind:"preparation_limits",version:1,validFrom:today,validUntil:future,definition:{maximumGramsPerOrder:"100",maximumExtraGramsPerLine:"0.1",maximumExtraBps:100,evidence:proof},evidence:proof});await cmd("limits","ConfigurationApproved",{evidence:proof});
  await cmd("order","OrderCreated",{memberId:"member",channel:"delivery",currency:"ARS"});await cmd("order","OrderQuoted",{currency:"ARS",paymentMethod:"cash",items:[{id:"line",skuId:"sku",quantity:"5",manualUnitPrice:"11000",manualReason:"Explicit synthetic quote"}]});const confirmed=await cmd("order","OrderConfirmed",{quoteVersion:1,acceptance:proof});deliveryId=confirmed.result.deliveryId;
  await t.test("reservation is durable and preparation uses real weight without changing the accepted price",async()=>{
   const reserved=await db.stockReservation.findFirstOrThrow({where:{orderId:"order",status:"active"}});lots.sort((a,b)=>a.balanceId===reserved.balanceId?-1:b.balanceId===reserved.balanceId?1:0);
   assert.equal((await db.stockBalance.findUniqueOrThrow({where:{id:lots[0].balanceId}})).reserved.toString(),"5");
   await cmd("order","OrderPrepared",{allocations:[{lineId:"line",lotId:lots[0].lotId,balanceId:lots[0].balanceId,requestedQuantity:"5",actualQuantity:"5"}],evidence:proof});
   const line=await db.operationOrderLine.findUniqueOrThrow({where:{id:"line"}});assert.equal(line.prepared.toString(),"5");assert.equal(line.revenueMinor,5500000n);assert.equal(line.costMinor,0n);assert.equal((await db.stockBalance.findUniqueOrThrow({where:{id:lots[0].balanceId}})).quantity.toString(),"10");allocationId=(await db.preparationAllocation.findFirstOrThrow({where:{orderId:"order"}})).id;
  });
  await cmd("route","RouteCreated",{driverId:"driver",shiftDate:today,custodianAccountId:"custody"});await cmd(deliveryId,"DeliveryAssigned",{routeId:"route",driverId:"driver",stopSequence:2,windowStart:"14:00",windowEnd:"18:00",eta:"14:30",evidence:proof});await cmd(deliveryId,"DeliveryDispatched",{evidence:proof});
  await t.test("transport documents freeze the real prepared quantity and replay their original receipt",async()=>{
   const templateId=`synthetic-transport-${randomUUID()}`;await cmd(templateId,"DocumentTemplateProposed",{version:1,kind:"transport",definition:{title:"Synthetic transport rehearsal",requiredFields:["memberName","driverId","physicalItems","generatedAt"],footer:"Fixture only; no professional approval claimed"}});await cmd(templateId,"DocumentTemplateApproved",{evidence:proof});
   const id=randomUUID(),request=await envelope(id,"TransportDocumentGenerated",{orderId:"order",deliveryId,templateId,transportistName:"Synthetic driver",vehiclePlate:"FIXTURE",origin:"Synthetic warehouse",destination:"Synthetic destination",evidence:proof});
   const response=await call("/operations/commands","owner",request);assert.equal(response.status,200,await response.clone().text());const document=await db.operationDocument.findUniqueOrThrow({where:{id}});assert.equal(document.templateVersion,1);assert.equal(document.state,"available");assert.equal((document.metadata as {physicalItems:Array<{quantity:string}>}).physicalItems[0]!.quantity,"5");
   const downloaded=await call(`/operations/documents/${id}/content`);assert.equal(downloaded.status,200);const bytes=Buffer.from(await downloaded.arrayBuffer());assert.equal(bytes.subarray(0,5).toString(),"%PDF-");assert.equal(createHash("sha256").update(bytes).digest("hex"),document.checksum);
   const replay=await call("/operations/commands","owner",request);assert.equal(replay.status,200);assert.equal((await replay.json()).replay,true);assert.equal(await db.operationDocument.count({where:{id}}),1);assert.equal(await db.commandReceipt.count({where:{requestId:request.requestId}}),1);
  });
  const deviceId=randomUUID();await cmd(deviceId,"DeviceRegistered",{name:"Synthetic browser fixture"},"driver");await cmd(deviceId,"DeviceCertified",{storageCertified:true,evidence:{reference:"synthetic-test-only-not-Android-certification"}});
  const manifestDocumentId=randomUUID(),documentBytes=Buffer.from("%PDF-1.4\n% Synthetic delivery evidence\n%%EOF"),documentChecksum=createHash("sha256").update(documentBytes).digest("hex");
  await cmd(manifestDocumentId,"DocumentReferenced",{deliveryId,kind:"transport",sensitivity:"transport",validUntil:future,metadata:{}});
  const uploadedResponse=await call(`/operations/documents/${manifestDocumentId}/upload`,"owner",{contentBase64:documentBytes.toString("base64"),checksum:documentChecksum,mediaType:"application/pdf"}),uploaded=await uploadedResponse.json();assert.equal(uploadedResponse.status,200,JSON.stringify(uploaded));
  await cmd(manifestDocumentId,"DocumentMadeAvailable",uploaded as Record<string,unknown>);
  const documentGrantExpiresAt=new Date(Date.now()+60*60_000).toISOString();await cmd(manifestDocumentId,"DocumentAuthorized",{userId:"driver",deliveryId,expiresAt:documentGrantExpiresAt,evidence:proof});
  const manifestResponse=await call(`/delivery/manifests/current?deviceId=${deviceId}`,"driver");assert.equal(manifestResponse.status,200,await manifestResponse.clone().text());const manifestBody=await manifestResponse.json() as {leaseId:string;deviceId:string;expiresAt:string;storageCertification:{persistent:boolean;storageCertifiedAt?:string};assignments:Array<{id:string;version:number;customerName:string;route?:{date:string;stop:number;eta?:string;etaIsEstimate:boolean};lines:Array<{name:string;requested:string;prepared:string;delivered:string;remaining:string}>;documents:Array<{id:string;sha256:string;byteLength:number;mimeType:string;version:string;url:string}>}>};manifest=manifestBody;assert.equal(manifest.assignments.length,1);assert.equal(canonicalJson(manifest).includes("clinical"),false);
  await t.test("offline manifest provides names, remaining quantities and verifiable authorized documents",async()=>{
   const assignment=manifestBody.assignments[0]!,manifestDocument=assignment.documents[0]!,deviceRecord=await db.operationDevice.findUniqueOrThrow({where:{id:deviceId}});
   assert.equal(assignment.customerName,"Synthetic member");assert.equal(assignment.lines[0]?.name,"Synthetic SKU");assert.deepEqual(assignment.route,{date:today,stop:3,eta:"14:30",etaIsEstimate:true});
   assert.deepEqual(assignment.lines[0],{id:"line",skuId:"sku",name:"Synthetic SKU",unit:"g",requested:"5",prepared:"5",delivered:"0",remaining:"5",actualQuantity:"5"});
   assert.equal(manifestDocument.id,manifestDocumentId);assert.equal(manifestDocument.sha256,documentChecksum);assert.equal(manifestDocument.byteLength,documentBytes.length);assert.equal(manifestDocument.mimeType,"application/pdf");assert.equal(manifestDocument.version,uploaded.version);assert.equal(manifestDocument.url,`/api/operations/documents/${manifestDocumentId}/content`);
   assert.equal(manifestBody.storageCertification.persistent,true);assert.equal(manifestBody.storageCertification.storageCertifiedAt??null,deviceRecord.storageCertifiedAt?.toISOString()??null);assert.notEqual(manifestBody.storageCertification.storageCertifiedAt,deviceRecord.createdAt.toISOString());
   const currentDeviceResponse=await call(`/delivery/devices/current?deviceId=${deviceId}`,"driver"),currentDevice=await currentDeviceResponse.json() as {device:{storageCertifiedAt:string|null}};assert.equal(currentDeviceResponse.status,200);assert.equal(currentDevice.device.storageCertifiedAt,deviceRecord.storageCertifiedAt?.toISOString()??null);
   assert.ok(Date.parse(manifestBody.expiresAt)<=Date.parse(documentGrantExpiresAt));
   const downloadedResponse=await call(manifestDocument.url.replace(/^\/api/,""),"driver"),downloaded=Buffer.from(await downloadedResponse.arrayBuffer());assert.equal(downloadedResponse.status,200);assert.equal(downloaded.length,manifestDocument.byteLength);assert.equal(createHash("sha256").update(downloaded).digest("hex"),manifestDocument.sha256);
  });
  let reportId="",acknowledgedEvent:CommandEnvelope;
  await t.test("ordered offline events replay without a second physical or financial effect",async()=>{
   reportId=randomUUID();const reported=await envelope(reportId,"CollectionReported",{orderId:"order",deliveryId,method:"cash",currency:"ARS",amountMinor:"5500000",custodianId:"driver",evidence:proof});
   acknowledgedEvent=reported;
   const delivered=await envelope(deliveryId,"DeliveryRecorded",{lines:[{lineId:"line",quantity:"2",actualQuantity:"2"}],evidence:proof});const incident={...await envelope(deliveryId,"DeliveryIncident",{kind:"absent",note:"Remaining quantity returns to club",evidence:proof}),expectedVersion:delivered.expectedVersion+1};
   const events=[{...incident,sequence:3,dependsOn:delivered.requestId},{...delivered,sequence:2,dependsOn:reported.requestId},{...reported,sequence:1,dependsOn:null}];
   const payload={leaseId:manifest.leaseId,deviceId,events};const sr=await call("/delivery/sync","driver",payload),result=await sr.json();assert.equal(sr.status,200);assert.deepEqual(result.results.map((r:{status:string})=>r.status),["accepted","accepted","accepted"]);
   const before=await db.stockFact.count(),again=await(await call("/delivery/sync","driver",payload)).json();assert.deepEqual(again.results.map((r:{status:string})=>r.status),["duplicate","duplicate","duplicate"]);assert.equal(await db.stockFact.count(),before);
   const deliveredLine=await db.operationOrderLine.findUniqueOrThrow({where:{id:"line"}});assert.equal(deliveredLine.delivered.toString(),"2");assert.equal(deliveredLine.prepared.toString(),"5");assert.equal(deliveredLine.costMinor,400000n);assert.equal((await db.operationOrder.findUniqueOrThrow({where:{id:"order"}})).verifiedMinor,0n);assert.equal(await db.ledgerEvent.count({where:{kind:"collection"}}),0);
   const refreshedResponse=await call(`/delivery/manifests/current?deviceId=${deviceId}`,"driver");assert.equal(refreshedResponse.status,200);const refreshed=await refreshedResponse.json() as typeof manifestBody;manifest=refreshed;
   const refreshedAssignment=refreshed.assignments.find((candidate)=>candidate.id===deliveryId);assert.ok(refreshedAssignment);assert.equal(refreshedAssignment.lines[0]?.requested,"5");assert.equal(refreshedAssignment.lines[0]?.delivered,"2");assert.equal(refreshedAssignment.lines[0]?.remaining,"3");assert.deepEqual(refreshedAssignment.route,{date:today,stop:3,eta:"14:30",etaIsEstimate:true});
   assert.equal((await db.deliveryAssignment.findUniqueOrThrow({where:{id:deliveryId}})).status,"partially_delivered");
   const stale=await envelope(deliveryId,"DeliveryIncident",{kind:"late",note:"Stale route window",evidence:proof});await cmd("route","RouteReordered",{deliveryIds:[deliveryId],evidence:proof});const conflicting=await(await call("/delivery/sync","driver",{leaseId:manifest.leaseId,deviceId,events:[{...stale,sequence:4}]})).json();assert.equal(conflicting.results[0].status,"conflict");
  });
  async function assertDeliveredContribution(revenue:string,cost:string,contribution:string){
   const r=await call(`/reports/operations/summary?area=product-contribution&from=${today}&to=${today}`);const b=await r.json();assert.equal(r.status,200,JSON.stringify(b));
   const m=b.summary.metrics;const amount=(items:Array<{currency:string;minor:string}>|null)=>items?.find(i=>i.currency==="ARS")?.minor;
   assert.equal(m.allocationCoverage.revenueExceptionLineCount,0);assert.equal(amount(m.revenueByCurrency),revenue);assert.equal(amount(m.actualAllocatedCostSoldByCurrency),cost);assert.equal(amount(m.grossContributionBeforeFixedCostsByCurrency),contribution);
  }
  async function assertRetainedRevenue(expected:string){
   const r=await call(`/reports/operations/summary?area=sales-revenue&from=${today}&to=${today}`);assert.equal(r.status,200);const m=(await r.json()).summary.metrics;
   assert.equal(m.revenueQuantityCoverage.invalidCount,0);assert.equal(m.revenueQuantityCoverage.queryComplete,true);
   assert.equal(m.operational.netProductRevenueByCurrency.find((row:{currency:string})=>row.currency==="ARS").minor,expected);
   assert.equal(m.operational.orderTotalByCurrency.find((row:{currency:string})=>row.currency==="ARS").minor,"5500000");
  }
  await t.test("contribution uses billed delivery revenue and real allocated weight without scaling twice",async()=>{
   await assertDeliveredContribution("2200000","400000","1800000");
   await assertRetainedRevenue("5500000");
  });
  await t.test("an undelivered return restores stock without reversing sold cost; partial refunds are bounded",async()=>{
   await cmd("order","OrderReturnInspected",{returns:[{lineId:"line",allocationId,quantity:"3",origin:"undelivered",disposition:"restock",evidence:proof}],evidence:proof});assert.equal((await db.operationOrderLine.findUniqueOrThrow({where:{id:"line"}})).costMinor,400000n);
   await assertDeliveredContribution("2200000","400000","1800000");
   await cmd("order","ReturnedFulfillmentCancelled",{lines:[{lineId:"line",quantity:"3"}],reason:"Inspected undelivered return",evidence:proof});
   await cmd(reportId,"CollectionVerified",{accountId:"custody",evidence:proof},"finance");await cmd("rendition","RenditionAccepted",{driverId:"driver",fromAccountId:"custody",toAccountId:"cash",grossMinor:"5500000",deliveredMinor:"5500000",mode:"gross",evidence:proof},"finance");
   const rejected=await call("/operations/commands","finance",await envelope("order","OrderRefunded",{accountId:"cash",amountMinor:"5500000",lines:[{lineId:"line",amountMinor:"5500000"}],reason:"Over refund",evidence:proof}));assert.equal(rejected.status,422);assert.equal((await db.operationOrder.findUniqueOrThrow({where:{id:"order"}})).refundedMinor,0n);
   await cmd("order","OrderRefunded",{accountId:"cash",amountMinor:"2750000",lines:[{lineId:"line",amountMinor:"2750000"}],reason:"Five billed grams cancelled",evidence:proof},"finance");
   await cmd("order","OrderReturnInspected",{returns:[{lineId:"line",allocationId,quantity:"1.007",origin:"customer",disposition:"restock",evidence:proof}],evidence:proof});assert.equal((await db.operationOrderLine.findUniqueOrThrow({where:{id:"line"}})).costMinor,198600n);
   await cmd("order","OrderRefunded",{accountId:"cash",amountMinor:"550000",lines:[{lineId:"line",amountMinor:"550000"}],reason:"One billed gram returned physically",evidence:proof},"finance");
   await assertDeliveredContribution("1092300","198600","893700");
   await assertRetainedRevenue("1092300");
   assert.equal((await db.operationOrder.findUniqueOrThrow({where:{id:"order"}})).refundedMinor,3300000n);assert.equal((await db.stockBalance.aggregate({_sum:{quantity:true}}))._sum.quantity!.toString(),"29.007");assert.equal(await db.ledgerEvent.count({where:{kind:"collection"}}),1);
  });
  await t.test("management contribution accrues the approved courier cost once even before payment",async()=>{
   await cmd("courier-fee","PayableCreated",{beneficiaryId:"driver",kind:"courier_fee",currency:"ARS",amountMinor:"10000",dueDate:today,accrualPeriod:today.slice(0,7),evidence:proof},"finance");
   await cmd("courier-fee","PayableVerified",{evidence:proof},"finance");
   async function management(){const r=await call(`/reports/operations/summary?area=product-contribution&from=${today}&to=${today}`);assert.equal(r.status,200);return (await r.json()).summary.metrics;}
   const before=await management();assert.equal(before.grossContributionBeforeFixedCostsByCurrency.find((row:{currency:string})=>row.currency==="ARS").minor,"893700");assert.equal(before.managementCoverage.arithmeticCompleteForObservedRecords,true);assert.equal(before.managementContributionBeforeFixedCostsByCurrency.find((row:{currency:string})=>row.currency==="ARS").minor,"883700");
   await cmd("variable-expense","PayableCreated",{beneficiaryId:"supplier",kind:"operating_expense",currency:"ARS",amountMinor:"1000",dueDate:today,accrualPeriod:today.slice(0,7),costTreatment:"variable",evidence:proof},"finance");
   assert.equal((await management()).managementContributionBeforeFixedCostsByCurrency,null);
   await cmd("variable-expense","PayableVerified",{evidence:proof},"finance");
   assert.equal((await db.operationPayable.findUniqueOrThrow({where:{id:"variable-expense"}})).evidence.costTreatment,"variable");
   const approved=await management();assert.equal(approved.managementContributionBeforeFixedCostsByCurrency.find((row:{currency:string})=>row.currency==="ARS").minor,"882700");
   await cmd("courier-fee","PayablePaid",{accountId:"cash",amountMinor:"10000",date:today,evidence:proof},"finance");
   const after=await management();assert.deepEqual(after.managementContributionBeforeFixedCostsByCurrency,approved.managementContributionBeforeFixedCostsByCurrency);
  });
  await t.test("waste, count differences and custody transfers remain distinct and independently reviewed",async()=>{
   const balance=await db.stockBalance.findUniqueOrThrow({where:{id:lots[0].balanceId}}),initial=balance.quantity;
   await cmd("count-1","StockCountRecorded",{balanceId:balance.id,countedQuantity:initial.sub("0.002").toString(),evidence:proof},"stock");assert.equal((await db.stockBalance.findUniqueOrThrow({where:{id:balance.id}})).quantity.toString(),initial.toString());
   await cmd("waste","StockWasteRecorded",{balanceId:balance.id,quantity:"0.001",reason:"Physically inspected waste",evidence:proof},"stock");
   const stale=await call("/operations/commands","owner",await envelope("count-1","StockCountAdjustmentApproved",{reason:"Old count",evidence:proof}));assert.equal(stale.status,409);
   await cmd("count-2","StockCountRecorded",{balanceId:balance.id,countedQuantity:initial.sub("0.002").toString(),evidence:proof},"stock");await cmd("count-2","StockCountAdjustmentApproved",{reason:"Independent count reconciliation",evidence:proof});
   await db.location.create({data:{id:"other-location",name:"Synthetic second location",key:"synthetic-second"}});
   const before=(await db.stockBalance.aggregate({_sum:{quantity:true}}))._sum.quantity!.toString();await cmd("stock-move","StockMoved",{balanceId:balance.id,quantity:"0.001",toLocationId:"other-location",toCustodianId:"finance",reason:"Documented custody handoff",evidence:proof},"stock");
   assert.equal((await db.stockBalance.aggregate({_sum:{quantity:true}}))._sum.quantity!.toString(),before);assert.equal(await db.stockFact.count({where:{kind:"waste"}}),1);assert.equal(await db.stockFact.count({where:{kind:"count_adjustment"}}),1);
  });
  await t.test("verified receipt corrections reverse the exact entry and retire its unused excess credit",async()=>{
   await cmd("correction-order","OrderCreated",{memberId:"member",channel:"local",currency:"ARS"});await cmd("correction-order","OrderQuoted",{currency:"ARS",paymentMethod:"cash",items:[{id:"correction-line",skuId:"sku",quantity:"1",manualUnitPrice:"100",manualReason:"Synthetic correction fixture"}]});await cmd("correction-order","OrderConfirmed",{quoteVersion:1,acceptance:proof});
   await cmd("corrected-collection","CollectionReported",{orderId:"correction-order",method:"cash",currency:"ARS",amountMinor:"15000",evidence:proof});const balanceBefore=(await db.ledgerLeg.aggregate({where:{accountId:"cash"},_sum:{amountMinor:true}}))._sum.amountMinor!;
   const verified=await cmd("corrected-collection","CollectionVerified",{accountId:"cash",evidence:proof},"finance"),creditId=verified.result.creditId;assert.equal(verified.result.excessMinor,"5000");
   const correction=await envelope("corrected-collection","CollectionVerificationReversed",{reason:"Actual receipt was incorrectly attributed",evidence:proof}),first=await call("/operations/commands","finance",correction);assert.equal(first.status,200);const again=await(await call("/operations/commands","finance",correction)).json();assert.equal(again.replay,true);
   assert.equal((await db.ledgerLeg.aggregate({where:{accountId:"cash"},_sum:{amountMinor:true}}))._sum.amountMinor!,balanceBefore);assert.equal((await db.operationOrder.findUniqueOrThrow({where:{id:"correction-order"}})).verifiedMinor,0n);
   const invalidCredit=await call("/operations/commands","finance",await envelope(creditId,"MemberCreditRefunded",{accountId:"cash",amountMinor:"1",evidence:proof}));assert.equal(invalidCredit.status,409);assert.equal(await db.ledgerEvent.count({where:{kind:"collection_reversal"}}),1);await cmd("correction-order","OrderCancelled",{reason:"Synthetic case completed",evidence:proof});
  });
  await t.test("concurrent confirmation cannot reserve the last item twice",async()=>{
   await cmd("last-sku","CatalogSkuCreated",{code:"SYN-LAST",name:"Last synthetic item",variety:"Synthetic",category:"Test",unit:"ud",evidence:proof});await cmd("last-lot","StockOpeningRecorded",{skuId:"last-sku",label:"LAST",quantity:"1",unitCost:"1",costCurrency:"ARS",receivedDate:today,locationId:"warehouse",preparedBy:"stock",evidence:proof});
   for(const id of ["last-order-a","last-order-b"]){await cmd(id,"OrderCreated",{memberId:"member",channel:"local",currency:"ARS"});await cmd(id,"OrderQuoted",{currency:"ARS",paymentMethod:"cash",items:[{id:`${id}-line`,skuId:"last-sku",quantity:"1",manualUnitPrice:"100",manualReason:"Last-item concurrency fixture"}]});}
   const a=await envelope("last-order-a","OrderConfirmed",{quoteVersion:1,acceptance:proof}),b=await envelope("last-order-b","OrderConfirmed",{quoteVersion:1,acceptance:proof}),outcomes=await Promise.all([call("/operations/commands","owner",a),call("/operations/commands","owner",b)]);assert.deepEqual(outcomes.map(r=>r.status).sort(),[200,409]);assert.equal((await db.stockBalance.findFirstOrThrow({where:{lotId:"last-lot"}})).reserved.toString(),"1");
  });
  await t.test("repeated packs aggregate physical demand and freeze exact discount residues; a completed task never approves a promotion",async()=>{
   await cmd("pack","PackProposed",{name:"Synthetic repeated pack",version:1,currency:"ARS",priceMinor:"599",components:[{id:"b",skuId:"sku",quantity:"3",unit:"g",referenceMinor:"300"},{id:"a",skuId:"sku",quantity:"3",unit:"g",referenceMinor:"300"}],validFrom:today,validUntil:future});await cmd("pack","PackApproved",{evidence:proof});
   await cmd("promo","PromotionProposed",{name:"Synthetic promo",version:1,validFrom:today,validUntil:future,definition:{packId:"pack",eligibility:{},description:"Explicit pack version",evidence:proof}});await cmd("promo-task","TaskCreated",{title:"Propose pack promotion",responsibleId:"owner",dueDate:today,links:{promotionId:"promo"}});await cmd("promo-task","TaskCompleted",{evidence:proof});assert.equal((await db.commercialPromotion.findUniqueOrThrow({where:{id:"promo"}})).status,"draft");await cmd("promo","PromotionApproved",{evidence:proof});
   await cmd("pack-order","OrderCreated",{memberId:"member",channel:"local",currency:"ARS"});const quoteInput={currency:"ARS",paymentMethod:"cash",packs:[{id:"repeat-one",packId:"pack",count:1},{id:"repeat-two",packId:"pack",count:1}],promotionId:"promo"};
   const quote=await cmd("pack-order","OrderQuoted",quoteInput);assert.equal(quote.result.quote.totalMinor,"1198");assert.equal(quote.result.quote.discountMinor,"2");assert.equal(quote.result.quote.lines.reduce((n:bigint,l:{revenueMinor:string})=>n+BigInt(l.revenueMinor),0n),1198n);
   await cmd("pack-order","OrderConfirmed",{quoteVersion:1,acceptance:proof});assert.equal((await db.stockReservation.aggregate({where:{orderId:"pack-order",status:"active"},_sum:{quantity:true}}))._sum.quantity!.toString(),"12");
   const frozen=await call("/operations/commands","owner",await envelope("pack-order","OrderQuoted",quoteInput));assert.equal(frozen.status,409);assert.equal((await frozen.json()).code,"CONFIRMED_QUOTE_FROZEN");await cmd("pack-order","OrderCancelled",{reason:"Synthetic reservation released",evidence:proof});assert.equal(await db.stockReservation.count({where:{orderId:"pack-order",status:"active"}}),0);
  });
  await t.test("an ambiguous tariff needs an explicit scale and separates product and delivery surcharges",async()=>{
   await cmd("policy","PricePolicyProposed",{name:"Synthetic policy",version:1,currency:"ARS",validFrom:today,validUntil:future,definition:{tiers:[{skuId:"sku",minQuantity:"1",unitPrice:"5500",scale:"one"},{skuId:"sku",minQuantity:"5",unitPrice:"5000",scale:"five"}],paymentMethods:["cash"],automaticScaleVerified:false,productSurchargeBps:500,deliverySurchargeBps:500,evidence:proof}});await cmd("policy","PricePolicyApproved",{evidence:proof});
   await cmd("tariff-order","OrderCreated",{memberId:"member",channel:"local",currency:"ARS"});const data={currency:"ARS",paymentMethod:"cash",items:[{id:"tariff-line",skuId:"sku",quantity:"1",policyId:"policy"}],deliveryMinor:"20000",deliveryPolicyEvidence:proof};
   const ambiguous=await call("/operations/commands","owner",await envelope("tariff-order","OrderQuoted",data));assert.equal(ambiguous.status,422);assert.equal((await ambiguous.json()).code,"SCALE_APPROVAL_REQUIRED");
   const explicit=await cmd("tariff-order","OrderQuoted",{...data,items:[{...data.items[0],scale:"one"}]});assert.equal(explicit.result.quote.productSurchargeMinor,"27500");assert.equal(explicit.result.quote.deliverySurchargeMinor,"1000");assert.equal(explicit.result.quote.totalMinor,"598500");assert.equal(explicit.result.quote.lines[0].policyVersion,1);
   assert.equal((await call("/operations/commands","owner",await envelope("policy","PricePolicyApproved",{evidence:proof}))).status,409);
  });
  await t.test("commercial cannot obtain a free manual quote without an owner-approved bonus",async()=>{
   await cmd("manual-zero-order","OrderCreated",{memberId:"member",channel:"local",currency:"ARS"},"commercial");
   const quote={currency:"ARS",paymentMethod:"cash",items:[{id:"manual-zero-line",skuId:"sku",quantity:"1",manualUnitPrice:"0",manualReason:"Unapproved free product"}]};
   for(const manualUnitPrice of ["0","0.0001"]){const request=await envelope("manual-zero-order","OrderQuoted",{...quote,items:[{...quote.items[0],manualUnitPrice}]});const response=await call("/operations/commands","commercial",request);assert.equal(response.status,422);assert.equal((await response.json()).code,"MANUAL_PRICE_POSITIVE");assert.equal(await db.commandReceipt.count({where:{requestId:request.requestId}}),0);}
   assert.equal((await db.operationOrder.findUniqueOrThrow({where:{id:"manual-zero-order"}})).quoteVersion,0);
   const approvedQuote={...quote,items:[{...quote.items[0],manualUnitPrice:"100"}],bonusDiscountMinor:"10000",bonusReason:"Owner explicitly approves the free product"};
   assert.equal((await call("/operations/commands","commercial",await envelope("manual-zero-order","OrderQuoted",approvedQuote))).status,403);
   const approved=await cmd("manual-zero-order","OrderQuoted",approvedQuote);assert.equal(approved.result.quote.totalMinor,"0");assert.equal(approved.result.quote.bonusApplication.resolvedBy,"owner");
  });
  await t.test("repeated scale names per SKU cannot be proposed, approved or selected from historical policies",async()=>{
   const definition={tiers:[{skuId:"sku",minQuantity:"1",unitPrice:"100",scale:"repeated"},{skuId:"sku",minQuantity:"5",unitPrice:"50",scale:"repeated"}],paymentMethods:["cash"],automaticScaleVerified:false,evidence:proof};
   const proposal=await envelope("duplicate-scales","PricePolicyProposed",{name:"Ambiguous scales",version:1,currency:"ARS",validFrom:today,definition});const response=await call("/operations/commands","commercial",proposal);assert.equal(response.status,400);assert.equal(await db.pricePolicy.count({where:{id:proposal.targetId}}),0);assert.equal(await db.commandReceipt.count({where:{requestId:proposal.requestId}}),0);
   // A legacy draft bypasses the new proposal validator; approval and use must still reject it.
   await db.operationObject.create({data:{id:"historical-ambiguous-policy",kind:"pricePolicy",version:1,createdBy:"owner"}});await db.pricePolicy.create({data:{id:"historical-ambiguous-policy",name:"Historical ambiguous definition",version:1,currency:"ARS",validFrom:today,definition,proposedBy:"owner"}});
   const approval=await call("/operations/commands","owner",await envelope("historical-ambiguous-policy","PricePolicyApproved",{evidence:proof}));assert.equal(approval.status,422);assert.equal((await approval.json()).code,"POLICY_DEFINITION_INVALID");
   await db.pricePolicy.update({where:{id:"historical-ambiguous-policy"},data:{status:"approved"}});
   await cmd("ambiguous-policy-order","OrderCreated",{memberId:"member",channel:"local",currency:"ARS"});const quote=await call("/operations/commands","owner",await envelope("ambiguous-policy-order","OrderQuoted",{currency:"ARS",paymentMethod:"cash",items:[{id:"ambiguous-policy-line",skuId:"sku",quantity:"5",policyId:"historical-ambiguous-policy",scale:"repeated"}]}));assert.equal(quote.status,422);assert.equal((await quote.json()).code,"POLICY_DEFINITION_INVALID");assert.equal((await db.operationOrder.findUniqueOrThrow({where:{id:"ambiguous-policy-order"}})).quoteVersion,0);
  });
  await t.test("FX keeps both actual currencies and fees; partial cross-currency payments need a rate and replay exactly",async()=>{
   await cmd("usd","AccountCreated",{name:"Synthetic USD",currency:"USD",kind:"cash",holder:"club",purpose:"FX test"});await cmd("usd","AccountVerified",{evidence:proof});await cmd("usd","AccountOpeningApproved",{amountMinor:"100000",preparedBy:"finance",evidence:proof});
   const beforeCash=(await db.ledgerLeg.aggregate({where:{accountId:"cash"},_sum:{amountMinor:true}}))._sum.amountMinor!;
   const invalid=await call("/operations/commands","finance",await envelope("invalid-fx","ForeignExchangeRecorded",{fromAccountId:"usd",toAccountId:"cash",fromMinor:"10000",rate:"1500",evidence:proof}));assert.equal(invalid.status,400);assert.equal(await db.ledgerEvent.count({where:{kind:"fx"}}),0);
   const fx=await envelope("fx","ForeignExchangeRecorded",{fromAccountId:"usd",toAccountId:"cash",fromMinor:"10000",toMinor:"15000000",rate:"1500",commissionMinor:"500",commissionAccountId:"cash",evidence:proof});const unexplained=await call("/operations/commands","finance",await envelope("fx-unexplained","ForeignExchangeRecorded",{...fx.data,toMinor:"15000001"}));assert.equal(unexplained.status,422);assert.equal((await unexplained.json()).code,"FX_DIFFERENCE_UNRESOLVED");await cmd("fx-unresolved","ForeignExchangeRecorded",{...fx.data,toMinor:"15000001",evidence:{...proof,differenceReason:"Actual rate settlement differs by one cent"}},"finance");
   const result=await call("/operations/commands","finance",fx);assert.equal(result.status,200);assert.equal((await(await call("/operations/commands","finance",fx)).json()).replay,true);
   assert.equal((await db.ledgerLeg.aggregate({where:{accountId:"usd"},_sum:{amountMinor:true}}))._sum.amountMinor,80000n);assert.equal((await db.ledgerLeg.aggregate({where:{accountId:"cash"},_sum:{amountMinor:true}}))._sum.amountMinor,beforeCash+29999001n);
   const event=await db.ledgerEvent.findFirstOrThrow({where:{requestId:fx.requestId}});const legs=await db.ledgerLeg.findMany({where:{eventId:event.id}});assert.equal(legs.length,3);assert.deepEqual([...new Set(legs.map(l=>l.currency))].sort(),["ARS","USD"]);
   await cmd("fx-payable","PayableCreated",{beneficiaryId:"supplier",kind:"purchase",currency:"ARS",amountMinor:"3000000",dueDate:today,evidence:proof});await cmd("fx-payable","PayableVerified",{evidence:proof},"finance");
   const missingRate=await call("/operations/commands","finance",await envelope("fx-payable","PayablePaid",{accountId:"usd",amountMinor:"1000",date:today,evidence:proof}));assert.equal(missingRate.status,422);assert.equal((await missingRate.json()).code,"CROSS_CURRENCY_RATE");
   const payment=await envelope("fx-payable","PayablePaid",{accountId:"usd",amountMinor:"1000",exchangeRate:"1500",date:today,evidence:proof});assert.equal((await call("/operations/commands","finance",payment)).status,200);assert.equal((await(await call("/operations/commands","finance",payment)).json()).replay,true);assert.equal((await db.operationPayable.findUniqueOrThrow({where:{id:"fx-payable"}})).paidMinor,1500000n);
   await cmd("fx-payable","PayablePaid",{accountId:"usd",amountMinor:"1000",exchangeRate:"1500",date:today,evidence:proof},"finance");assert.equal((await db.operationPayable.findUniqueOrThrow({where:{id:"fx-payable"}})).paidMinor,3000000n);assert.equal((await db.ledgerLeg.aggregate({where:{accountId:"usd"},_sum:{amountMinor:true}}))._sum.amountMinor,78000n);
  });
  await t.test("approved segment benefits and owner bonuses freeze exact per-line discounts with explicit eligibility",async()=>{
   await cmd("benefit-policy","PricePolicyProposed",{name:"Synthetic approved benefit",version:1,currency:"ARS",validFrom:today,validUntil:future,definition:{tiers:[{skuId:"sku",minQuantity:"1",unitPrice:"0.03",scale:"explicit"}],paymentMethods:["cash"],automaticScaleVerified:false,segmentBenefits:{frequent:"1"},evidence:proof}});
   await cmd("benefit-policy","PricePolicyApproved",{evidence:proof});await cmd("benefit-order","OrderCreated",{memberId:"member",channel:"local",currency:"ARS"});
   const data={currency:"ARS",paymentMethod:"cash",items:["benefit-c","benefit-a","benefit-b"].map(id=>({id,skuId:"sku",quantity:"1",policyId:"benefit-policy",scale:"explicit"})),bonusDiscountMinor:"1",bonusReason:"Approved synthetic goodwill",segmentBenefit:{policyId:"benefit-policy",segment:"frequent",eligibilityEvidence:proof}};
   const request=await envelope("benefit-order","OrderQuoted",data);const quoted=await call("/operations/commands","owner",request);assert.equal(quoted.status,200);const quote=(await quoted.json()).result.quote;
   assert.equal(quote.subtotalMinor,"9");assert.equal(quote.discountMinor,"2");assert.equal(quote.totalMinor,"7");assert.equal(quote.segmentBenefitApplication.amountMinor,"1");assert.equal(quote.bonusApplication.amountMinor,"1");
   const lines=await db.operationOrderLine.findMany({where:{orderId:"benefit-order"},orderBy:{id:"asc"}});assert.deepEqual(lines.map(l=>[l.id,l.discountMinor.toString(),l.revenueMinor.toString()]),[["benefit-a","1","2"],["benefit-b","1","2"],["benefit-c","0","3"]]);
   assert.equal((await(await call("/operations/commands","owner",request)).json()).replay,true);
   const missing=await call("/operations/commands","owner",await envelope("benefit-order","OrderQuoted",{...data,bonusReason:undefined}));assert.equal(missing.status,422);assert.equal((await missing.json()).code,"BONUS_REASON_REQUIRED");
   const notConfigured=await call("/operations/commands","owner",await envelope("benefit-order","OrderQuoted",{...data,segmentBenefit:{...data.segmentBenefit,segment:"unapproved"}}));assert.equal(notConfigured.status,422);
   await cmd(randomUUID(),"AccessGranted",{userId:"finance",profile:"commercial"});await login("finance");assert.equal((await call("/operations/commands","finance",await envelope("benefit-order","OrderQuoted",data))).status,403);
   await cmd(randomUUID(),"AccessGranted",{userId:"finance",profile:"finance"});await login("finance");
   assert.equal((await db.operationOrder.findUniqueOrThrow({where:{id:"benefit-order"}})).totalMinor,7n);
   await cmd("benefit-order","OrderConfirmed",{quoteVersion:1,acceptance:proof},"commercial");
   const frozen=(await db.operationOrder.findUniqueOrThrow({where:{id:"benefit-order"}})).quote as Record<string,unknown>;
   assert.equal(frozen.quotedBy,"owner");assert.equal(frozen.confirmedBy,"commercial");assert.deepEqual(frozen.bonusApplication,quote.bonusApplication);assert.deepEqual(frozen.segmentBenefitApplication,quote.segmentBenefitApplication);assert.equal(frozen.totalMinor,"7");
  });
  await t.test("owner contributions fund club accounts without creating sales, debt or courier custody",async()=>{
   const before={balance:(await db.ledgerLeg.aggregate({where:{accountId:"cash"},_sum:{amountMinor:true}}))._sum.amountMinor!,orders:await db.operationOrder.count(),collections:await db.collectionReport.count(),stock:await db.stockFact.count()};
   const contribution=await envelope("owner-funding","OwnerContributionRecorded",{accountId:"cash",amountMinor:"4300000000",contributor:"Synthetic owner",evidence:proof});
   const response=await call("/operations/commands","finance",contribution);assert.equal(response.status,200);assert.equal((await response.json()).result.effect,"owner_funding_only");
   assert.equal((await(await call("/operations/commands","finance",contribution)).json()).replay,true);
   assert.equal((await db.ledgerLeg.aggregate({where:{accountId:"cash"},_sum:{amountMinor:true}}))._sum.amountMinor,before.balance+4300000000n);
   assert.equal(await db.ledgerEvent.count({where:{kind:"owner_contribution"}}),1);
   assert.deepEqual([await db.operationOrder.count(),await db.collectionReport.count(),await db.stockFact.count()],[before.orders,before.collections,before.stock]);
   const custody=await call("/operations/commands","finance",await envelope("bad-funding","OwnerContributionRecorded",{...contribution.data,accountId:"custody"}));assert.equal(custody.status,422);assert.equal((await custody.json()).code,"CONTRIBUTION_CLUB_ACCOUNT");
   assert.equal((await call("/operations/commands","stock",await envelope("forbidden-funding","OwnerContributionRecorded",contribution.data))).status,403);
  });
  await t.test("outbox retries only refresh read notifications and never replay ledger or stock",async()=>{
   const before=[await db.ledgerEvent.count(),await db.stockFact.count(),await db.commandReceipt.count()];const {processOperationOutbox}=await import("../server/operations/outbox.js");await processOperationOutbox(200);await processOperationOutbox(200);assert.deepEqual([await db.ledgerEvent.count(),await db.stockFact.count(),await db.commandReceipt.count()],before);assert.equal(await db.operationOutbox.count({where:{status:"pending"}}),0);
  });
  await t.test("revocation quarantines every event and still accepts a durable encrypted backup without restoring authority",async()=>{
   const pending=await envelope(deliveryId,"DeliveryIncident",{kind:"other",note:"Captured but not yet synchronized",evidence:proof});const unallowed=await envelope(randomUUID(),"ForeignExchangeRecorded",{untrusted:true});const missing=await envelope(randomUUID(),"CollectionReported",{orderId:"order",deliveryId,method:"cash",currency:"ARS",amountMinor:"1",custodianId:"driver",evidence:proof});
   const ledgerCount=await db.ledgerEvent.count();await cmd(randomUUID(),"AccessRevoked",{userId:"driver",reason:"Synthetic revocation test"});assert.equal((await call(`/delivery/manifests/current?deviceId=${deviceId}`,"driver")).status,401);
   const r=await call("/delivery/sync","driver",{leaseId:manifest.leaseId,deviceId,events:[{...pending,sequence:1},{...unallowed,sequence:2},{...missing,sequence:3},{...acknowledgedEvent,sequence:4}]}),body=await r.json();assert.equal(r.status,200);assert.deepEqual(body.results.map((v:{status:string})=>v.status),["quarantined","quarantined","quarantined","quarantined"]);assert.equal(body.results[3].alreadyCommitted,true);assert.equal("result" in body.results[3],false);assert.equal(await db.offlineQuarantine.count(),4);assert.equal(await db.ledgerEvent.count(),ledgerCount);
   const changed=await call("/delivery/sync","driver",{leaseId:manifest.leaseId,deviceId,events:[{...acknowledgedEvent,data:{...acknowledgedEvent.data,amountMinor:"1"}}]});assert.equal((await changed.json()).results[0].code,"IDEMPOTENCY_KEY_REUSED");
   const other=await call("/delivery/sync","finance",{leaseId:manifest.leaseId,deviceId,events:[acknowledgedEvent]});assert.equal((await other.json()).results[0].code,"COMMAND_ACTOR_MISMATCH");assert.equal(await db.offlineQuarantine.count(),4);
   const encrypt=(text:string)=>{const iv=randomBytes(12),key=randomBytes(32),c=createCipheriv("aes-256-gcm",key,iv),bytes=Buffer.concat([c.update(text),c.final(),c.getAuthTag()]);key.fill(0);return {algorithm:"AES-256-GCM",iv:iv.toString("base64"),ciphertext:bytes.toString("base64")};};
   const packageData={schemaVersion:1,userId:"driver",sourceDeviceId:deviceId,queuePayload:encrypt(JSON.stringify([pending,unallowed,missing])),documentsPayload:encrypt("{}")},sha256=createHash("sha256").update(canonicalJson(packageData)).digest("hex");
   const backup=await call("/delivery/backups","driver",{leaseId:manifest.leaseId,deviceId,package:packageData,sha256}),ack=await backup.json();assert.equal(backup.status,200);assert.equal(ack.durable,true);const repeat=await(await call("/delivery/backups","driver",{leaseId:manifest.leaseId,deviceId,package:packageData,sha256})).json();assert.equal(repeat.backupId,ack.backupId);assert.equal(await db.offlineBackup.count(),1);assert.equal(await db.commandReceipt.count({where:{requestId:pending.requestId}}),0);
   const wrong=await call("/operations/commands","owner",await envelope(randomUUID(),"QuarantineResolved",{originalRequestId:acknowledgedEvent.requestId,resolutionRequestId:randomUUID(),reason:"Must not duplicate an accepted capture",evidence:proof}));assert.equal(wrong.status,422);
   await cmd(randomUUID(),"QuarantineResolved",{originalRequestId:acknowledgedEvent.requestId,resolutionRequestId:acknowledgedEvent.requestId,reason:"Original receipt independently checked",evidence:proof});
   assert.equal((await db.offlineQuarantine.findUniqueOrThrow({where:{requestId:acknowledgedEvent.requestId}})).resolutionRequestId,acknowledgedEvent.requestId);assert.equal(await db.ledgerEvent.count(),ledgerCount);
  });
  await t.test("quarantine cannot be cleared with an earlier receipt of the same command and object",async()=>{
   await cmd(randomUUID(),"AccessGranted",{userId:"owner",profile:"owner",additional:["delivery.report"]});await login("owner");
   const earlier=await cmd(deliveryId,"DeliveryIncident",{kind:"other",note:"An earlier unrelated authorized fact",evidence:proof});
   const quarantined=await envelope(deliveryId,"DeliveryIncident",{kind:"other",note:"A newly recovered capture",evidence:proof});
   const sync=await call("/delivery/sync","driver",{leaseId:manifest.leaseId,deviceId,events:[{...quarantined,sequence:1}]});assert.equal((await sync.json()).results[0].status,"quarantined");
   const rejected=await call("/operations/commands","owner",await envelope(randomUUID(),"QuarantineResolved",{originalRequestId:quarantined.requestId,resolutionRequestId:earlier.requestId,reason:"Invalid old receipt",evidence:proof}));assert.equal(rejected.status,422);assert.equal((await rejected.json()).code,"NEW_AUTHORIZED_COMMAND_REQUIRED");assert.equal((await db.offlineQuarantine.findUniqueOrThrow({where:{requestId:quarantined.requestId}})).resolutionRequestId,null);
   const authorized=await cmd(deliveryId,"DeliveryIncident",{kind:"other",note:"Reviewed recovered capture",evidence:proof});await cmd(randomUUID(),"QuarantineResolved",{originalRequestId:quarantined.requestId,resolutionRequestId:authorized.requestId,reason:"Independent review applied a new authorized fact",evidence:proof});
   const retained=await db.offlineQuarantine.findUniqueOrThrow({where:{requestId:quarantined.requestId}});assert.equal(retained.resolutionRequestId,authorized.requestId);assert.equal((retained.envelope as {requestId:string}).requestId,quarantined.requestId);
  });
 }finally{await new Promise<void>(r=>server.close(()=>r()));await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);await db.$disconnect();}
});
