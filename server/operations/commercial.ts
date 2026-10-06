import { z } from "zod";
import { createHash } from "node:crypto";
import { registerCommand, OperationError, json, objectId, decimal, currency, minor, civilDate, evidence, requireCapability, type Tx, type CommandContext } from "./core.js";
import { parseQuantity, parseDecimal, moneyForQuantity, allocateMinor, formatDecimal, roundHalfUp } from "../../shared/operations/exact.js";
const tier=z.strictObject({skuId:objectId,minQuantity:decimal,unitPrice:decimal,scale:z.string().min(1).max(80)});
const paymentMethod=z.enum(["cash","transfer","mercado_pago","card"]);
const componentSurchargeRates=z.strictObject({method:paymentMethod,productSurchargeBps:z.number().int().min(0).max(10000),deliverySurchargeBps:z.number().int().min(0).max(10000)});
const definition=z.strictObject({tiers:z.array(tier).min(1).max(1000),productSurchargeBps:z.number().int().min(0).max(10000).default(0),deliverySurchargeBps:z.number().int().min(0).max(10000).default(0),paymentMethods:z.array(paymentMethod).min(1),paymentMethodRates:z.array(componentSurchargeRates).optional(),automaticScaleVerified:z.boolean().default(false),segmentBenefits:z.record(z.string(),minor).default({}),deliverySegmentBenefits:z.record(z.string(),minor).default({}),evidence}).superRefine((value,ctx)=>{
 if(value.paymentMethodRates){
  const methods=new Set<string>();
  value.paymentMethodRates.forEach((rates,index)=>{
   if(methods.has(rates.method))ctx.addIssue({code:"custom",path:["paymentMethodRates",index,"method"],message:"No repitas las tarifas de un medio de pago"});
   methods.add(rates.method);
   if(!value.paymentMethods.includes(rates.method))ctx.addIssue({code:"custom",path:["paymentMethodRates",index,"method"],message:"No se pueden definir tarifas para un medio no habilitado"});
  });
  for(const method of value.paymentMethods)if(!methods.has(method))ctx.addIssue({code:"custom",path:["paymentMethodRates"],message:"Cada medio habilitado requiere tarifas de producto y reparto"});
 }
 const seen=new Set<string>();
 value.tiers.forEach((item,index)=>{const key=JSON.stringify([item.skuId,item.scale]);if(seen.has(key))ctx.addIssue({code:"custom",path:["tiers",index,"scale"],message:"Cada producto requiere nombres de escala distintos"});seen.add(key);});
});
registerCommand("PricePolicyProposed",{kind:"pricePolicy",capability:"prices.propose",create:true,
 schema:z.strictObject({name:z.string().min(1).max(150),version:z.number().int().positive(),currency,definition,validFrom:civilDate,validUntil:civilDate.optional()}),
 execute:async ctx=>{
  const v=ctx.envelope.data as {name:string;version:number;currency:string;definition:Record<string,unknown>;validFrom:string;validUntil?:string};
  if(v.validUntil&&v.validUntil<v.validFrom)throw new OperationError(400,"PRICE_DATES","Vigencia invertida");
  const policy=await ctx.tx.pricePolicy.create({data:{id:ctx.envelope.targetId,...v,definition:json(v.definition),proposedBy:ctx.actor.id}});
  return {policy};
 }});
registerCommand("PricePolicyApproved",{kind:"pricePolicy",capability:"prices.approve",schema:z.strictObject({evidence}),
 execute:async ctx=>{
  const p=await ctx.tx.pricePolicy.findUniqueOrThrow({where:{id:ctx.envelope.targetId}});
  if(p.status!=="draft")throw new OperationError(409,"POLICY_IMMUTABLE","La versión ya fue resuelta; proponé una versión nueva");
  if(!definition.safeParse(p.definition).success)throw new OperationError(422,"POLICY_DEFINITION_INVALID","La política contiene escalas ambiguas o una definición inválida; proponé una versión corregida");
  return {policy:await ctx.tx.pricePolicy.update({where:{id:p.id},data:{status:"approved",approvedBy:ctx.actor.id,approvedAt:ctx.now}})};
 }});
