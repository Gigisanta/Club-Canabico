import { Prisma } from "@prisma/client";
import { db } from "../db.js";
import { processAbandonedDocumentAssets } from "./new-object-cleanup.js";
/** Bounded durable notifications. This never replays a physical or financial command. */
export async function processOperationOutbox(limit = 100): Promise<number> {
 const size = Math.max(1, Math.min(500, Math.floor(limit)));
 let processed = 0;
 for(let attempt = 0; ; attempt++) {
  try {
   processed = await db.$transaction(async tx => {
    // Concurrent instances take disjoint work; no process-local lock or permanent worker is needed.
    const events = await tx.$queryRaw<Array<{id:string;requestId:string}>>`
      SELECT "id", "requestId" FROM "OperationOutbox" WHERE "status" = 'pending'
      ORDER BY "createdAt", "id" LIMIT ${size} FOR UPDATE SKIP LOCKED`;
    if(!events.length) return 0;
    const receipts = await tx.commandReceipt.findMany({where:{requestId:{in:events.map(e=>e.requestId)}},select:{requestId:true,actorId:true,command:true,targetId:true}});
    const byRequest = new Map(receipts.map(r=>[r.requestId,r]));
    const assignments = await tx.deliveryAssignment.findMany({where:{id:{in:receipts.filter(r=>r.command.startsWith("Delivery")).map(r=>r.targetId)}},select:{id:true,driverId:true}});
    const drivers = new Map(assignments.map(d=>[d.id,d.driverId]));
    const users = new Map<string,number>(); const complete:string[] = [], review:string[] = [];
    for(const event of events){
     const receipt = byRequest.get(event.requestId);
     if(!receipt){review.push(event.id);continue;}
     const recipients = new Set([receipt.actorId]); const driver = drivers.get(receipt.targetId); if(driver)recipients.add(driver);
     for(const userId of recipients)users.set(userId,(users.get(userId)??0)+1);
     complete.push(event.id);
    }
    for(const [userId,changes] of users) await tx.operationObject.upsert({where:{id:`readEpoch:${userId}`},create:{id:`readEpoch:${userId}`,kind:"readEpoch",version:changes,createdBy:"outbox"},update:{version:{increment:changes}}});
    if(complete.length) await tx.operationObject.upsert({where:{id:"readEpoch:operations"},create:{id:"readEpoch:operations",kind:"readEpoch",version:1,createdBy:"outbox"},update:{version:{increment:1}}});
    if(complete.length) await tx.operationOutbox.updateMany({where:{id:{in:complete}},data:{status:"processed",attempts:{increment:1},processedAt:new Date()}});
    if(review.length) await tx.operationOutbox.updateMany({where:{id:{in:review}},data:{status:"review",attempts:{increment:1}}});
    return complete.length;
   }, {isolationLevel:"Serializable",timeout:15000});
   break;
  } catch(error) {
   if(error instanceof Prisma.PrismaClientKnownRequestError && ["P2034","P2002"].includes(error.code) && attempt < 3){await new Promise(resolve=>setTimeout(resolve,20*2**attempt));continue;}
   throw error;
  }
 }
 // Asset deletion is external I/O, so it always starts after the outbox effect
 // transaction has committed, including maintenance runs with no pending events.
 await processAbandonedDocumentAssets(size);
 return processed;
}
export function startOperationOutboxWorker(){
 let running=false;const timer=setInterval(()=>{if(running)return;running=true;void processOperationOutbox().catch(()=>{console.error("La outbox operativa requiere revisión; los comandos confirmados permanecen conservados");}).finally(()=>{running=false;});},5000);timer.unref();return()=>clearInterval(timer);
}
