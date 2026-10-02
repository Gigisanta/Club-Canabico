import "dotenv/config";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { db } from "../server/db.js";
import { executeCommand } from "../server/operations/core.js";
import "../server/operations/routes.js";
import "../server/operations/documents.js";
import "../server/operations/configuration.js";
import { stagePrivateDocumentAsset } from "../server/operations/documents.js";
import { createHash } from "node:crypto";

/** Synthetic, disposable fixture. Never imports a real member or approves an actual cutover. */
export async function seedOperationsRehearsal() {
 const url=new URL(process.env.DATABASE_URL??"");
 if(process.env.NODE_ENV==="production"||process.env.DEMO_MODE!=="true"||!["127.0.0.1","localhost","[::1]"].includes(url.hostname)||!/^bombo_(ui_|implementation_|test|restore)/.test(url.pathname.slice(1)))throw new Error("El ensayo requiere una base demo dedicada en loopback");
 if(await db.operationOrder.count()||await db.operationAccount.count())throw new Error("El circuito contiene hechos; el seed no modifica ni reemplaza operaciones existentes");
 const owner=await db.user.findUniqueOrThrow({where:{email:"owner@demo.bombo.local"}});
 const finance=await db.user.findUniqueOrThrow({where:{email:"gio@demo.bombo.local"}});
 if(owner.role!=="owner")throw new Error("El propietario demo no está disponible");
 await db.user.create({data:{id:"ops-driver",name:"Repartidor de ensayo",email:"ops-driver@demo.bombo.local",role:"viewer",password:owner.password}});
 await db.user.create({data:{id:"ops-stock",name:"Preparación de ensayo",email:"ops-stock@demo.bombo.local",role:"viewer",password:owner.password}});
 const today=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Argentina/Buenos_Aires"}).format(new Date());
 const future=new Date(today+"T12:00:00Z");future.setUTCFullYear(future.getUTCFullYear()+1);const validUntil=future.toISOString().slice(0,10);
 const evidence={reference:"fixture-sintetico-ensayo",scope:"not-valid-for-real-operation"};
 async function command(targetId:string,name:string,data:Record<string,unknown>,actorId=owner.id){const actor=await db.user.findUniqueOrThrow({where:{id:actorId}}),object=await db.operationObject.findUnique({where:{id:targetId}});return executeCommand(actor,{schemaVersion:1,requestId:randomUUID(),targetId,expectedVersion:object?.version??0,occurredAt:new Date().toISOString(),command:name,data});}
 await command(randomUUID(),"AccessGranted",{userId:finance.id,profile:"finance"});
 await command(randomUUID(),"AccessGranted",{userId:"ops-driver",profile:"driver"});
 await command(randomUUID(),"AccessGranted",{userId:"ops-stock",profile:"stock"});
 const accounts=["ARS","USD"].flatMap(currency=>["cash","bank","reserve"].map(kind=>({id:`ops-${kind}-${currency}`,name:`${kind==="cash"?"Caja":kind==="bank"?"Banco":"Reserva"} ${currency} · ensayo`,currency,kind,holder:"Club de ensayo",purpose:"Fixture sintético; apertura sin valor operativo"})));
 await command("ops-account-bootstrap","AccountsInitialized",{accounts});
 await command("ops-courier-ARS","AccountCreated",{name:"Custodia repartidor · ensayo",currency:"ARS",kind:"custody",holder:"Repartidor de ensayo",purpose:"Dinero recibido pendiente de rendición",custodianId:"ops-driver"});
 for(const account of [...accounts,{id:"ops-courier-ARS",currency:"ARS"}]){
  await command(account.id,"AccountVerified",{evidence});
  await command(account.id,"AccountOpeningApproved",{amountMinor:account.id==="ops-cash-ARS"?"200000000":account.id==="ops-reserve-USD"?"1000000":"0",preparedBy:finance.id,evidence});
 }
 await db.location.create({data:{id:"ops-warehouse",key:"ops-synthetic-warehouse",name:"Almacén de ensayo"}});
 await db.supplier.create({data:{id:"ops-supplier",key:"ops-synthetic-supplier",name:"Proveedor de ensayo"}});
 const skus=[{id:"ops-sku-a",name:"Variedad A",category:"Categoría A"},{id:"ops-sku-b",name:"Variedad B",category:"Categoría B"},{id:"ops-sku-c",name:"Variedad C",category:"Categoría C"}];
 for(const [i,s] of skus.entries())await command(s.id,"CatalogSkuCreated",{code:`ENSAYO-${i+1}`,name:s.name,variety:s.name,category:s.category,unit:"g",minQuantity:"30",minVarieties:2,evidence});
 await command("ops-purchase","PurchaseOrderCreated",{supplierId:"ops-supplier",agreementDate:today,expectedDate:today,currency:"ARS",items:skus.map((s,i)=>({lineId:`ops-buy-line-${i}`,skuId:s.id,unit:"g",quantity:"100",unitCost:"2000"})),evidence},"ops-stock");
 await command("ops-purchase","PurchaseOrderApproved",{evidence});
 const reception=await command("ops-receipt","GoodsReceived",{purchaseId:"ops-purchase",receivedDate:today,locationId:"ops-warehouse",custodianId:owner.id,items:skus.map((_s,i)=>({lineId:`ops-buy-line-${i}`,quantity:"100",lotLabel:"Etiqueta repetida de ensayo"})),evidence});
 await command("ops-purchase-payable","PayableCreated",{purchaseId:"ops-purchase",beneficiaryId:"ops-supplier",kind:"purchase",currency:"ARS",amountMinor:"60000000",dueDate:today,evidence});
 await command("ops-purchase-payable","PayableVerified",{evidence},finance.id);
 await command("ops-policy","PricePolicyProposed",{name:"Tarifa de ensayo",version:1,currency:"ARS",validFrom:today,validUntil,definition:{tiers:skus.flatMap(s=>[1,5,10,15,20,30].map(q=>({skuId:s.id,minQuantity:String(q),unitPrice:"5500",scale:`escala-${q}`}))),paymentMethods:["cash","transfer"],productSurchargeBps:500,deliverySurchargeBps:500,automaticScaleVerified:false,segmentBenefits:{},evidence}});
 await command("ops-policy","PricePolicyApproved",{evidence});
 await command("ops-pack","PackProposed",{name:"Degustación de ensayo",version:1,currency:"ARS",priceMinor:"7500000",components:skus.map((s,i)=>({id:`component-${i}`,category:s.category,quantity:"5",unit:"g",referenceMinor:"2750000"})),validFrom:today,validUntil});
 await command("ops-pack","PackApproved",{evidence});
 for(const [name,kind,definition] of [["Objetivo del ensayo","objectives",{currency:"ARS",monthlyContributionMinor:"100000000"}],["Costos de ensayo","fixed_costs",{currency:"ARS",items:[{category:"Alquiler de ensayo",amountMinor:"20000000",accrualPeriod:today.slice(0,7),recurring:true}]}],["Límites de pesaje del ensayo","preparation_limits",{maximumGramsPerOrder:"100",maximumExtraGramsPerLine:"0.1",maximumExtraBps:100,evidence}]] as const){const id=randomUUID();await command(id,"ConfigurationProposed",{name,kind,version:1,validFrom:today,validUntil,definition,evidence});await command(id,"ConfigurationApproved",{evidence});}
 await command("ops-member","MemberCreated",{name:"Socio de ensayo",phone:"+54 11 5555 0000",address:{street:"Dirección sintética 123"},preferences:{preferredChannel:"delivery"}});
 const docId=randomUUID();await command(docId,"DocumentReferenced",{memberId:"ops-member",kind:"evidence_rehearsal",sensitivity:"commercial",metadata:{synthetic:true}});
 const fixturePdf=Buffer.from("%PDF-1.4\n% Synthetic fixture; no legal validity\n%%EOF");
 const {stored:blob}=await stagePrivateDocumentAsset({documentId:docId,requestId:randomUUID(),body:fixturePdf,mediaType:"application/pdf",sourceHash:createHash("sha256").update(fixturePdf).digest("hex")});
 await command(docId,"DocumentMadeAvailable",blob as unknown as Record<string,unknown>);
 await command("ops-member","PermissionVerified",{kind:"operations",validFrom:today,validUntil,evidenceDocumentId:docId});
 await command("ops-delivery-order","OrderCreated",{memberId:"ops-member",channel:"delivery",currency:"ARS",address:{street:"Dirección sintética 123"}});
 await command("ops-delivery-order","OrderQuoted",{currency:"ARS",paymentMethod:"cash",items:[{id:"ops-order-line",skuId:"ops-sku-a",quantity:"10",policyId:"ops-policy",scale:"escala-10"}],deliveryMinor:"50000",deliveryPolicyEvidence:evidence});
 const confirmation=await command("ops-delivery-order","OrderConfirmed",{quoteVersion:1,acceptance:evidence});
 const lot=(reception.result.lots as Array<{skuId:string;lotId:string;balanceId:string}>).find(l=>l.skuId==="ops-sku-a")!;
 await command("ops-delivery-order","OrderPrepared",{allocations:[{lineId:"ops-order-line",lotId:lot.lotId,balanceId:lot.balanceId,requestedQuantity:"10",actualQuantity:"10.07"}],evidence});
 await command("ops-route","RouteCreated",{driverId:"ops-driver",shiftDate:today,custodianAccountId:"ops-courier-ARS"});
 const deliveryId=confirmation.result.deliveryId as string;
 await command(deliveryId,"DeliveryAssigned",{routeId:"ops-route",driverId:"ops-driver",stopSequence:1,windowStart:"14:00",windowEnd:"18:00",evidence});
 await command(deliveryId,"DeliveryDispatched",{evidence});
 await command("ops-local-draft","OrderCreated",{memberId:"ops-member",channel:"local",currency:"ARS",preorder:true});
 await command("ops-task","TaskCreated",{title:"Revisar el margen del pack de ensayo",responsibleId:"admin",dueDate:today,links:{packId:"ops-pack"}});
 console.log(JSON.stringify({seed:"operations-rehearsal",synthetic:true,accounts:6,custodies:1,skus:3,orders:2,authority:"shadow",realGatesApproved:0}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{await seedOperationsRehearsal();}finally{await db.$disconnect();}}