const packComponent=z.strictObject({id:objectId,skuId:objectId.optional(),category:z.string().min(1).max(100).optional(),quantity:decimal,unit:z.enum(["g","ud"]),referenceMinor:minor}).refine(v=>Boolean(v.skuId)!==Boolean(v.category),"Elegí SKU o categoría");
registerCommand("PackProposed",{kind:"pack",capability:"prices.propose",create:true,
 schema:z.strictObject({name:z.string().min(1).max(150),version:z.number().int().positive(),currency,priceMinor:minor,components:z.array(packComponent).min(1).max(100),validFrom:civilDate,validUntil:civilDate.optional()}),
 execute:async ctx=>{
 const v=ctx.envelope.data as {name:string;version:number;currency:string;priceMinor:string;components:z.infer<typeof packComponent>[];validFrom:string;validUntil?:string};
  if(v.validUntil&&v.validUntil<v.validFrom)throw new OperationError(400,"PACK_DATES","Vigencia invertida");
  if(new Set(v.components.map(c=>c.id)).size!==v.components.length)throw new OperationError(400,"DUPLICATE_COMPONENT","Componentes repetidos");
  for(const c of v.components){if(parseQuantity(c.quantity,c.unit)<=0n)throw new OperationError(400,"PACK_QUANTITY","Cantidad no positiva"); if(c.skuId){const sku=await ctx.tx.catalogSku.findUnique({where:{id:c.skuId}});if(!sku||sku.unit!==c.unit)throw new OperationError(422,"PACK_SKU","SKU o unidad inválidos");}}
  const weights=v.components.map(c=>({id:c.id,weight:c.referenceMinor}));
  const pack=await ctx.tx.commercialPack.create({data:{id:ctx.envelope.targetId,name:v.name,version:v.version,currency:v.currency,priceMinor:BigInt(v.priceMinor),components:json(v.components),allocationWeights:json(weights),validFrom:v.validFrom,validUntil:v.validUntil,proposedBy:ctx.actor.id}});
  return {pack};
 }});
registerCommand("PackApproved",{kind:"pack",capability:"prices.approve",schema:z.strictObject({evidence}),
 execute:async ctx=>{
  const p=await ctx.tx.commercialPack.findUniqueOrThrow({where:{id:ctx.envelope.targetId}});
  if(p.status!=="draft")throw new OperationError(409,"PACK_IMMUTABLE","La versión ya fue resuelta");
  const weights=p.allocationWeights as unknown as {id:string;weight:string}[];
  if(weights.some(w=>BigInt(w.weight)<=0n))throw new OperationError(422,"PACK_ALLOCATION_REQUIRED","Aprobá referencias de todos los componentes antes de publicar");
  const reference=weights.reduce((a,w)=>a+BigInt(w.weight),0n);
  if(p.priceMinor>reference)throw new OperationError(422,"PACK_REFERENCES_TOO_LOW","Las referencias deben cubrir el precio del pack");
  return {pack:await ctx.tx.commercialPack.update({where:{id:p.id},data:{status:"approved",approvedBy:ctx.actor.id,approvedAt:ctx.now}})};
 }});
registerCommand("PromotionProposed",{kind:"promotion",capability:"prices.propose",create:true,
 schema:z.strictObject({name:z.string().min(1).max(150),version:z.number().int().positive(),validFrom:civilDate,validUntil:civilDate,definition:z.strictObject({policyId:objectId.optional(),packId:objectId.optional(),eligibility:z.record(z.string(),z.unknown()),description:z.string().max(2000),evidence})}),
 execute:async ctx=>{
  const v=ctx.envelope.data as {name:string;version:number;validFrom:string;validUntil:string;definition:Record<string,unknown>};
  if(v.validUntil<v.validFrom)throw new OperationError(400,"PROMOTION_DATES","Vigencia invertida");
  return {promotion:await ctx.tx.commercialPromotion.create({data:{id:ctx.envelope.targetId,...v,definition:json(v.definition),proposedBy:ctx.actor.id}})};
 }});
