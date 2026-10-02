import { Router } from "express";
import { z } from "zod";
import { db } from "../db.js";
import { registerCommand, requireCapability, capabilities, OperationError, objectId, civilDate, currency, minor, decimal, evidence, json, wire, objectScope } from "./core.js";
import { stockAvailabilityDefinitionSchema } from "./stock-availability.js";
import { historicalMappingSchema } from "./legacy-history.js";
export const configurationRoutes=Router();
const schemas={
 fixed_costs:z.strictObject({currency,items:z.array(z.strictObject({category:z.string().min(1).max(120),amountMinor:minor,accrualPeriod:z.string().regex(/^\d{4}-\d{2}$/),recurring:z.boolean()})).max(200)}),
 objectives:z.strictObject({currency,monthlyContributionMinor:minor}),
 stock_thresholds:z.strictObject({categories:z.array(z.strictObject({category:z.string().min(1),unit:z.enum(["g","ud"]),minimumQuantity:decimal,minimumVarieties:z.number().int().nonnegative()})).max(100)}),
 preparation_limits:z.strictObject({maximumGramsPerOrder:decimal,maximumExtraGramsPerLine:decimal,maximumExtraBps:z.number().int().min(0).max(10000),evidence}),
 scenarios:z.strictObject({currency,weeks:z.literal(13),items:z.array(z.strictObject({id:objectId,date:civilDate,kind:z.enum(["income","payment","purchase","funding"]),amountMinor:minor,commitmentId:objectId.optional(),description:z.string().min(1).max(300)})).max(500),evidence}),
 stock_availability:stockAvailabilityDefinitionSchema,
 legacy_history_mapping:historicalMappingSchema,
};
type Kind=keyof typeof schemas;
const kinds=z.enum(["fixed_costs","objectives","stock_thresholds","preparation_limits","scenarios","stock_availability","legacy_history_mapping"]);
registerCommand("ConfigurationProposed",{kind:"configuration",capability:"prices.propose",create:true,administrative:true,
 schema:z.strictObject({name:z.string().min(1).max(120),kind:kinds,version:z.number().int().positive(),validFrom:civilDate,validUntil:civilDate.optional(),definition:z.record(z.string(),z.unknown()),evidence}),
 execute:async ctx=>{
  const v=ctx.envelope.data as {name:string;kind:Kind;version:number;validFrom:string;validUntil?:string;definition:Record<string,unknown>;evidence:Record<string,unknown>};
  if(["fixed_costs","objectives","scenarios"].includes(v.kind))await requireCapability(ctx.tx,ctx.actor,"finance.read");
  if(v.kind==="legacy_history_mapping")await requireCapability(ctx.tx,ctx.actor,"imports.review");
  if(v.validUntil&&v.validUntil<v.validFrom)throw new OperationError(400,"CONFIGURATION_DATES","La vigencia está invertida");
  const definition=schemas[v.kind].parse(v.definition);
  if(v.kind==="stock_availability"){
   await requireCapability(ctx.tx,ctx.actor,"stock.adjust");
   const rules=(definition as z.infer<typeof stockAvailabilityDefinitionSchema>).rules;
   const tuples=new Set<string>();
   for(const rule of rules){const key=`${rule.locationId}\u0000${rule.custodianId}\u0000${rule.channel}`;if(tuples.has(key))throw new OperationError(422,"STOCK_AVAILABILITY_DUPLICATE","La configuración repite una ubicación, custodia y canal");tuples.add(key);}
   const locationIds=[...new Set(rules.map(rule=>rule.locationId))],custodianIds=[...new Set(rules.map(rule=>rule.custodianId))];
   const [locations,custodians]=await Promise.all([
    ctx.tx.location.findMany({where:{id:{in:locationIds},active:true},select:{id:true}}),
    ctx.tx.user.findMany({where:{id:{in:custodianIds},active:true},select:{id:true}}),
   ]);
   if(locations.length!==locationIds.length||custodians.length!==custodianIds.length)throw new OperationError(422,"STOCK_AVAILABILITY_REFERENCE","La configuración requiere ubicaciones y custodios activos");
  }
  if(v.kind==="scenarios"){
   const rows=(definition as z.infer<typeof schemas.scenarios>).items;
   if(new Set(rows.map(r=>r.id)).size!==rows.length)throw new OperationError(422,"SCENARIO_DUPLICATE","El escenario repite un hecho");
   const commitments=rows.flatMap(r=>r.commitmentId?[r.commitmentId]:[]);
   if(new Set(commitments).size!==commitments.length)throw new OperationError(422,"COMMITMENT_DUPLICATE","El mismo compromiso no puede proyectarse dos veces");
  }
  const configuration=await ctx.tx.operationalConfiguration.create({data:{id:ctx.envelope.targetId,name:v.name,kind:v.kind,version:v.version,validFrom:v.validFrom,validUntil:v.validUntil,definition:json({...definition,evidence:v.evidence}),proposedBy:ctx.actor.id}});
  return {configuration};
 }});
registerCommand("ConfigurationApproved",{kind:"configuration",capability:"access.manage",administrative:true,
 schema:z.strictObject({evidence}),execute:async ctx=>{
  const current=await ctx.tx.operationalConfiguration.findUniqueOrThrow({where:{id:ctx.envelope.targetId}});
  if(current.kind==="legacy_history_mapping"&&(await ctx.tx.user.findUnique({where:{id:ctx.actor.id},select:{role:true}}))?.role!=="owner")throw new OperationError(403,"OWNER_APPROVAL_REQUIRED","La interpretación histórica requiere aprobación del propietario");
  if(current.state!=="proposed")throw new OperationError(409,"CONFIGURATION_FROZEN","Publicá una nueva versión para cambiar una regla aprobada");
  return {configuration:await ctx.tx.operationalConfiguration.update({where:{id:current.id},data:{state:"approved",approvedBy:ctx.actor.id,approvedAt:ctx.now}})};
 }});
configurationRoutes.get("/",async(req,res)=>{
 const caps=await capabilities(db,req.user);const scope=await objectScope(db,req.user);
 const financial=caps.includes("finance.read")&&!scope.accountIds&&!scope.memberIds;
 const allowed:string[]=financial?["fixed_costs","objectives","scenarios"]:[];
 if(financial&&caps.includes("imports.review"))allowed.push("period_coverage");
 if(caps.includes("imports.review"))allowed.push("legacy_history_mapping");
 if(caps.includes("stock.read"))allowed.push("stock_thresholds","stock_availability");
 if(caps.includes("stock.prepare")||caps.includes("access.manage"))allowed.push("preparation_limits");
 const items=await db.operationalConfiguration.findMany({where:{kind:{in:allowed}},orderBy:[{validFrom:"desc"},{version:"desc"}]});
 const versions=Object.fromEntries((await db.operationObject.findMany({where:{id:{in:items.map(i=>i.id)}}})).map(o=>[o.id,o.version]));
 res.json(wire({items,versions}));
});