registerCommand("PromotionApproved",{kind:"promotion",capability:"prices.approve",schema:z.strictObject({evidence}),execute:async ctx=>{
 const p=await ctx.tx.commercialPromotion.findUniqueOrThrow({where:{id:ctx.envelope.targetId}});
 if(p.status!=="draft")throw new OperationError(409,"PROMOTION_IMMUTABLE","Proponé una versión nueva");
 const def=p.definition as {policyId?:string;packId?:string};
 if(!def.policyId&&!def.packId)throw new OperationError(422,"PROMOTION_EFFECT_REQUIRED","La promoción requiere una tarifa o pack concreto aprobado");
 if(def.policyId&&(await ctx.tx.pricePolicy.findUnique({where:{id:def.policyId}}))?.status!=="approved")throw new OperationError(422,"POLICY_NOT_APPROVED","La tarifa requiere aprobación");
 if(def.packId&&(await ctx.tx.commercialPack.findUnique({where:{id:def.packId}}))?.status!=="approved")throw new OperationError(422,"PACK_NOT_APPROVED","El pack requiere aprobación");
 return {promotion:await ctx.tx.commercialPromotion.update({where:{id:p.id},data:{status:"approved",approvedBy:ctx.actor.id,approvedAt:ctx.now}})};
}});
registerCommand("TaskCreated",{kind:"task",capability:"tasks.write",create:true,schema:z.strictObject({title:z.string().min(1).max(300),responsibleId:objectId,dueDate:civilDate,links:z.record(z.string(),z.unknown()).default({})}),execute:async ctx=>({task:await ctx.tx.operationTask.create({data:{id:ctx.envelope.targetId,...ctx.envelope.data as {title:string;responsibleId:string;dueDate:string},links:json(ctx.envelope.data.links),evidence:{},createdBy:ctx.actor.id}})})});
registerCommand("TaskCompleted",{kind:"task",capability:"tasks.write",schema:z.strictObject({evidence}),execute:async ctx=>{
 const task=await ctx.tx.operationTask.findUniqueOrThrow({where:{id:ctx.envelope.targetId}});
 if(task.responsibleId!==ctx.actor.id&&ctx.actor.role!=="owner")throw new OperationError(403,"TASK_SCOPE","La tarea pertenece a otro responsable");
 return {task:await ctx.tx.operationTask.update({where:{id:task.id},data:{status:"completed",evidence:json(ctx.envelope.data.evidence)}})};
}});
const segmentBenefitInput=z.strictObject({policyId:objectId,segment:z.string().trim().min(1).max(120),eligibilityEvidence:evidence});
export const quoteInput=z.strictObject({
 items:z.array(z.strictObject({id:objectId,skuId:objectId,quantity:decimal,policyId:objectId.optional(),scale:z.string().max(80).optional(),manualUnitPrice:decimal.optional(),manualReason:z.string().min(1).max(1000).optional()})).max(200).default([]),
 packs:z.array(z.strictObject({id:objectId,packId:objectId,count:z.number().int().min(1).max(10000),selections:z.record(z.string(),objectId).default({})})).max(100).default([]),
 currency,paymentMethod:paymentMethod.optional(),productPaymentMethod:paymentMethod.optional(),deliveryPaymentMethod:paymentMethod.optional(),deliveryMinor:minor.default("0"),deliverySurchargeMinor:minor.optional(),productSurchargeMinor:minor.optional(),surchargeOverrideReason:z.string().min(1).max(1000).optional(),promotionId:objectId.optional(),promotionEligibilityEvidence:z.record(z.string(),z.unknown()).default({}),deliveryPolicyEvidence:z.record(z.string(),z.unknown()).default({}),
 bonusDiscountMinor:minor.default("0"),bonusReason:z.string().trim().min(1).max(1000).optional(),segmentBenefit:segmentBenefitInput.optional(),deliveryBenefit:segmentBenefitInput.optional(),
}).superRefine((v,ctx)=>{
 if(v.items.length+v.packs.length===0)ctx.addIssue({code:"custom",message:"Agregá productos o packs"});
 if(!v.paymentMethod&&(!v.productPaymentMethod||!v.deliveryPaymentMethod))ctx.addIssue({code:"custom",path:["paymentMethod"],message:"Indicá el medio general o ambos medios por componente"});
});
export async function authorizeQuoteAdjustments(ctx:CommandContext){
 const input=(ctx.envelope.command==="OrderQuoteRevisionAccepted"?ctx.envelope.data.quote:ctx.envelope.data) as z.infer<typeof quoteInput>;
 if(input.segmentBenefit||input.deliveryBenefit||BigInt(input.bonusDiscountMinor??"0")>0n||input.surchargeOverrideReason||Object.keys(input.promotionEligibilityEvidence??{}).length)
  await requireCapability(ctx.tx,ctx.actor,"prices.approve");
}
export interface QuotedLine {id:string;skuId:string;unit:"g"|"ud";requested:string;unitPrice:string;referenceMinor:string;discountMinor:string;revenueMinor:string;policyId?:string;policyVersion?:number;packId?:string;packCount?:number}
export async function quoteOrder(tx:Tx,input:z.infer<typeof quoteInput>,date:string,actorId:string){
 const productPaymentMethod=input.productPaymentMethod??input.paymentMethod,deliveryPaymentMethod=input.deliveryPaymentMethod??input.paymentMethod;
 if(!productPaymentMethod||!deliveryPaymentMethod)throw new OperationError(422,"PAYMENT_METHOD_REQUIRED","Indicá el medio general o ambos medios por componente");
 const policyIds=[...new Set(input.items.flatMap(item=>item.policyId?[item.policyId]:[]))],packIds=[...new Set(input.packs.map(item=>item.packId))];
 const [policyRows,packRows]=await Promise.all([
  policyIds.length?tx.pricePolicy.findMany({where:{id:{in:policyIds}}}):Promise.resolve([]),
  packIds.length?tx.commercialPack.findMany({where:{id:{in:packIds}}}):Promise.resolve([]),
 ]);
 const policyById=new Map(policyRows.map(policy=>[policy.id,policy])),packById=new Map(packRows.map(pack=>[pack.id,pack]));
 const packSelections=new Map(input.packs.map(pack=>[pack.packId,pack.selections]));
 const skuIds=new Set(input.items.map(item=>item.skuId));
 for(const pack of packRows)for(const component of pack.components as unknown as z.infer<typeof packComponent>[]){const selected=component.skuId??packSelections.get(pack.id)?.[component.id];if(selected)skuIds.add(selected);}
 const skuRows=skuIds.size?await tx.catalogSku.findMany({where:{id:{in:[...skuIds]}}}):[];
 const skuById=new Map(skuRows.map(sku=>[sku.id,sku]));
 const lines:QuotedLine[]=[];
 let expectedProductSurcharge=0n;const deliveryRates=new Set<number>();
 const policyDefinition=(policy:{definition:unknown})=>{const parsed=definition.safeParse(policy.definition);if(!parsed.success)throw new OperationError(422,"POLICY_DEFINITION_INVALID","La política requiere una versión corregida con escalas inequívocas");return parsed.data;};
 for(const item of input.items){
  const sku=skuById.get(item.skuId);
  if(!sku?.active)throw new OperationError(422,"SKU_NOT_AVAILABLE","Producto no disponible");
  if(parseQuantity(item.quantity,sku.unit as "g"|"ud")<=0n)throw new OperationError(422,"QUOTE_QUANTITY","La cantidad cotizada debe ser positiva");
  let unitPrice=item.manualUnitPrice;let policyVersion:number|undefined;
  if(item.policyId){
   const p=policyById.get(item.policyId);
   if(!p||p.status!=="approved"||p.currency!==input.currency||p.validFrom>date||(p.validUntil&&p.validUntil<date))throw new OperationError(422,"POLICY_NOT_ACTIVE","Tarifa no aprobada o fuera de vigencia");
   const def=policyDefinition(p);
   if(!def.paymentMethods.includes(productPaymentMethod))throw new OperationError(422,"PAYMENT_POLICY","Medio de pago de productos fuera de la política");
   if(BigInt(input.deliveryMinor)>0n&&!def.paymentMethods.includes(deliveryPaymentMethod))throw new OperationError(422,"DELIVERY_PAYMENT_POLICY","Medio de pago del reparto fuera de la política");
   const candidates=def.tiers.filter(t=>t.skuId===sku.id&&parseDecimal(item.quantity,12)>=parseDecimal(t.minQuantity,12));
   let selected=candidates.find(t=>t.scale===item.scale);
   if(!selected&&!item.scale&&def.automaticScaleVerified)selected=candidates.sort((a,b)=>parseDecimal(a.minQuantity,12)<parseDecimal(b.minQuantity,12)?1:-1)[0];
   if(!selected)throw new OperationError(422,"SCALE_APPROVAL_REQUIRED","Elegí una escala aprobada explícitamente");
   unitPrice=selected.unitPrice;policyVersion=p.version;
  }else if(unitPrice===undefined||!item.manualReason){
   throw new OperationError(422,"MANUAL_QUOTE_EVIDENCE","La cotización manual requiere precio y motivo");
  }else if(parseDecimal(unitPrice,12)<=0n){
   throw new OperationError(422,"MANUAL_PRICE_POSITIVE","El precio manual debe ser positivo; una entrega bonificada requiere una bonificación aprobada");
  }
  const ref=moneyForQuantity(item.quantity,unitPrice!);
  if(!item.policyId&&ref<=0n)throw new OperationError(422,"MANUAL_PRICE_POSITIVE","El importe manual cerrado debe ser positivo; usá una bonificación aprobada para una entrega sin cargo");
  if(item.policyId){
   const def=policyDefinition(policyById.get(item.policyId)!);
   const rates=(method:string)=>def.paymentMethodRates?.find(entry=>entry.method===method)??{productSurchargeBps:def.productSurchargeBps,deliverySurchargeBps:def.deliverySurchargeBps};
   expectedProductSurcharge+=roundHalfUp(ref*BigInt(rates(productPaymentMethod).productSurchargeBps),10000n);deliveryRates.add(rates(deliveryPaymentMethod).deliverySurchargeBps);
  }
  if(!minor.safeParse(ref.toString()).success)throw new OperationError(422,"MONEY_RANGE","El importe excede el rango operativo de la base de datos");
  lines.push({id:item.id,skuId:sku.id,unit:sku.unit as "g"|"ud",requested:item.quantity,unitPrice:unitPrice!,referenceMinor:ref.toString(),discountMinor:"0",revenueMinor:ref.toString(),policyId:item.policyId,policyVersion});
 }
 for(const item of input.packs){
  const p=packById.get(item.packId);
  if(!p||p.status!=="approved"||p.currency!==input.currency||p.validFrom>date||(p.validUntil&&p.validUntil<date))throw new OperationError(422,"PACK_NOT_ACTIVE","Pack no aprobado o fuera de vigencia");
  const components=p.components as unknown as z.infer<typeof packComponent>[];
  const weights=(p.allocationWeights as unknown as {id:string;weight:string}[]).map(w=>({id:w.id,weight:BigInt(w.weight)*BigInt(item.count)}));
  const reference=weights.reduce((s,w)=>s+w.weight,0n);const total=p.priceMinor*BigInt(item.count);
  const discounts=allocateMinor(reference-total,weights);
  for(const c of components){
   const skuId=c.skuId??item.selections[c.id],sku=skuId?skuById.get(skuId):undefined;
   if(!sku?.active||sku.unit!==c.unit||(c.category&&sku.category!==c.category))throw new OperationError(422,"PACK_SELECTION_REQUIRED","Resolvé productos y unidades del pack");
   const qty=formatDecimal(parseDecimal(c.quantity,3)*BigInt(item.count),3);
   const ref=weights.find(w=>w.id===c.id)!.weight;const discount=discounts.find(d=>d.id===c.id)!.amount;
   if(!minor.safeParse(ref.toString()).success)throw new OperationError(422,"MONEY_RANGE","El importe excede el rango operativo de la base de datos");
   lines.push({id:"pack:"+createHash("sha256").update(JSON.stringify([item.id,c.id])).digest("hex"),skuId:sku.id,unit:c.unit,requested:qty,unitPrice:formatDecimal(ref*10n**12n*1000n/(parseDecimal(qty,3)*100n),12),referenceMinor:ref.toString(),discountMinor:discount.toString(),revenueMinor:(ref-discount).toString(),packId:p.id,packCount:item.count,policyVersion:p.version});
  }
 }
 if(new Set(lines.map(l=>l.id)).size!==lines.length)throw new OperationError(400,"LINE_IDENTITIES","Las líneas requieren identidades distintas");
 let benefitApplication:Record<string,unknown>|null=null;
 let segmentDiscount=0n;
 if(input.segmentBenefit){
  const actor=await tx.user.findUniqueOrThrow({where:{id:actorId}});await requireCapability(tx,actor,"prices.approve");
  const selection=input.segmentBenefit;
  const policy=await tx.pricePolicy.findUnique({where:{id:selection.policyId}});
  if(!policy||policy.status!=="approved"||policy.currency!==input.currency||policy.validFrom>date||(policy.validUntil&&policy.validUntil<date)||!lines.some(line=>line.policyId===policy.id))
   throw new OperationError(422,"BENEFIT_POLICY_NOT_APPLIED","El beneficio requiere una tarifa aprobada, vigente y aplicada en el pedido");
  const benefits=policyDefinition(policy).segmentBenefits;
  if(!Object.hasOwn(benefits,selection.segment)||!Object.keys(selection.eligibilityEvidence).length)
   throw new OperationError(422,"BENEFIT_ELIGIBILITY_PENDING","El segmento y su elegibilidad requieren una resolución documentada");
  segmentDiscount=BigInt(benefits[selection.segment]!);
  benefitApplication={policyId:policy.id,version:policy.version,segment:selection.segment,amountMinor:segmentDiscount.toString(),eligibilityEvidence:selection.eligibilityEvidence,resolvedBy:actorId};
 }
 const bonusDiscount=BigInt(input.bonusDiscountMinor??"0");
 if(bonusDiscount>0n){
  if(!input.bonusReason)throw new OperationError(422,"BONUS_REASON_REQUIRED","La bonificación requiere un motivo explícito");
  await requireCapability(tx,await tx.user.findUniqueOrThrow({where:{id:actorId}}),"prices.approve");
 }
 const extraDiscount=segmentDiscount+bonusDiscount;
 const netReference=lines.reduce((sum,line)=>sum+BigInt(line.revenueMinor),0n);
 if(extraDiscount>netReference)throw new OperationError(422,"DISCOUNT_EXCEEDS_PRODUCTS","Los beneficios y bonificaciones no pueden superar el valor de los productos");
 if(extraDiscount>0n){
  const allocated=allocateMinor(extraDiscount,lines.map(line=>({id:line.id,weight:BigInt(line.revenueMinor)})));
  for(const line of lines){const amount=allocated.find(part=>part.id===line.id)!.amount;line.discountMinor=(BigInt(line.discountMinor)+amount).toString();line.revenueMinor=(BigInt(line.revenueMinor)-amount).toString();}
 }
 const subtotal=lines.reduce((s,l)=>s+BigInt(l.referenceMinor),0n);const discount=lines.reduce((s,l)=>s+BigInt(l.discountMinor),0n);
 const delivery=BigInt(input.deliveryMinor),ambiguousDeliveryRate=delivery>0n&&deliveryRates.size>1;
 if(ambiguousDeliveryRate&&input.deliverySurchargeMinor===undefined)throw new OperationError(422,"DELIVERY_RATE_AMBIGUOUS","Las políticas tienen recargos de reparto distintos; ingresá un importe aprobado explícitamente");
 const expectedDeliverySurcharge=ambiguousDeliveryRate?null:roundHalfUp(delivery*BigInt([...deliveryRates][0]??0),10000n);
 const productSurcharge=input.productSurchargeMinor===undefined?expectedProductSurcharge:BigInt(input.productSurchargeMinor),deliverySurcharge=input.deliverySurchargeMinor===undefined?expectedDeliverySurcharge!:BigInt(input.deliverySurchargeMinor);
 const surchargeOverride=(input.items.some(i=>i.policyId)&&(productSurcharge!==expectedProductSurcharge||ambiguousDeliveryRate||deliverySurcharge!==expectedDeliverySurcharge));
 if(surchargeOverride){
  if(!input.surchargeOverrideReason)throw new OperationError(422,"SURCHARGE_POLICY_OVERRIDE","La excepción de recargos requiere motivo y autorización");
  await requireCapability(tx,await tx.user.findUniqueOrThrow({where:{id:actorId}}),"prices.approve");
 }
 if((delivery>0n||deliverySurcharge>0n||productSurcharge>0n)&&!Object.keys(input.deliveryPolicyEvidence).length)throw new OperationError(422,"SURCHARGE_APPROVAL_REQUIRED","Los cargos requieren una regla o cotización documentada");
 const deliveryBenefitDiscount=input.deliveryBenefit?BigInt((()=>{
  const selection=input.deliveryBenefit!;
  const policy=policyById.get(selection.policyId);
  if(!policy||policy.status!=="approved"||policy.currency!==input.currency||policy.validFrom>date||(policy.validUntil&&policy.validUntil<date)||!lines.some(line=>line.policyId===policy.id))throw new OperationError(422,"DELIVERY_BENEFIT_POLICY_NOT_APPLIED","El beneficio de reparto requiere una tarifa aprobada, vigente y aplicada en el pedido");
  if(delivery<=0n)throw new OperationError(422,"DELIVERY_BENEFIT_NO_DELIVERY","El beneficio requiere un importe de reparto positivo");
  const benefits=policyDefinition(policy).deliverySegmentBenefits;
  if(!Object.hasOwn(benefits,selection.segment)||!Object.keys(selection.eligibilityEvidence).length)throw new OperationError(422,"DELIVERY_BENEFIT_ELIGIBILITY_PENDING","El segmento y su elegibilidad requieren una resolución documentada");
  return benefits[selection.segment]!;
 })()):0n;
 if(deliveryBenefitDiscount>delivery)throw new OperationError(422,"DELIVERY_DISCOUNT_EXCEEDS_BASE","El beneficio no puede superar el importe del reparto");
 let deliveryBenefitApplication:Record<string,unknown>|null=null;
 if(input.deliveryBenefit){const policy=policyById.get(input.deliveryBenefit.policyId)!;deliveryBenefitApplication={policyId:policy.id,version:policy.version,segment:input.deliveryBenefit.segment,amountMinor:deliveryBenefitDiscount.toString(),eligibilityEvidence:input.deliveryBenefit.eligibilityEvidence,resolvedBy:actorId};}
 let promotionApplication:Record<string,unknown>|null=null;
 if(input.promotionId){
  const promo=await tx.commercialPromotion.findUnique({where:{id:input.promotionId}});if(!promo||promo.status!=="approved"||promo.validFrom>date||promo.validUntil<date)throw new OperationError(422,"PROMOTION_NOT_ACTIVE","Promoción no aprobada");
  const def=promo.definition as {policyId?:string;packId?:string;eligibility?:Record<string,unknown>};
  if(def.policyId&&!lines.some(l=>l.policyId===def.policyId)||def.packId&&!lines.some(l=>l.packId===def.packId))throw new OperationError(422,"PROMOTION_NOT_APPLIED","La cotización no utiliza la tarifa o composición aprobada de esta promoción");
  if(Object.keys(def.eligibility??{}).length){
   if(!Object.keys(input.promotionEligibilityEvidence).length)throw new OperationError(422,"PROMOTION_ELIGIBILITY_PENDING","La elegibilidad requiere resolución explícita del propietario hasta contar con datos completos");
   const actor=await tx.user.findUniqueOrThrow({where:{id:actorId}});await requireCapability(tx,actor,"prices.approve");
  }
  promotionApplication={id:promo.id,version:promo.version,policyId:def.policyId??null,packId:def.packId??null,eligibilityEvidence:input.promotionEligibilityEvidence,approvedBy:promo.approvedBy};
 }
 const total=subtotal-discount+delivery-deliveryBenefitDiscount+productSurcharge+deliverySurcharge;
 for(const value of [subtotal,discount,delivery,deliveryBenefitDiscount,total,productSurcharge+deliverySurcharge])if(!minor.safeParse(value.toString()).success)throw new OperationError(422,"MONEY_RANGE","La cotización excede el rango de importes cerrados");
 const paymentComponents={products:{paymentMethod:productPaymentMethod,baseMinor:subtotal.toString(),discountMinor:discount.toString(),surchargeMinor:productSurcharge.toString(),totalMinor:(subtotal-discount+productSurcharge).toString()},delivery:{paymentMethod:deliveryPaymentMethod,baseMinor:delivery.toString(),discountMinor:deliveryBenefitDiscount.toString(),surchargeMinor:deliverySurcharge.toString(),totalMinor:(delivery-deliveryBenefitDiscount+deliverySurcharge).toString()}};
 return {lines,currency:input.currency,paymentMethod:input.paymentMethod??null,subtotalMinor:subtotal.toString(),discountMinor:discount.toString(),deliveryMinor:delivery.toString(),deliveryDiscountMinor:deliveryBenefitDiscount.toString(),surchargeMinor:(productSurcharge+deliverySurcharge).toString(),productSurchargeMinor:productSurcharge.toString(),deliverySurchargeMinor:deliverySurcharge.toString(),paymentComponents,totalMinor:total.toString(),segmentBenefitApplication:benefitApplication,deliveryBenefitApplication,bonusApplication:bonusDiscount>0n?{amountMinor:bonusDiscount.toString(),reason:input.bonusReason,resolvedBy:actorId}:null,policyEvidence:input.deliveryPolicyEvidence,promotionId:input.promotionId??null,promotionApplication,quotedBy:actorId,quotedDate:date,input};
}
