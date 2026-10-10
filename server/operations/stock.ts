import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { formatDecimal, moneyForQuantity, parseDecimal, parseQuantity, roundHalfUp, type QuantityUnit } from "../../shared/operations/exact.js";
import { audit, civilDate, currency, decimal, evidence, json, objectId, objectScope, registerCommand, touchAggregate, OperationError, type CommandContext } from "./core.js";
import { resolveStockAvailability, type StockAvailabilityChannel, type StockAvailabilityResolution } from "./stock-availability.js";
import {
  recordAppSheetCanonicalSkuMutation,
  requireAppSheetOpeningSourceRecord,
  requireEligibleAppSheetReplacementOrderSkus,
  requireEligibleAppSheetReplacementSkus,
} from "./access.js";

export interface StockPreparationAllocationInput {
  lineId: string;
  lotId: string;
  balanceId: string;
  requestedQuantity: string;
  actualQuantity: string;
}

export interface StockLineDeliveryInput {
  lineId: string;
  /** Quantity against the accepted order line. */
  quantity: string;
  /** Physical weight delivered; defaults to quantity when omitted. */
  actualQuantity?: string;
}

export interface StockReservationResult {
  orderId: string;
  reservations: Array<{ lineId: string; lotId: string; balanceId: string; quantity: string }>;
  availability?: Pick<StockAvailabilityResolution, "coverage" | "configurationId" | "version">;
  releasedQuantity?: string;
  returnedPreparedQuantity?: string;
  returnedPreparedByUnit?: Record<string, string>;
}

export interface StockLineTotals {
  lineId: string;
  requestedQuantity: string;
  reservedQuantity: string;
  preparedQuantity: string;
  deliveredQuantity: string;
  cancelledQuantity: string;
  returnedQuantity: string;
  extraQuantity: string;
  costMinor: string;
  costCurrency: string | null;
  costCoverage: "unknown" | "known" | "mixed_currency";
}

export interface StockOrderResult {
  orderId: string;
  fulfillmentState: string;
  lines: StockLineTotals[];
  preparationLimitsCoverage?: "approved" | "demo_missing_approved_rule";
}

export interface StockReturnInput {
  lineId: string;
  allocationId: string;
  quantity: string;
  origin: "customer" | "undelivered";
  disposition: "restock" | "merma";
  locationId?: string;
  custodianId?: string;
  evidence: Record<string, unknown>;
}

export interface StockReturnResult extends StockOrderResult {
  returns: Array<{
    lineId: string;
    allocationId: string;
    lotId: string;
    balanceId?: string;
    quantity: string;
    origin: "customer" | "undelivered";
    disposition: "restock" | "merma";
    costMinor: string;
    cogsReversalMinor: string;
  }>;
}

type OrderRecord = Prisma.OperationOrderGetPayload<{ include: { lines: true } }>;
type OrderLine = OrderRecord["lines"][number] & { nominalPreparedQuantity: string };
type Order = Omit<OrderRecord, "lines"> & { lines: OrderLine[] };
type BalanceWithLot = Prisma.StockBalanceGetPayload<{ include: { lot: true } }>;
type StockObjectScope = Awaited<ReturnType<typeof objectScope>>;
type Preparation = Prisma.PreparationAllocationGetPayload<object>;
type PreparationLimitCoverage = "approved" | "demo_missing_approved_rule";

const ZERO = 0n;
const DELIVERY_QUANTITY_AUDIT = "order_delivery_quantities_reported";

function quantityUnit(unit: string): QuantityUnit {
  if (unit === "g" || unit === "ud") return unit;
  throw new OperationError(422, "STOCK_UNIT_UNSUPPORTED", "La unidad debe ser gramos o unidades enteras");
}

async function scopedBalance(ctx:CommandContext,id:string){
  const balance=await ctx.tx.stockBalance.findUnique({where:{id},include:{lot:true}});
  if(!balance)throw new OperationError(404,"STOCK_BALANCE_NOT_FOUND","Saldo de stock no encontrado");
  await requireStockObjectScope(ctx,[balance.locationId],[balance.custodianId]);
  return balance;
}

function assertStockObjectScope(scope:StockObjectScope,locationIds:string[],custodianIds:string[]):void{
  if(scope.locationIds&&locationIds.some(id=>!scope.locationIds!.includes(id)))throw new OperationError(403,"LOCATION_SCOPE","Ubicación fuera de tu alcance");
  if(scope.custodianIds&&custodianIds.some(id=>!scope.custodianIds!.includes(id)))throw new OperationError(403,"STOCK_CUSTODIAN_SCOPE","Saldo fuera de la custodia autorizada");
}

async function requireStockObjectScope(ctx:CommandContext,locationIds:string[],custodianIds:string[],scope?:StockObjectScope):Promise<StockObjectScope>{
  const resolved=scope??await objectScope(ctx.tx,ctx.actor);
  assertStockObjectScope(resolved,locationIds,custodianIds);
  return resolved;
}

registerCommand("StockWasteRecorded",{kind:"stock",capability:"stock.adjust",create:true,
  schema:z.strictObject({balanceId:objectId,quantity:decimal,reason:z.string().trim().min(1).max(500),evidence}),
  execute:async ctx=>{
    const v=ctx.envelope.data as {balanceId:string;quantity:string;reason:string;evidence:Record<string,unknown>};
    const b=await scopedBalance(ctx,v.balanceId),quantity=positiveQuantity(v.quantity,b.unit,"Merma");
    const balance=await updateBalance(ctx,b.id,-quantity,ZERO);
    const costMinor=checkDatabaseMinor(moneyForQuantity(formatQ(quantity,b.unit),b.lot.unitCost.toString()));
    const fact=await ctx.tx.stockFact.create({data:{requestId:ctx.envelope.requestId,lotId:b.lotId,kind:"waste",quantity:dbQ(quantity,b.unit),unit:b.unit,fromLocationId:b.locationId,fromCustodianId:b.custodianId,costMinor,currency:b.lot.costCurrency,reason:v.reason,actorId:ctx.actor.id,occurredAt:ctx.now}});
    await audit(ctx,"StockWasteRecorded",{balanceId:b.id,evidence:v.evidence});return {balance,fact};
  }});
registerCommand("StockMoved",{kind:"stock",capability:"stock.adjust",create:true,
  schema:z.strictObject({balanceId:objectId,quantity:decimal,toLocationId:objectId,toCustodianId:objectId,reason:z.string().trim().min(1).max(500),evidence}),
  execute:async ctx=>{
    const v=ctx.envelope.data as {balanceId:string;quantity:string;toLocationId:string;toCustodianId:string;reason:string;evidence:Record<string,unknown>};
    const b=await scopedBalance(ctx,v.balanceId),quantity=positiveQuantity(v.quantity,b.unit,"Traslado");
    await requireStockObjectScope(ctx,[v.toLocationId],[v.toCustodianId]);
    if(b.locationId===v.toLocationId&&b.custodianId===v.toCustodianId)throw new OperationError(422,"STOCK_MOVE_SAME_DESTINATION","Elegí otra ubicación o custodia");
    const [location,custodian]=await Promise.all([ctx.tx.location.findFirst({where:{id:v.toLocationId,active:true}}),ctx.tx.user.findFirst({where:{id:v.toCustodianId,active:true}})]);
    if(!location||!custodian)throw new OperationError(422,"STOCK_MOVE_DESTINATION","Destino o custodio no habilitado");
    const source=await updateBalance(ctx,b.id,-quantity,ZERO);
    const destination=await ctx.tx.stockBalance.upsert({where:{lotId_locationId_custodianId:{lotId:b.lotId,locationId:v.toLocationId,custodianId:v.toCustodianId}},create:{id:randomUUID(),lotId:b.lotId,unit:b.unit,locationId:v.toLocationId,custodianId:v.toCustodianId,quantity:dbQ(ZERO,b.unit),reserved:dbQ(ZERO,b.unit)},update:{}});
    const target=await updateBalance(ctx,destination.id,quantity,ZERO);
    const fact=await ctx.tx.stockFact.create({data:{requestId:ctx.envelope.requestId,lotId:b.lotId,kind:"transfer",quantity:dbQ(quantity,b.unit),unit:b.unit,fromLocationId:b.locationId,toLocationId:v.toLocationId,fromCustodianId:b.custodianId,toCustodianId:v.toCustodianId,reason:v.reason,actorId:ctx.actor.id,occurredAt:ctx.now}});
    await audit(ctx,"StockMoved",{evidence:v.evidence});return {source,target,fact};
  }});
registerCommand("StockCountRecorded",{kind:"stockCount",capability:"stock.adjust",create:true,
  schema:z.strictObject({balanceId:objectId,countedQuantity:decimal,evidence}),
  execute:async ctx=>{
    const v=ctx.envelope.data as {balanceId:string;countedQuantity:string;evidence:Record<string,unknown>},b=await scopedBalance(ctx,v.balanceId);
    const quantity=parseQ(v.countedQuantity,b.unit,"Conteo");
    return {count:await ctx.tx.operationalStockCount.create({data:{id:ctx.envelope.targetId,balanceId:b.id,unit:b.unit,recordedQuantity:b.quantity,recordedReserved:b.reserved,countedQuantity:dbQ(quantity,b.unit),countedBy:ctx.actor.id,countedAt:ctx.now,evidence:json(v.evidence)}})};
  }});
registerCommand("StockCountAdjustmentApproved",{kind:"stockCount",capability:"openings.approve",
  schema:z.strictObject({reason:z.string().trim().min(1).max(500),evidence}),
  execute:async ctx=>{
    const count=await ctx.tx.operationalStockCount.findUniqueOrThrow({where:{id:ctx.envelope.targetId}}),b=await scopedBalance(ctx,count.balanceId);
    if(count.status!=="pending")throw new OperationError(409,"STOCK_COUNT_ALREADY_RESOLVED","El conteo ya fue resuelto");
    if(count.countedBy===ctx.actor.id)throw new OperationError(409,"INDEPENDENT_REVIEW_REQUIRED","El ajuste requiere otra persona revisora");
    if(!b.quantity.equals(count.recordedQuantity)||!b.reserved.equals(count.recordedReserved))throw new OperationError(409,"STOCK_COUNT_STALE","El stock cambió después del conteo; realizá otro conteo");
    const delta=parseQ(count.countedQuantity,b.unit,"Contado")-parseQ(b.quantity,b.unit,"Registrado"),balance=await updateBalance(ctx,b.id,delta,ZERO);
    if(delta!==ZERO)await ctx.tx.stockFact.create({data:{requestId:ctx.envelope.requestId,lotId:b.lotId,kind:"count_adjustment",quantity:dbQ(delta,b.unit),unit:b.unit,...(delta<ZERO?{fromLocationId:b.locationId,fromCustodianId:b.custodianId}:{toLocationId:b.locationId,toCustodianId:b.custodianId}),costMinor:checkDatabaseMinor(moneyForQuantity(formatQ(delta<ZERO?-delta:delta,b.unit),b.lot.unitCost.toString()))*(delta<ZERO?-1n:1n),currency:b.lot.costCurrency,reason:ctx.envelope.data.reason as string,actorId:ctx.actor.id,occurredAt:ctx.now}});
    const reviewed=await ctx.tx.operationalStockCount.update({where:{id:count.id},data:{status:"approved",reviewedBy:ctx.actor.id,reviewedAt:ctx.now,resolution:json(ctx.envelope.data)}});
    return {count:reviewed,balance,difference:formatQ(delta,b.unit),classification:"count_difference"};
  }});

function quantityScale(unit: QuantityUnit): number {
  return unit === "g" ? 3 : 0;
}

function parseQ(value: string | Prisma.Decimal, unit: string, field: string): bigint {
  try {
    return parseQuantity(typeof value === "string" ? value : value.toString(), quantityUnit(unit));
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw new OperationError(422, "STOCK_QUANTITY_INVALID", `${field} no respeta la precisión de ${unit}`);
  }
}

function formatQ(value: bigint, unit: string): string {
  return formatDecimal(value, quantityScale(quantityUnit(unit)));
}

function dbQ(value: bigint, unit: string): Prisma.Decimal {
  return new Prisma.Decimal(formatQ(value, unit));
}

function cumulativeAllocationCost(costMinor: bigint, quantity: bigint, actual: bigint): bigint {
  if (actual <= ZERO || quantity < ZERO || quantity > actual)
    throw new OperationError(409, "ALLOCATION_COST_QUANTITY", "La cantidad de costo no corresponde a la preparación física");
  return roundHalfUp(costMinor * quantity, actual);
}

function incrementalAllocationCost(costMinor: bigint, before: bigint, take: bigint, actual: bigint): bigint {
  return cumulativeAllocationCost(costMinor, before + take, actual) - cumulativeAllocationCost(costMinor, before, actual);
}

async function refreshLineCogs(ctx: CommandContext, orderId: string, lineId: string): Promise<void> {
  const allocations = await ctx.tx.preparationAllocation.findMany({
    where: { orderId, lineId },
    select: { id: true, lotId: true, actualQuantity: true, deliveredQuantity: true, returnedDeliveredQuantity: true, costMinor: true },
    orderBy: [{ id: "asc" }],
  });
  const delivered = allocations.filter((allocation) => allocation.deliveredQuantity.gt(0));
  if (delivered.length === 0) {
    await ctx.tx.operationOrderLine.update({ where: { id: lineId }, data: { costMinor: ZERO, costCurrency: null, costCoverage: "unknown" } });
    return;
  }
  const lotIds = [...new Set(delivered.map((allocation) => allocation.lotId))];
  const lots = await ctx.tx.inventoryLot.findMany({ where: { id: { in: lotIds } }, select: { id: true, costCurrency: true } });
  const currencyByLot = new Map(lots.map((lot) => [lot.id, lot.costCurrency]));
  if (lots.length !== lotIds.length || delivered.some((allocation) => !currencyByLot.get(allocation.lotId))) {
    await ctx.tx.operationOrderLine.update({ where: { id: lineId }, data: { costMinor: ZERO, costCurrency: null, costCoverage: "unknown" } });
    return;
  }
  const currencies = new Set(delivered.map((allocation) => currencyByLot.get(allocation.lotId)!));
  if (currencies.size > 1) {
    await ctx.tx.operationOrderLine.update({ where: { id: lineId }, data: { costMinor: ZERO, costCurrency: null, costCoverage: "mixed_currency" } });
    return;
  }
  const unit = (await ctx.tx.operationOrderLine.findUniqueOrThrow({ where: { id: lineId }, select: { unit: true } })).unit;
  let netCost = ZERO;
  for (const allocation of delivered) {
    const actual = parseQ(allocation.actualQuantity, unit, "Preparación física");
    const sold = parseQ(allocation.deliveredQuantity, unit, "Cantidad entregada") - parseQ(allocation.returnedDeliveredQuantity, unit, "Cantidad devuelta por cliente");
    if (sold < ZERO) throw new OperationError(409, "RETURNED_DELIVERY_INVARIANT", "La devolución del cliente supera la cantidad entregada");
    netCost += cumulativeAllocationCost(allocation.costMinor, sold, actual);
  }
  await ctx.tx.operationOrderLine.update({
    where: { id: lineId },
    data: { costMinor: netCost, costCurrency: [...currencies][0]!, costCoverage: "known" },
  });
}

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function fifoBalances(a: BalanceWithLot, b: BalanceWithLot): number {
  return a.lot.receivedAt.getTime() - b.lot.receivedAt.getTime() || compareId(a.lotId, b.lotId) || compareId(a.id, b.id);
}

function fifoPreparations(
  a: Preparation,
  b: Preparation,
  lots: Map<string, Prisma.InventoryLotGetPayload<object>>,
): number {
  const lotA = lots.get(a.lotId);
  const lotB = lots.get(b.lotId);
  if (!lotA || !lotB) return compareId(a.id, b.id);
  return lotA.receivedAt.getTime() - lotB.receivedAt.getTime() || compareId(a.lotId, b.lotId) || compareId(a.id, b.id);
}

async function loadOrder(ctx: CommandContext, orderId: string): Promise<Order> {
  const order = await ctx.tx.operationOrder.findUnique({
    where: { id: orderId },
    include: { lines: { orderBy: { id: "asc" } } },
  });
  if (!order) throw new OperationError(404, "ORDER_NOT_FOUND", "No se encontró el pedido");
  const prepared = await ctx.tx.preparationAllocation.groupBy({
    by: ["lineId"],
    where: { orderId },
    _sum: { requestedQuantity: true },
  });
  const nominalByLine = new Map(prepared.map((row) => [row.lineId, row._sum.requestedQuantity?.toString() ?? "0"]));
  return {
    ...order,
    lines: order.lines.map((line) => ({ ...line, nominalPreparedQuantity: nominalByLine.get(line.id) ?? "0" })),
  };
}

function civilToday(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(now);
}

function rehearsal(): boolean {
  return process.env.DEMO_MODE === "true" || process.env.NODE_ENV === "test" || process.env.OPERATIONAL_REHEARSAL === "true";
}

async function requireOperationalPermission(ctx: CommandContext, memberId: string): Promise<void> {
  const today = civilToday(ctx.now);
  const permission = await ctx.tx.memberPermission.findFirst({
    where: { memberId, kind: "operations", status: "verified", validFrom: { lte: today }, validUntil: { gte: today } },
  });
  if (!permission) throw new OperationError(423, "MEMBER_PERMISSION_PENDING", "El socio requiere un permiso operativo verificado y vigente");
}

interface PreparationLimits {
  maximumGramsPerOrder: bigint;
  maximumExtraGramsPerLine: bigint;
  maximumExtraBps: number;
}

async function activePreparationLimits(ctx: CommandContext): Promise<{ limits: PreparationLimits | null; coverage: PreparationLimitCoverage }> {
  const today = civilToday(ctx.now);
  const rows = await ctx.tx.operationalConfiguration.findMany({
    where: { kind: "preparation_limits", state: "approved", validFrom: { lte: today }, OR: [{ validUntil: null }, { validUntil: { gte: today } }] },
    orderBy: [{ validFrom: "desc" }, { version: "desc" }],
    take: 1,
  });
  const row = rows[0];
  if (!row || !row.approvedBy || !row.approvedAt) return { limits: null, coverage: "demo_missing_approved_rule" };
  const definition = row.definition as Record<string, unknown>;
  try {
    const maximumGramsPerOrder = parseQ(String(definition.maximumGramsPerOrder), "g", "Límite de gramos por pedido");
    const maximumExtraGramsPerLine = parseQ(String(definition.maximumExtraGramsPerLine), "g", "Límite de excedente por renglón");
    const maximumExtraBps = Number(definition.maximumExtraBps);
    if (maximumGramsPerOrder <= ZERO || maximumExtraGramsPerLine < ZERO || !Number.isInteger(maximumExtraBps) || maximumExtraBps < 0 || maximumExtraBps > 10000)
      throw new Error("invalid limits");
    return { limits: { maximumGramsPerOrder, maximumExtraGramsPerLine, maximumExtraBps }, coverage: "approved" };
  } catch {
    throw new OperationError(409, "PREPARATION_LIMITS_INVALID", "La regla aprobada de preparación no tiene límites utilizables");
  }
}

function gramsFromLine(line: OrderLine, quantity: bigint): bigint {
  if (line.unit !== "g") throw new OperationError(422, "STOCK_UNIT_UNSUPPORTED", "Los límites de preparación sólo admiten cantidades en gramos");
  return quantity;
}

function stockOrderResult(order: Order, coverage?: PreparationLimitCoverage): StockOrderResult {
  const lines: StockLineTotals[] = order.lines.map((line) => {
    const unit = quantityUnit(line.unit);
    return {
      lineId: line.id,
      requestedQuantity: formatQ(parseQ(line.requested, unit, "Cantidad pedida"), unit),
      reservedQuantity: "0",
      preparedQuantity: formatQ(parseQ(line.prepared, unit, "Cantidad preparada"), unit),
      deliveredQuantity: formatQ(parseQ(line.delivered, unit, "Cantidad entregada"), unit),
      cancelledQuantity: formatQ(parseQ(line.cancelled, unit, "Cantidad cancelada"), unit),
      returnedQuantity: formatQ(parseQ(line.returned, unit, "Cantidad devuelta"), unit),
      extraQuantity: formatQ(parseQ(line.extra, unit, "Excedente"), unit),
      costMinor: line.costMinor.toString(),
      costCurrency: line.costCurrency,
      costCoverage: line.costCoverage as StockLineTotals["costCoverage"],
    };
  });
  return { orderId: order.id, fulfillmentState: order.fulfillmentState, lines, ...(coverage ? { preparationLimitsCoverage: coverage } : {}) };
}

async function stockOrderResultFor(ctx: CommandContext, orderId: string, coverage?: PreparationLimitCoverage): Promise<StockOrderResult> {
  const order = await loadOrder(ctx, orderId);
  const reservations = await currentReservations(ctx, orderId);
  const balances = reservations.length ? await ctx.tx.stockBalance.findMany({ where: { id: { in: [...new Set(reservations.map((row) => row.balanceId))] } } }) : [];
  await requireStockObjectScope(ctx, balances.map((row) => row.locationId), balances.map((row) => row.custodianId));
  const balanceById = new Map(balances.map((row) => [row.id, row]));
  const reservedByLine = new Map<string, bigint>();
  for (const row of reservations) {
    const balance = balanceById.get(row.balanceId);
    if (!balance) continue;
    reservedByLine.set(row.lineId, (reservedByLine.get(row.lineId) ?? ZERO) + activeRemaining(row, balance.unit));
  }
  const result = stockOrderResult(order, coverage);
  return {
    ...result,
    lines: result.lines.map((line) => {
      const source = order.lines.find((item) => item.id === line.lineId)!;
      return { ...line, reservedQuantity: formatQ(reservedByLine.get(line.lineId) ?? ZERO, source.unit) };
    }),
  };
}

function roundRatio(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= ZERO) throw new OperationError(409, "STOCK_RATIO_INVALID", "No se puede calcular una cantidad proporcional");
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return quotient + (remainder * 2n >= denominator ? 1n : 0n);
}

function maxZero(value: bigint): bigint { return value > ZERO ? value : ZERO; }

async function assertScopedReservationBalances(ctx: CommandContext, rows: Array<{ balanceId: string }>): Promise<void> {
  const ids = [...new Set(rows.map((row) => row.balanceId))];
  if (!ids.length) return;
  const balances = await ctx.tx.stockBalance.findMany({ where: { id: { in: ids } }, select: { id: true, locationId: true, custodianId: true } });
  if (balances.length !== ids.length) throw new OperationError(409, "STOCK_RESERVATION_BALANCE_MISSING", "Una reserva refiere a un saldo inexistente");
  await requireStockObjectScope(ctx, balances.map((balance) => balance.locationId), balances.map((balance) => balance.custodianId));
}

function ensureApprovedLimitsForExtra(
  limits: PreparationLimits | null,
  isRehearsal: boolean,
  line: OrderLine,
  totalPrepared: bigint,
): void {
  const requested = parseQ(line.requested, line.unit, "Cantidad pedida");
  const extra = maxZero(totalPrepared - requested);
  if (extra === ZERO) return;
  if (!limits) {
    if (!isRehearsal) throw new OperationError(423, "PREPARATION_LIMITS_PENDING", "El peso excedente requiere límites de preparación aprobados");
    return;
  }
  if (line.unit !== "g") throw new OperationError(422, "PREPARATION_EXTRA_UNIT", "El excedente sólo está permitido para renglones medidos en gramos");
  if (extra > limits.maximumExtraGramsPerLine || extra * 10_000n > requested * BigInt(limits.maximumExtraBps)) {
    throw new OperationError(422, "PREPARATION_EXTRA_LIMIT", "El peso excedente supera el límite aprobado para el renglón");
  }
}

function enforceOrderGramLimit(order: Order, nextPreparedByLine: Map<string, bigint>, limits: PreparationLimits | null): void {
  if (!limits) return;
  const total = order.lines.reduce((sum, line) => {
    if (line.unit !== "g") return sum;
    return sum + (nextPreparedByLine.get(line.id) ?? parseQ(line.prepared, line.unit, "Cantidad preparada"));
  }, ZERO);
  if (total > limits.maximumGramsPerOrder) {
    throw new OperationError(422, "PREPARATION_ORDER_GRAM_LIMIT", "El peso preparado supera el máximo aprobado por pedido");
  }
}

function lineById(order: Order): Map<string, OrderLine> {
  return new Map(order.lines.map((line) => [line.id, line]));
}

function positiveQuantity(value: string, unit: string, field: string): bigint {
  const parsed = parseQ(value, unit, field);
  if (parsed <= ZERO) throw new OperationError(422, "STOCK_QUANTITY_POSITIVE", `${field} debe ser mayor que cero`);
  return parsed;
}

function activeRemaining(reservation: { quantity: Prisma.Decimal; consumed: Prisma.Decimal }, unit: string): bigint {
  return parseQ(reservation.quantity, unit, "Reserva") - parseQ(reservation.consumed, unit, "Reserva consumida");
}

async function updateBalance(
  ctx: CommandContext,
  balanceId: string,
  quantityDelta: bigint,
  reservedDelta: bigint,
): Promise<Prisma.StockBalanceGetPayload<object>> {
  const current = await ctx.tx.stockBalance.findUnique({ where: { id: balanceId } });
  if (!current) throw new OperationError(404, "STOCK_BALANCE_NOT_FOUND", "No se encontró el saldo de stock");
  const unit = quantityUnit(current.unit);
  const quantity = parseQ(current.quantity, unit, "Stock");
  const reserved = parseQ(current.reserved, unit, "Reserva");
  const nextQuantity = quantity + quantityDelta;
  const nextReserved = reserved + reservedDelta;
  if (nextQuantity < ZERO || nextReserved < ZERO || nextReserved > nextQuantity)
    throw new OperationError(409, "STOCK_BALANCE_INVARIANT", "El movimiento dejaría un saldo o una reserva inválidos");
  return ctx.tx.stockBalance.update({
    where: { id: balanceId },
    data: { quantity: dbQ(nextQuantity, unit), reserved: dbQ(nextReserved, unit) },
  });
}

async function currentReservations(ctx: CommandContext, orderId: string) {
  return ctx.tx.stockReservation.findMany({
    where: { orderId, status: "active" },
    orderBy: [{ lineId: "asc" }, { balanceId: "asc" }, { id: "asc" }],
  });
}

async function reservationResult(
  ctx: CommandContext,
  orderId: string,
  availability?: StockReservationResult["availability"],
): Promise<StockReservationResult> {
  const rows = await currentReservations(ctx, orderId);
  const balanceIds = [...new Set(rows.map((row) => row.balanceId))];
  const balances = balanceIds.length ? await ctx.tx.stockBalance.findMany({ where: { id: { in: balanceIds } } }) : [];
  await requireStockObjectScope(ctx, balances.map((row) => row.locationId), balances.map((row) => row.custodianId));
  const balanceById = new Map(balances.map((row) => [row.id, row]));
  return {
    orderId,
    ...(availability ? { availability } : {}),
    reservations: rows.flatMap((row) => {
      const balance = balanceById.get(row.balanceId);
      if (!balance) return [];
      const remaining = activeRemaining(row, balance.unit);
      if (remaining <= ZERO) return [];
      return [{ lineId: row.lineId, lotId: balance.lotId, balanceId: balance.id, quantity: formatQ(remaining, balance.unit) }];
    }),
  };
}

function openDemand(line: OrderLine): bigint {
  const unit = quantityUnit(line.unit);
  const requested = parseQ(line.requested, unit, "Cantidad pedida");
  const prepared = parseQ(line.nominalPreparedQuantity, unit, "Cantidad preparada nominal");
  const cancelled = parseQ(line.cancelled, unit, "Cantidad cancelada");
  return requested > prepared + cancelled ? requested - prepared - cancelled : ZERO;
}

export async function reserveOrder(ctx: CommandContext, orderId: string): Promise<StockReservationResult> {
  const order = await loadOrder(ctx, orderId);
  await requireOperationalPermission(ctx, order.memberId);
  if (!["draft", "preorder", "confirmed"].includes(order.commercialState))
    throw new OperationError(409, "ORDER_RESERVATION_STATE", "El pedido no permite reservar stock");
  if (!order.lines.length) throw new OperationError(422, "ORDER_LINES_REQUIRED", "El pedido necesita renglones antes de reservar");
  await requireEligibleAppSheetReplacementOrderSkus(ctx.tx, order.id);

  const active = await currentReservations(ctx, orderId);
  const lines = lineById(order);
  const activeByLine = new Map<string, bigint>();
  for (const reservation of active) {
    const line = lines.get(reservation.lineId);
    if (!line) throw new OperationError(409, "RESERVATION_LINE_MISMATCH", "La reserva refiere a un renglón que ya no existe");
    const remaining = activeRemaining(reservation, line.unit);
    if (remaining < ZERO) throw new OperationError(409, "RESERVATION_CORRUPT", "La reserva consumida supera la cantidad reservada");
    activeByLine.set(reservation.lineId, (activeByLine.get(reservation.lineId) ?? ZERO) + remaining);
  }

  const outstandingByLine = new Map<string, bigint>();
  const skuIds = [...new Set(order.lines.map((line) => line.skuId))];
  const skus = await ctx.tx.catalogSku.findMany({ where: { id: { in: skuIds } } });
  const skuById = new Map(skus.map((sku) => [sku.id, sku]));
  for (const line of order.lines) {
    quantityUnit(line.unit);
    const sku = skuById.get(line.skuId);
    if (!sku?.active || sku.unit !== line.unit)
      throw new OperationError(422, "ORDER_SKU_UNAVAILABLE", "El producto del pedido no está activo o cambió de unidad");
    const outstanding = openDemand(line);
    const alreadyReserved = activeByLine.get(line.id) ?? ZERO;
    if (alreadyReserved > outstanding)
      throw new OperationError(409, "RESERVATION_STATE_CONFLICT", "La reserva activa supera la demanda todavía no preparada");
    outstandingByLine.set(line.id, outstanding - alreadyReserved);
  }

  const groups = new Map<string, OrderLine[]>();
  for (const line of order.lines) {
    const key = `${line.skuId}\u0000${line.unit}`;
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }

  const pendingGroups = [...groups.values()].map((group) => ({
    lines: group,
    first: group[0]!,
    demand: group.reduce((sum, line) => sum + (outstandingByLine.get(line.id) ?? ZERO), ZERO),
  })).filter((group) => group.demand > ZERO);
  if (!pendingGroups.length) return reservationResult(ctx, orderId);
  if (order.channel !== "local" && order.channel !== "delivery")
    throw new OperationError(409, "ORDER_CHANNEL_INVALID", "El pedido no tiene un canal de cumplimiento válido");
  const channel: StockAvailabilityChannel = order.channel;
  const scope = await objectScope(ctx.tx, ctx.actor);
  const balances = await ctx.tx.stockBalance.findMany({
    where: {
      unit: { in: [...new Set(pendingGroups.map((group) => group.first.unit))] },
      lot: { skuId: { in: [...new Set(pendingGroups.map((group) => group.first.skuId))] } },
      ...(scope.locationIds !== undefined ? { locationId: { in: scope.locationIds } } : {}),
      ...(scope.custodianIds !== undefined ? { custodianId: { in: scope.custodianIds } } : {}),
    },
    include: { lot: true },
  });
  const assessment = await resolveStockAvailability(ctx.tx, {
    balances,
    channel,
    asOf: civilToday(ctx.now),
    rehearsal: rehearsal(),
  });
  if (assessment.coverage === "pending")
    throw new OperationError(423, "STOCK_AVAILABILITY_PENDING", "La confirmación requiere una regla aprobada de disponibilidad física");
  const availabilityByBalance = new Map(assessment.balances.map((row) => [row.balanceId, row]));
  const availabilityEvidence: NonNullable<StockReservationResult["availability"]> = {
    coverage: assessment.coverage,
    configurationId: assessment.configurationId,
    version: assessment.version,
  };

  for (const group of pendingGroups) {
    const first = group.first;
    const groupDemand = group.demand;
    let pendingFree = ZERO;
    const availableByBalance = balances
      .filter((balance) => balance.unit === first.unit && balance.lot.skuId === first.skuId)
      .flatMap((balance) => {
        const result = availabilityByBalance.get(balance.id);
        if (!result) throw new OperationError(409, "STOCK_AVAILABILITY_INVARIANT", "Falta la evaluación de disponibilidad de un saldo visible");
        if (result.state === "pending") pendingFree += parseQ(result.physicalFreeQuantity, balance.unit, "Stock pendiente de disponibilidad");
        if (result.state !== "available" && result.state !== "rehearsal_compatibility") return [];
        const free = parseQ(result.availableQuantity, balance.unit, "Stock apto para reservar");
        return free > ZERO ? [{ balance, free }] : [];
      });
    availableByBalance.sort((a, b) => fifoBalances(a.balance, b.balance));
    const available = availableByBalance.reduce((sum, row) => sum + row.free, ZERO);
    if (available < groupDemand) {
      if (pendingFree > ZERO)
        throw new OperationError(423, "STOCK_AVAILABILITY_PENDING", "Hay stock visible cuya aptitud para este canal todavía no está definida", {
          skuId: first.skuId,
          requested: formatQ(groupDemand, first.unit),
          approvedAvailable: formatQ(available, first.unit),
          pending: formatQ(pendingFree, first.unit),
        });
      throw new OperationError(409, "STOCK_SHORTAGE", "No hay cantidad apta disponible suficiente para reservar el pedido", {
        skuId: first.skuId,
        requested: formatQ(groupDemand, first.unit),
        available: formatQ(available, first.unit),
      });
    }

    const linesInOrder = [...group.lines].sort((a, b) => compareId(a.id, b.id));
    let lineIndex = 0;
    let lineRemaining = outstandingByLine.get(linesInOrder[0]!.id) ?? ZERO;
    for (const row of availableByBalance) {
      let balanceRemaining = row.free;
      while (balanceRemaining > ZERO && lineIndex < linesInOrder.length) {
        if (lineRemaining === ZERO) {
          lineIndex += 1;
          if (lineIndex >= linesInOrder.length) break;
          lineRemaining = outstandingByLine.get(linesInOrder[lineIndex]!.id) ?? ZERO;
          continue;
        }
        const allocated = balanceRemaining < lineRemaining ? balanceRemaining : lineRemaining;
        await ctx.tx.stockReservation.create({
          data: {
            id: randomUUID(), orderId, lineId: linesInOrder[lineIndex]!.id,
            balanceId: row.balance.id, quantity: dbQ(allocated, first.unit), consumed: dbQ(ZERO, first.unit), status: "active",
          },
        });
        await updateBalance(ctx, row.balance.id, ZERO, allocated);
        balanceRemaining -= allocated;
        lineRemaining -= allocated;
      }
    }
  }
  return reservationResult(ctx, orderId, availabilityEvidence);
}

export async function prepareOrder(
  ctx: CommandContext,
  orderId: string,
  allocations: StockPreparationAllocationInput[],
): Promise<StockOrderResult> {
  const order = await loadOrder(ctx, orderId);
  await requireOperationalPermission(ctx, order.memberId);
  const { limits, coverage } = await activePreparationLimits(ctx);
  if (order.commercialState !== "confirmed")
    throw new OperationError(409, "ORDER_NOT_CONFIRMED", "Confirmá el pedido antes de preparar stock");
  if (!Array.isArray(allocations) || allocations.length === 0)
    throw new OperationError(422, "PREPARATION_ALLOCATIONS_REQUIRED", "Indicá las asignaciones físicas de preparación");
  if (order.fulfillmentState === "dispatched" || order.fulfillmentState === "partially_delivered" || order.fulfillmentState === "delivered")
    throw new OperationError(409, "PREPARATION_AFTER_DISPATCH", "No se puede preparar stock después del despacho");

  const lines = lineById(order);
  const inputKeys = new Set<string>();
  const requestedByReservation = new Map<string, bigint>();
  const actualByBalance = new Map<string, bigint>();
  const preparedByLine = new Map<string, bigint>();
  const nominalPreparedByLine = new Map<string, bigint>();
  const stockRows: Array<{ input: StockPreparationAllocationInput; line: OrderLine; balance: BalanceWithLot; requested: bigint; actual: bigint; cost: bigint }> = [];

  for (const input of allocations) {
    const line = lines.get(input.lineId);
    if (!line) throw new OperationError(422, "PREPARATION_LINE_SCOPE", "El renglón no pertenece al pedido indicado");
    const key = `${input.lineId}\u0000${input.balanceId}`;
    if (inputKeys.has(key)) throw new OperationError(422, "PREPARATION_DUPLICATE_ALLOCATION", "Combiná las cantidades repetidas del mismo renglón y lote");
    inputKeys.add(key);
    const requested = positiveQuantity(input.requestedQuantity, line.unit, "Cantidad reservada a preparar");
    const actual = positiveQuantity(input.actualQuantity, line.unit, "Cantidad física preparada");
    if (actual < requested)
      throw new OperationError(422, "ACTUAL_BELOW_RESERVED", "La cantidad física preparada no puede ser menor que la cantidad solicitada");
    if (line.unit === "ud" && actual !== requested)
      throw new OperationError(422, "UNIT_WEIGHT_EXTRA", "Las unidades enteras no admiten diferencias de pesaje");
    const extra = actual - requested;
    if (extra > ZERO) {
      if (!limits && !rehearsal()) throw new OperationError(423, "PREPARATION_LIMITS_REQUIRED", "El pesaje con excedente requiere límites de preparación aprobados");
      if (limits && (line.unit !== "g" || extra > limits.maximumExtraGramsPerLine || extra * 10000n > requested * BigInt(limits.maximumExtraBps)))
        throw new OperationError(422, "PREPARATION_EXTRA_LIMIT", "El excedente supera el límite aprobado para el renglón");
    }
    const balance = await ctx.tx.stockBalance.findUnique({ where: { id: input.balanceId }, include: { lot: true } });
    if (!balance || balance.lotId !== input.lotId || balance.lot.skuId !== line.skuId || balance.unit !== line.unit || balance.lot.unit !== line.unit)
      throw new OperationError(422, "PREPARATION_STOCK_SCOPE", "El lote y el saldo no corresponden al producto y unidad del renglón");
    await requireStockObjectScope(ctx, [balance.locationId], [balance.custodianId]);
    const reservationKey = `${line.id}\u0000${balance.id}`;
    requestedByReservation.set(reservationKey, (requestedByReservation.get(reservationKey) ?? ZERO) + requested);
    actualByBalance.set(balance.id, (actualByBalance.get(balance.id) ?? ZERO) + actual);
    preparedByLine.set(line.id, (preparedByLine.get(line.id) ?? ZERO) + actual);
    nominalPreparedByLine.set(line.id, (nominalPreparedByLine.get(line.id) ?? ZERO) + requested);
    const cost = moneyForQuantity(formatQ(actual, line.unit), balance.lot.unitCost.toString());
    stockRows.push({ input, line, balance, requested, actual, cost });
  }

  for (const line of order.lines) {
    const preparedDelta = preparedByLine.get(line.id) ?? ZERO;
    if (preparedDelta === ZERO) continue;
    const nominalDelta = nominalPreparedByLine.get(line.id) ?? ZERO;
    if (nominalDelta > openDemand(line)) throw new OperationError(409, "PREPARATION_DEMAND_EXCEEDED", "La preparación supera la cantidad nominal pendiente");
    const requested = parseQ(line.nominalPreparedQuantity, line.unit, "Cantidad preparada nominal") + nominalDelta;
    const totalPrepared = parseQ(line.prepared, line.unit, "Cantidad preparada") + preparedDelta;
    const extra = totalPrepared > requested ? totalPrepared - requested : ZERO;
    if (extra > ZERO) {
      if (!limits && !rehearsal()) throw new OperationError(423, "PREPARATION_LIMITS_REQUIRED", "El pesaje con excedente requiere límites de preparación aprobados");
      if (limits && (line.unit !== "g" || extra > limits.maximumExtraGramsPerLine || extra * 10000n > requested * BigInt(limits.maximumExtraBps)))
        throw new OperationError(422, "PREPARATION_EXTRA_LIMIT", "El excedente acumulado supera el límite aprobado para el renglón");
    }
  }

  const totalOrderGrams = order.lines.filter((line) => line.unit === "g").reduce((sum, line) => sum + parseQ(line.prepared, "g", "Cantidad preparada"), ZERO)
    + stockRows.filter((row) => row.line.unit === "g").reduce((sum, row) => sum + row.actual, ZERO);
  if (limits && totalOrderGrams > limits.maximumGramsPerOrder)
    throw new OperationError(422, "PREPARATION_ORDER_LIMIT", "El peso total preparado supera el límite aprobado por pedido");

  const reservationRows = await ctx.tx.stockReservation.findMany({
    where: { orderId, status: "active" },
    orderBy: [{ lineId: "asc" }, { balanceId: "asc" }, { id: "asc" }],
  });
  const reservationByKey = new Map(reservationRows.map((row) => [`${row.lineId}\u0000${row.balanceId}`, row]));
  for (const [key, requested] of requestedByReservation) {
    const reservation = reservationByKey.get(key);
    if (!reservation) throw new OperationError(409, "PREPARATION_RESERVATION_REQUIRED", "Prepará únicamente cantidades reservadas para este pedido y lote");
    const line = lines.get(reservation.lineId)!;
    const remaining = activeRemaining(reservation, line.unit);
    if (remaining < requested) throw new OperationError(409, "PREPARATION_RESERVATION_EXCEEDED", "La preparación supera la reserva activa del lote");
  }

  for (const row of stockRows) {
    const reservation = reservationByKey.get(`${row.line.id}\u0000${row.balance.id}`)!;
    const totalRequested = requestedByReservation.get(`${row.line.id}\u0000${row.balance.id}`)!;
    const consumedThisCall = stockRows
      .filter((other) => other.line.id === row.line.id && other.balance.id === row.balance.id)
      .slice(0, stockRows.indexOf(row) + 1)
      .reduce((sum, other) => sum + other.requested, ZERO);
    const reservationBefore = activeRemaining(reservation, row.line.unit);
    const reservationAfter = reservationBefore - consumedThisCall;
    const currentBalance = await ctx.tx.stockBalance.findUniqueOrThrow({ where: { id: row.balance.id } });
    const currentQuantity = parseQ(currentBalance.quantity, row.line.unit, "Stock");
    const currentReserved = parseQ(currentBalance.reserved, row.line.unit, "Reserva");
    const stillReservedAfter = currentReserved - row.requested;
    if (currentReserved < row.requested || stillReservedAfter < ZERO)
      throw new OperationError(409, "STOCK_RESERVATION_INVARIANT", "La reserva física del lote quedó inconsistente");
    const free = currentQuantity - currentReserved;
    const freeAfterReleasingRequested = free + row.requested;
    if (row.actual > freeAfterReleasingRequested)
      throw new OperationError(409, "PREPARATION_EXTRA_UNAVAILABLE", "El excedente pesado supera el stock libre del lote");
    const nextQuantity = currentQuantity - row.actual;
    if (nextQuantity < stillReservedAfter)
      throw new OperationError(409, "STOCK_RESERVATION_INVARIANT", "La preparación dejaría otras reservas sin cobertura");
    await ctx.tx.stockBalance.update({
      where: { id: row.balance.id },
      data: { quantity: dbQ(nextQuantity, row.line.unit), reserved: dbQ(stillReservedAfter, row.line.unit) },
    });
    await ctx.tx.stockReservation.update({
      where: { id: reservation.id },
      data: {
        consumed: dbQ(parseQ(reservation.consumed, row.line.unit, "Reserva consumida") + consumedThisCall, row.line.unit),
        status: reservationAfter === ZERO ? "consumed" : "active",
      },
    });
    await ctx.tx.preparationAllocation.create({
      data: {
        id: randomUUID(), orderId, lineId: row.line.id, lotId: row.balance.lotId, balanceId: row.balance.id,
        requestedQuantity: dbQ(row.requested, row.line.unit), actualQuantity: dbQ(row.actual, row.line.unit),
        costMinor: row.cost, state: "prepared",
      },
    });
    await ctx.tx.stockFact.create({
      data: {
        requestId: ctx.envelope.requestId, lotId: row.balance.lotId, orderId, lineId: row.line.id,
        kind: "preparation", quantity: dbQ(row.actual, row.line.unit), unit: row.line.unit,
        fromLocationId: row.balance.locationId, fromCustodianId: row.balance.custodianId,
        costMinor: row.cost, currency: row.balance.lot.costCurrency, reason: "order_preparation",
        actorId: ctx.actor.id, occurredAt: ctx.now,
      },
    });
    // The balance and reservation are updated once per submitted allocation.
    // Validate the aggregate above so repeated line/lote requests cannot overspend.
    if (consumedThisCall > totalRequested)
      throw new OperationError(409, "PREPARATION_RESERVATION_EXCEEDED", "La preparación supera la reserva agregada");
  }

  for (const line of order.lines) {
    const preparedDelta = preparedByLine.get(line.id) ?? ZERO;
    if (preparedDelta === ZERO) continue;
    const totalPrepared = parseQ(line.prepared, line.unit, "Cantidad preparada") + preparedDelta;
    const nominalPrepared = parseQ(line.nominalPreparedQuantity, line.unit, "Cantidad preparada nominal") + (nominalPreparedByLine.get(line.id) ?? ZERO);
    const extra = totalPrepared - nominalPrepared;
    await ctx.tx.operationOrderLine.update({
      where: { id: line.id },
      data: {
        prepared: dbQ(totalPrepared, line.unit),
        extra: dbQ(extra, line.unit),
      },
    });
  }
  const updated = await loadOrder(ctx, orderId);
  const complete = updated.lines.every((line) => openDemand(line) === ZERO);
  const hasPreparation = updated.lines.some((line) => parseQ(line.prepared, line.unit, "Cantidad preparada") > ZERO);
  const fulfillmentState = complete ? "prepared" : hasPreparation ? "partially_prepared" : "unprepared";
  await ctx.tx.operationOrder.update({ where: { id: orderId }, data: { fulfillmentState } });
  return stockOrderResultFor(ctx, orderId, coverage);
}

export async function releaseOrderReservations(ctx: CommandContext, orderId: string): Promise<StockReservationResult> {
  const order = await loadOrder(ctx, orderId);
  const allocations = await ctx.tx.preparationAllocation.findMany({ where: { orderId }, orderBy: [{ lineId: "asc" }, { lotId: "asc" }, { id: "asc" }] });
  if (allocations.some((row) => ["dispatched", "partially_delivered", "delivered", "partially_returned"].includes(row.state)))
    throw new OperationError(409, "PHYSICAL_RETURN_REQUIRED", "El stock despachado requiere una devolución física inspeccionada");
  const rows = await currentReservations(ctx, orderId);
  const balanceIds = [...new Set([...rows.map((row) => row.balanceId), ...allocations.map((row) => row.balanceId)])];
  const balances = balanceIds.length ? await ctx.tx.stockBalance.findMany({ where: { id: { in: balanceIds } }, include: { lot: true } }) : [];
  await requireStockObjectScope(ctx, balances.map((row) => row.locationId), balances.map((row) => row.custodianId));
  const balanceById = new Map(balances.map((row) => [row.id, row]));
  const ordered = [...rows].sort((a, b) => {
    const aa = balanceById.get(a.balanceId), bb = balanceById.get(b.balanceId);
    if (!aa || !bb) return compareId(a.id, b.id);
    return fifoBalances(aa, bb) || compareId(a.lineId, b.lineId) || compareId(a.id, b.id);
  });
  for (const reservation of ordered) {
    const balance = balanceById.get(reservation.balanceId);
    const line = order.lines.find((item) => item.id === reservation.lineId);
    if (!balance || !line) throw new OperationError(409, "RESERVATION_CORRUPT", "La reserva ya no corresponde al pedido");
    const remaining = activeRemaining(reservation, line.unit);
    if (remaining <= ZERO) continue;
    await updateBalance(ctx, balance.id, ZERO, -remaining);
    const consumed = parseQ(reservation.consumed, line.unit, "Reserva consumida");
    await ctx.tx.stockReservation.update({ where: { id: reservation.id }, data: { quantity: dbQ(consumed, line.unit), status: consumed === ZERO ? "released" : "consumed" } });
  }
  const returnedPrepared = new Map<string, bigint>();
  for (const allocation of allocations) {
    if (! ["prepared", "partially_prepared"].includes(allocation.state)) continue;
    const balance = balanceById.get(allocation.balanceId);
    const line = order.lines.find((item) => item.id === allocation.lineId);
    if (!balance || !line) throw new OperationError(409, "PREPARATION_ALLOCATION_CORRUPT", "La preparación ya no corresponde al pedido");
    const quantity = parseQ(allocation.actualQuantity, line.unit, "Cantidad preparada");
    if (quantity <= ZERO) continue;
    await updateBalance(ctx, balance.id, quantity, ZERO);
    await ctx.tx.preparationAllocation.update({ where: { id: allocation.id }, data: { state: "cancelled_restocked" } });
    await ctx.tx.stockFact.create({ data: {
      requestId: ctx.envelope.requestId, lotId: allocation.lotId, orderId, lineId: line.id, kind: "return",
      quantity: dbQ(quantity, line.unit), unit: line.unit,
      fromLocationId: balance.locationId, toLocationId: balance.locationId,
      fromCustodianId: ctx.actor.id, toCustodianId: balance.custodianId,
      costMinor: allocation.costMinor, currency: balance.lot.costCurrency,
      reason: "pre_dispatch_cancellation_restock", actorId: ctx.actor.id, occurredAt: ctx.now,
    } });
    returnedPrepared.set(line.unit, (returnedPrepared.get(line.unit) ?? ZERO) + quantity);
  }
  const result = await reservationResult(ctx, orderId);
  const byUnit = Object.fromEntries([...returnedPrepared].map(([unit, quantity]) => [unit, formatQ(quantity, unit)]));
  return { ...result, ...(Object.keys(byUnit).length ? { returnedPreparedByUnit: byUnit } : {}), ...(Object.keys(byUnit).length === 1 ? { returnedPreparedQuantity: Object.values(byUnit)[0] } : {}) };
}

export async function cancelOrderLines(
  ctx: CommandContext,
  orderId: string,
  linesInput: Array<{ lineId: string; quantity: string }>,
): Promise<StockOrderResult> {
  const order = await loadOrder(ctx, orderId);
  if (order.commercialState !== "confirmed" || ["dispatched", "partially_delivered", "delivered"].includes(order.fulfillmentState))
    throw new OperationError(409, "ORDER_LINE_CANCELLATION_STATE", "Sólo se pueden cancelar cantidades aún no preparadas antes del despacho");
  if (!linesInput.length || new Set(linesInput.map((item) => item.lineId)).size !== linesInput.length)
    throw new OperationError(422, "ORDER_LINE_CANCELLATION_DUPLICATE", "Indicá renglones únicos para cancelar");
  const byId = lineById(order);
  const cancelByLine = new Map<string, bigint>();
  for (const input of linesInput) {
    const line = byId.get(input.lineId);
    if (!line) throw new OperationError(422, "ORDER_LINE_SCOPE", "El renglón no pertenece al pedido");
    const quantity = positiveQuantity(input.quantity, line.unit, "Cantidad a cancelar");
    if (quantity > openDemand(line)) throw new OperationError(422, "ORDER_LINE_CANCELLATION_LIMIT", "La cancelación supera la cantidad todavía no preparada");
    cancelByLine.set(line.id, quantity);
  }
  for (const [lineId, quantity] of cancelByLine) {
    const line = byId.get(lineId)!;
    const reservations = await ctx.tx.stockReservation.findMany({ where: { orderId, lineId, status: "active" } });
    const balanceIds = [...new Set(reservations.map((row) => row.balanceId))];
    const balances = balanceIds.length ? await ctx.tx.stockBalance.findMany({ where: { id: { in: balanceIds } }, include: { lot: true } }) : [];
    await requireStockObjectScope(ctx, balances.map((row) => row.locationId), balances.map((row) => row.custodianId));
    const balanceById = new Map(balances.map((row) => [row.id, row]));
    const fifo = [...reservations].sort((a, b) => {
      const aa = balanceById.get(a.balanceId), bb = balanceById.get(b.balanceId);
      return aa && bb ? fifoBalances(aa, bb) || compareId(a.id, b.id) : compareId(a.id, b.id);
    });
    let release = quantity;
    for (const reservation of fifo) {
      if (release <= ZERO) break;
      const balance = balanceById.get(reservation.balanceId);
      if (!balance) throw new OperationError(409, "RESERVATION_CORRUPT", "No se encontró el saldo de una reserva activa");
      const remaining = activeRemaining(reservation, line.unit);
      const take = remaining < release ? remaining : release;
      if (take <= ZERO) continue;
      await updateBalance(ctx, balance.id, ZERO, -take);
      const consumed = parseQ(reservation.consumed, line.unit, "Reserva consumida");
      const quantityAfter = parseQ(reservation.quantity, line.unit, "Reserva") - take;
      await ctx.tx.stockReservation.update({ where: { id: reservation.id }, data: { quantity: dbQ(quantityAfter, line.unit), status: quantityAfter === consumed ? (consumed === ZERO ? "released" : "consumed") : "active" } });
      release -= take;
    }
    await ctx.tx.operationOrderLine.update({ where: { id: line.id }, data: { cancelled: { increment: dbQ(quantity, line.unit) } } });
  }
  const updated = await loadOrder(ctx, orderId);
  const complete = updated.lines.every((line) => openDemand(line) === ZERO);
  const hasPreparation = updated.lines.some((line) => parseQ(line.prepared, line.unit, "Preparado") > ZERO);
  await ctx.tx.operationOrder.update({ where: { id: orderId }, data: { fulfillmentState: complete ? (hasPreparation ? "prepared" : "cancelled") : hasPreparation ? "partially_prepared" : "unprepared" } });
  return stockOrderResultFor(ctx, orderId);
}

export async function dispatchOrder(ctx: CommandContext, orderId: string, driverId?: string): Promise<StockOrderResult> {
  const order = await loadOrder(ctx, orderId);
  if (order.commercialState !== "confirmed") throw new OperationError(409, "ORDER_NOT_CONFIRMED", "Sólo se despacha un pedido confirmado");
  await requireOperationalPermission(ctx, order.memberId);
  const { limits, coverage } = await activePreparationLimits(ctx);
  if (!limits && !rehearsal()) throw new OperationError(423, "PREPARATION_LIMITS_REQUIRED", "El despacho requiere límites de preparación aprobados");
  const complete = order.lines.every((line) => openDemand(line) === ZERO);
  if (!complete) throw new OperationError(409, "ORDER_PREPARATION_INCOMPLETE", "Prepará o cancelá las cantidades pendientes antes del despacho");
  const grams = order.lines.filter((line) => line.unit === "g").reduce((sum, line) => sum + parseQ(line.prepared, "g", "Preparado"), ZERO);
  if (limits && grams > limits.maximumGramsPerOrder) throw new OperationError(422, "PREPARATION_ORDER_LIMIT", "El peso total supera el límite aprobado");
  const allocations = await ctx.tx.preparationAllocation.findMany({ where: { orderId, state: { in: ["prepared", "partially_prepared"] } }, orderBy: [{ lineId: "asc" }, { lotId: "asc" }, { id: "asc" }] });
  const balances = allocations.length ? await ctx.tx.stockBalance.findMany({ where: { id: { in: [...new Set(allocations.map((row) => row.balanceId))] } } }) : [];
  const balanceById = new Map(balances.map((row) => [row.id, row]));
  await requireStockObjectScope(ctx, balances.map((row) => row.locationId), balances.map((row) => row.custodianId));
  const allocatedByLine = new Map<string, bigint>();
  for (const allocation of allocations) {
    const line = order.lines.find((item) => item.id === allocation.lineId);
    if (!line) throw new OperationError(409, "PREPARATION_ALLOCATION_CORRUPT", "La preparación no pertenece a un renglón del pedido");
    allocatedByLine.set(line.id, (allocatedByLine.get(line.id) ?? ZERO) + parseQ(allocation.actualQuantity, line.unit, "Cantidad preparada"));
  }
  for (const line of order.lines) if ((allocatedByLine.get(line.id) ?? ZERO) !== parseQ(line.prepared, line.unit, "Cantidad preparada"))
    throw new OperationError(409, "PREPARATION_ALLOCATION_MISMATCH", "Las asignaciones físicas no coinciden con las cantidades preparadas del pedido");
  if (driverId) {
    const assignment = await ctx.tx.deliveryAssignment.findFirst({ where: { orderId, driverId } });
    if (!assignment) throw new OperationError(422, "DELIVERY_DRIVER_SCOPE", "El repartidor no está asignado a este pedido");
  }
  for (const allocation of allocations) {
    const balance = balanceById.get(allocation.balanceId);
    const line = order.lines.find((item) => item.id === allocation.lineId);
    if (!balance || !line) throw new OperationError(409, "PREPARATION_ALLOCATION_CORRUPT", "La preparación perdió su saldo de origen");
    await ctx.tx.preparationAllocation.update({ where: { id: allocation.id }, data: { state: "dispatched" } });
    await ctx.tx.stockFact.create({ data: {
      requestId: ctx.envelope.requestId, lotId: allocation.lotId, orderId, lineId: line.id, kind: "dispatch",
      quantity: allocation.actualQuantity, unit: line.unit, fromLocationId: balance.locationId,
      toCustodianId: driverId ?? ctx.actor.id, fromCustodianId: balance.custodianId,
      costMinor: allocation.costMinor, currency: balance.lotId ? (await ctx.tx.inventoryLot.findUniqueOrThrow({ where: { id: allocation.lotId }, select: { costCurrency: true } })).costCurrency : order.currency,
      reason: driverId ? "delivery_dispatch" : "local_pickup_dispatch", actorId: ctx.actor.id, occurredAt: ctx.now,
    } });
  }
  await ctx.tx.operationOrder.update({ where: { id: orderId }, data: { fulfillmentState: order.lines.every((line) => parseQ(line.cancelled, line.unit, "Cancelado") >= parseQ(line.requested, line.unit, "Pedido")) ? "delivered" : "dispatched" } });
  return stockOrderResultFor(ctx, orderId, coverage);
}

export async function deliverOrder(ctx: CommandContext, orderId: string, inputs: StockLineDeliveryInput[]): Promise<StockOrderResult> {
  const order = await loadOrder(ctx, orderId);
  if (! ["dispatched", "partially_delivered"].includes(order.fulfillmentState)) {
    const complete = order.lines.every((line) => parseQ(line.delivered, line.unit, "Entregado") + parseQ(line.cancelled, line.unit, "Cancelado") >= parseQ(line.requested, line.unit, "Pedido"));
    if (complete) return stockOrderResultFor(ctx, orderId);
    throw new OperationError(409, "ORDER_NOT_DISPATCHED", "El pedido todavía no está despachado");
  }
  await requireOperationalPermission(ctx, order.memberId);
  const { limits: deliveryLimits, coverage } = await activePreparationLimits(ctx);
  if (!inputs.length || new Set(inputs.map((row) => row.lineId)).size !== inputs.length)
    throw new OperationError(422, "DELIVERY_LINE_DUPLICATE", "Indicá renglones únicos para entregar");
  const lines = lineById(order);
  const allocations = await ctx.tx.preparationAllocation.findMany({ where: { orderId, state: { in: ["dispatched", "partially_returned"] } }, orderBy: [{ lineId: "asc" }, { id: "asc" }] });
  const allocationBalances = allocations.length ? await ctx.tx.stockBalance.findMany({ where: { id: { in: [...new Set(allocations.map((row) => row.balanceId))] } }, include: { lot: true } }) : [];
  const balanceById = new Map(allocationBalances.map((row) => [row.id, row]));
  await requireStockObjectScope(ctx, allocationBalances.map((row) => row.locationId), allocationBalances.map((row) => row.custodianId));
  const assignment = await ctx.tx.deliveryAssignment.findFirst({ where: { orderId, status: { in: ["dispatched", "partially_delivered"] } }, select: { driverId: true } });
  for (const input of inputs) {
    const line = lines.get(input.lineId);
    if (!line) throw new OperationError(422, "DELIVERY_LINE_SCOPE", "El renglón no pertenece al pedido");
    const quantity = positiveQuantity(input.quantity, line.unit, "Cantidad entregada");
    const physical = positiveQuantity(input.actualQuantity ?? input.quantity, line.unit, "Peso físico entregado");
    if (line.unit === "ud" && physical !== quantity) throw new OperationError(422, "UNIT_DELIVERY_WEIGHT", "Las unidades enteras no admiten diferencias de pesaje");
    if (physical > quantity) {
      const extra = physical - quantity;
      if (!deliveryLimits && !rehearsal()) throw new OperationError(423, "PREPARATION_LIMITS_REQUIRED", "La entrega con excedente requiere límites de preparación aprobados");
      if (deliveryLimits && (line.unit !== "g" || extra > deliveryLimits.maximumExtraGramsPerLine || extra * 10000n > quantity * BigInt(deliveryLimits.maximumExtraBps)))
        throw new OperationError(422, "DELIVERY_EXTRA_LIMIT", "El peso entregado supera el límite aprobado");
    }
    const requested = parseQ(line.requested, line.unit, "Pedido"), delivered = parseQ(line.delivered, line.unit, "Entregado"), cancelled = parseQ(line.cancelled, line.unit, "Cancelado");
    if (quantity > requested - delivered - cancelled) throw new OperationError(422, "DELIVERY_QUANTITY_LIMIT", "La entrega supera la cantidad todavía pendiente");
    const available = allocations.filter((row) => row.lineId === line.id).reduce((sum, row) => {
      const actual = parseQ(row.actualQuantity, line.unit, "Preparado");
      const delivered = parseQ(row.deliveredQuantity, line.unit, "Entregado físicamente");
      const returned = parseQ(row.returnedQuantity, line.unit, "Devuelto");
      const returnedDelivered = parseQ(row.returnedDeliveredQuantity, line.unit, "Devuelto por cliente");
      return sum + actual - delivered - (returned - returnedDelivered);
    }, ZERO);
    if (physical > available) throw new OperationError(422, "DELIVERY_PHYSICAL_LIMIT", "La cantidad física supera lo despachado disponible");
    let remaining = physical;
    for (const allocation of allocations.filter((row) => row.lineId === line.id)) {
      if (remaining <= ZERO) break;
      const actual = parseQ(allocation.actualQuantity, line.unit, "Preparado");
      const delivered = parseQ(allocation.deliveredQuantity, line.unit, "Entregado físicamente");
      const returned = parseQ(allocation.returnedQuantity, line.unit, "Devuelto");
      const returnedDelivered = parseQ(allocation.returnedDeliveredQuantity, line.unit, "Devuelto por cliente");
      const undeliveredReturned = returned - returnedDelivered;
      const free = actual - delivered - undeliveredReturned;
      const take = free < remaining ? free : remaining;
      if (take <= ZERO) continue;
      const balance = balanceById.get(allocation.balanceId)!;
      const nextDelivered = delivered + take;
      const allocationComplete = nextDelivered + undeliveredReturned >= actual;
      const nextState = allocationComplete ? (returned >= actual ? "returned" : returned > ZERO ? "partially_returned" : "delivered") : returned > ZERO ? "partially_returned" : "dispatched";
      const costMinor = incrementalAllocationCost(BigInt(allocation.costMinor), delivered, take, actual);
      await ctx.tx.preparationAllocation.update({ where: { id: allocation.id }, data: { deliveredQuantity: dbQ(nextDelivered, line.unit), state: nextState } });
      await ctx.tx.stockFact.create({ data: {
        requestId: ctx.envelope.requestId, lotId: allocation.lotId, orderId, lineId: line.id, kind: "delivery",
        quantity: dbQ(take, line.unit), unit: line.unit, fromLocationId: balance.locationId,
        fromCustodianId: assignment?.driverId ?? ctx.actor.id, costMinor,
        currency: balance.lot.costCurrency, reason: "order_delivery", actorId: ctx.actor.id, occurredAt: ctx.now,
      } });
      remaining -= take;
    }
    await ctx.tx.operationOrderLine.update({ where: { id: line.id }, data: { delivered: { increment: dbQ(quantity, line.unit) } } });
    await refreshLineCogs(ctx, orderId, line.id);
  }
  const updated = await loadOrder(ctx, orderId);
  const complete = updated.lines.every((line) => parseQ(line.delivered, line.unit, "Entregado") + parseQ(line.cancelled, line.unit, "Cancelado") >= parseQ(line.requested, line.unit, "Pedido"));
  await ctx.tx.operationOrder.update({ where: { id: orderId }, data: { fulfillmentState: complete ? "delivered" : "partially_delivered" } });
  return stockOrderResultFor(ctx, orderId, coverage);
}

export async function inspectOrderReturn(ctx: CommandContext, orderId: string, inputs: StockReturnInput[]): Promise<StockReturnResult> {
  const order = await loadOrder(ctx, orderId);
  if (!["dispatched", "partially_delivered", "delivered"].includes(order.fulfillmentState))
    throw new OperationError(409, "ORDER_RETURN_STATE", "Sólo se inspecciona stock que ya salió bajo custodia de reparto");
  if (!inputs.length) throw new OperationError(422, "ORDER_RETURN_REQUIRED", "Indicá las cantidades físicas inspeccionadas");
  if (new Set(inputs.map((row) => row.allocationId)).size !== inputs.length)
    throw new OperationError(422, "ORDER_RETURN_DUPLICATE_ALLOCATION", "Cada preparación se inspecciona una sola vez por comando");
  await requireOperationalPermission(ctx, order.memberId);
  const allocations = await ctx.tx.preparationAllocation.findMany({ where: { orderId, state: { in: ["dispatched", "delivered", "partially_returned"] } }, orderBy: [{ lineId: "asc" }, { id: "asc" }] });
  const assignment = await ctx.tx.deliveryAssignment.findFirst({ where: { orderId, driverId: { not: null } }, orderBy: { dispatchedAt: "desc" }, select: { driverId: true } });
  if (assignment?.driverId === ctx.actor.id) throw new OperationError(403, "RETURN_INSPECTOR_INDEPENDENCE", "La devolución debe inspeccionarla alguien distinto del repartidor");
  const sourceCustodianId = assignment?.driverId ?? ctx.actor.id;
  const balances = allocations.length ? await ctx.tx.stockBalance.findMany({ where: { id: { in: [...new Set(allocations.map((row) => row.balanceId))] } }, include: { lot: true } }) : [];
  const balanceById = new Map(balances.map((row) => [row.id, row]));
  await requireStockObjectScope(ctx, balances.map((row) => row.locationId), balances.map((row) => row.custodianId));
  const returned: StockReturnResult["returns"] = [];
  const changedLines = new Set<string>();
  for (const input of inputs) {
    const line = order.lines.find((row) => row.id === input.lineId);
    if (!line) throw new OperationError(422, "ORDER_RETURN_LINE_SCOPE", "El renglón no pertenece al pedido");
    const allocation = allocations.find((row) => row.id === input.allocationId);
    if (!allocation || allocation.lineId !== line.id)
      throw new OperationError(422, "ORDER_RETURN_ALLOCATION_SCOPE", "La preparación no pertenece al renglón y pedido indicados");
    const balance = balanceById.get(allocation.balanceId);
    if (!balance) throw new OperationError(409, "ORDER_RETURN_BALANCE_MISSING", "No se encontró el saldo de origen de la preparación");
    const take = positiveQuantity(input.quantity, line.unit, "Cantidad física devuelta");
    const actual = parseQ(allocation.actualQuantity, line.unit, "Preparado");
    const delivered = parseQ(allocation.deliveredQuantity, line.unit, "Entregado físicamente");
    const alreadyReturned = parseQ(allocation.returnedQuantity, line.unit, "Devuelto");
    const alreadyReturnedDelivered = parseQ(allocation.returnedDeliveredQuantity, line.unit, "Devuelto por cliente");
    const available = input.origin === "customer"
      ? delivered - alreadyReturnedDelivered
      : actual - delivered - (alreadyReturned - alreadyReturnedDelivered);
    if (take > available)
      throw new OperationError(422, input.origin === "customer" ? "CUSTOMER_RETURN_LIMIT" : "UNDELIVERED_RETURN_LIMIT",
        input.origin === "customer" ? "La devolución supera la cantidad ya entregada todavía no devuelta" : "La devolución supera la cantidad preparada que no llegó a entregarse");
    const locationId = input.locationId ?? balance.locationId;
    const custodianId = input.custodianId ?? balance.custodianId;
    await requireStockObjectScope(ctx,[locationId],[custodianId]);
    let destinationBalanceId: string | undefined;
    if (input.disposition === "restock") {
      const destination = await ctx.tx.stockBalance.upsert({
        where: { lotId_locationId_custodianId: { lotId: allocation.lotId, locationId, custodianId } },
        create: { id: randomUUID(), lotId: allocation.lotId, locationId, custodianId, unit: line.unit, quantity: dbQ(ZERO, line.unit), reserved: dbQ(ZERO, line.unit) },
        update: {},
      });
      destinationBalanceId = destination.id;
      await updateBalance(ctx, destination.id, take, ZERO);
    }
    const costMinor = incrementalAllocationCost(BigInt(allocation.costMinor), alreadyReturned, take, actual);
    const cogsReversal = input.origin === "customer"
      ? incrementalAllocationCost(BigInt(allocation.costMinor), alreadyReturnedDelivered, take, actual)
      : ZERO;
    const totalReturned = alreadyReturned + take;
    const totalReturnedDelivered = alreadyReturnedDelivered + (input.origin === "customer" ? take : ZERO);
    const undeliveredReturned = totalReturned - totalReturnedDelivered;
    const allAccountedFor = delivered + undeliveredReturned >= actual;
    const nextState = allAccountedFor
      ? totalReturned >= actual ? "returned" : totalReturned > ZERO ? "partially_returned" : "delivered"
      : totalReturned > ZERO ? "partially_returned" : "dispatched";
    await ctx.tx.preparationAllocation.update({ where: { id: allocation.id }, data: {
      returnedQuantity: dbQ(totalReturned, line.unit),
      returnedDeliveredQuantity: dbQ(totalReturnedDelivered, line.unit),
      state: nextState,
    } });
    await ctx.tx.operationOrderLine.update({ where: { id: line.id }, data: { returned: { increment: dbQ(take, line.unit) } } });
    await ctx.tx.stockFact.create({ data: {
      requestId: ctx.envelope.requestId, lotId: allocation.lotId, orderId, lineId: line.id, kind: "return",
      quantity: dbQ(take, line.unit), unit: line.unit,
      fromLocationId: input.origin === "undelivered" ? balance.locationId : undefined,
      toLocationId: input.disposition === "restock" ? locationId : undefined,
      fromCustodianId: input.origin === "undelivered" ? sourceCustodianId : undefined,
      toCustodianId: input.disposition === "restock" ? custodianId : undefined,
      costMinor, currency: balance.lot.costCurrency,
      reason: `${input.origin}_return_${input.disposition}`,
      actorId: ctx.actor.id, occurredAt: ctx.now,
    } });
    if (cogsReversal > ZERO) {
      await ctx.tx.stockFact.create({ data: {
        requestId: ctx.envelope.requestId, lotId: allocation.lotId, orderId, lineId: line.id, kind: "cogs_reversal",
        quantity: dbQ(take, line.unit), unit: line.unit, costMinor: -cogsReversal,
        currency: balance.lot.costCurrency, reason: "customer_return_cogs_reversal",
        actorId: ctx.actor.id, occurredAt: ctx.now,
      } });
    }
    changedLines.add(line.id);
    returned.push({ lineId: line.id, allocationId: allocation.id, lotId: allocation.lotId, balanceId: destinationBalanceId,
      quantity: formatQ(take, line.unit), origin: input.origin, disposition: input.disposition,
      costMinor: costMinor.toString(), cogsReversalMinor: cogsReversal.toString() });
  }
  for (const lineId of changedLines) await refreshLineCogs(ctx, orderId, lineId);
  const result = await stockOrderResultFor(ctx, orderId);
  return { ...result, returns: returned };
}

const skuFields = {
  code: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(200),
  variety: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(100),
  unit: z.enum(["g", "ud"]),
  minQuantity: decimal.default("0"),
  minVarieties: z.number().int().min(0).max(1000).default(0),
};
const skuCreateSchema = z.strictObject(skuFields);
const skuUpdateSchema = z.strictObject({ ...skuFields, minQuantity: decimal, minVarieties: z.number().int().min(0).max(1000), active: z.boolean() });

registerCommand("CatalogSkuCreated", {
  kind: "sku", capability: "stock.adjust", create: true, schema: z.strictObject({ ...skuFields, evidence }),
  execute: async (ctx) => {
    const { evidence: proof, ...skuData } = ctx.envelope.data;
    const input = skuCreateSchema.parse(skuData);
    parseQ(input.minQuantity, input.unit, "Stock mínimo");
    const sku = await ctx.tx.catalogSku.create({ data: { id: ctx.envelope.targetId, ...input, active: true } });
    await audit(ctx, "CatalogSkuCreated", { skuId: sku.id, evidence: proof });
    return { sku };
  },
});

registerCommand("CatalogSkuUpdated", {
  kind: "sku", capability: "stock.adjust", schema: z.strictObject({ ...skuUpdateSchema.shape, evidence }),
  execute: async (ctx) => {
    const { evidence: proof, ...skuData } = ctx.envelope.data;
    const input = skuUpdateSchema.parse(skuData);
    const current = await ctx.tx.catalogSku.findUnique({ where: { id: ctx.envelope.targetId } });
    if (!current) throw new OperationError(404, "SKU_NOT_FOUND", "No se encontró el producto de catálogo");
    await requireEligibleAppSheetReplacementSkus(ctx.tx, [current.id]);
    parseQ(input.minQuantity, input.unit, "Stock mínimo");
    if (current.unit !== input.unit)
      throw new OperationError(409, "SKU_UNIT_IMMUTABLE", "La unidad de un SKU es inmutable; creá otro SKU para usar una unidad distinta");
    const sku = await ctx.tx.catalogSku.update({ where: { id: current.id }, data: input });
    await audit(ctx, "CatalogSkuUpdated", { skuId: sku.id, evidence: proof });
    await recordAppSheetCanonicalSkuMutation(ctx, current, sku);
    return { sku };
  },
});

const purchaseLineInput = z.strictObject({
  lineId: objectId,
  skuId: objectId,
  unit: z.enum(["g", "ud"]),
  quantity: decimal,
  unitCost: decimal,
});
const purchaseLineStored = z.strictObject({
  lineId: objectId,
  skuId: objectId,
  unit: z.enum(["g", "ud"]),
  quantity: decimal,
  unitCost: decimal,
  lineTotalMinor: z.string().regex(/^(0|[1-9]\d{0,18})$/),
});
type PurchaseLine = z.infer<typeof purchaseLineStored>;

function readPurchaseLines(value: unknown): PurchaseLine[] {
  const parsed = z.array(purchaseLineStored).safeParse(value);
  if (!parsed.success) throw new OperationError(409, "PURCHASE_LINES_CORRUPT", "Los renglones de la compra requieren revisión");
  return parsed.data;
}

function checkDatabaseMinor(value: bigint): bigint {
  if (value < 0n || value > 9223372036854775807n)
    throw new OperationError(422, "PURCHASE_TOTAL_RANGE", "El costo excede el rango monetario admitido");
  return value;
}

function positiveUnitCost(value: string): void {
  let scaled: bigint;
  try {
    scaled = parseDecimal(value, 12);
  } catch {
    throw new OperationError(422, "STOCK_UNIT_COST_INVALID", "El costo unitario requiere hasta doce decimales exactos");
  }
  if (scaled <= ZERO) throw new OperationError(422, "STOCK_UNIT_COST_REQUIRED", "Registrá un costo unitario conocido mayor que cero");
}

registerCommand("PurchaseOrderCreated", {
  kind: "purchase", capability: "purchases.write", create: true,
  schema: z.strictObject({ supplierId: objectId, agreementDate: civilDate, expectedDate: civilDate.optional(), currency, items: z.array(purchaseLineInput).min(1).max(200), evidence }),
  execute: async (ctx) => {
    const input = ctx.envelope.data as { supplierId: string; agreementDate: string; expectedDate?: string; currency: "ARS" | "USD"; items: z.infer<typeof purchaseLineInput>[]; evidence: Record<string, unknown> };
    if (input.expectedDate && input.expectedDate < input.agreementDate)
      throw new OperationError(422, "PURCHASE_DATE_ORDER", "La fecha prevista no puede ser anterior al acuerdo");
    const supplier = await ctx.tx.supplier.findFirst({ where: { id: input.supplierId, active: true }, select: { id: true } });
    if (!supplier) throw new OperationError(422, "PURCHASE_SUPPLIER_REQUIRED", "Elegí un proveedor activo");
    if (new Set(input.items.map((item) => item.lineId)).size !== input.items.length)
      throw new OperationError(422, "PURCHASE_DUPLICATE_LINE", "Cada renglón de compra debe tener un identificador único");
    await requireEligibleAppSheetReplacementSkus(ctx.tx, [...new Set(input.items.map(item => item.skuId))]);
    const stored: PurchaseLine[] = [];
    let totalMinor = ZERO;
    for (const item of input.items) {
      const quantity = positiveQuantity(item.quantity, item.unit, "Cantidad comprada");
      positiveUnitCost(item.unitCost);
      const sku = await ctx.tx.catalogSku.findUnique({ where: { id: item.skuId } });
      if (!sku?.active || sku.unit !== item.unit)
        throw new OperationError(422, "PURCHASE_SKU_SCOPE", "El producto debe estar activo y coincidir con la unidad del renglón");
      const canonicalQuantity = formatQ(quantity, item.unit);
      const lineTotalMinor = checkDatabaseMinor(moneyForQuantity(canonicalQuantity, item.unitCost));
      totalMinor = checkDatabaseMinor(totalMinor + lineTotalMinor);
      stored.push({ ...item, quantity: canonicalQuantity, lineTotalMinor: lineTotalMinor.toString() });
    }
    const order = await ctx.tx.purchaseOrder.create({ data: {
      id: ctx.envelope.targetId, supplierId: supplier.id, agreementDate: input.agreementDate,
      expectedDate: input.expectedDate, currency: input.currency, totalMinor, status: "draft", items: json(stored),
    } });
    await audit(ctx, "PurchaseOrderCreated", { supplierId: supplier.id, totalMinor: totalMinor.toString(), currency: input.currency, items: stored, evidence: input.evidence });
    return { purchaseOrder: order };
  },
});

registerCommand("PurchaseOrderApproved", {
  kind: "purchase", capability: "purchases.write", schema: z.strictObject({ evidence }),
  execute: async (ctx) => {
    const order = await ctx.tx.purchaseOrder.findUnique({ where: { id: ctx.envelope.targetId } });
    if (!order) throw new OperationError(404, "PURCHASE_NOT_FOUND", "No se encontró la compra");
    if (order.status !== "draft") throw new OperationError(409, "PURCHASE_APPROVAL_STATE", "Sólo se puede aprobar una compra en borrador");
    const sourceObject = await ctx.tx.operationObject.findUnique({ where: { id: order.id }, select: { createdBy: true } });
    if (sourceObject?.createdBy === ctx.actor.id)
      throw new OperationError(409, "INDEPENDENT_REVIEW_REQUIRED", "La compra debe aprobarla alguien distinto de quien la creó");
    const approved = await ctx.tx.purchaseOrder.update({ where: { id: order.id }, data: { status: "approved" } });
    await audit(ctx, "PurchaseOrderApproved", { purchaseId: order.id, evidence: ctx.envelope.data.evidence as Record<string, unknown> });
    return { purchaseOrder: approved, approvedBy: ctx.actor.id, approvedAt: ctx.now };
  },
});

const goodsReceiptItem = z.strictObject({ lineId: objectId, quantity: decimal, lotLabel: z.string().trim().min(1).max(200), expiresOn: civilDate.optional() });
registerCommand("GoodsReceived", {
  kind: "receipt", capability: "stock.receive", create: true,
  schema: z.strictObject({ purchaseId: objectId, receivedDate: civilDate, locationId: objectId, custodianId: objectId.optional(), items: z.array(goodsReceiptItem).min(1).max(200), evidence }),
  execute: async (ctx) => {
    const input = ctx.envelope.data as { purchaseId: string; receivedDate: string; locationId: string; custodianId?: string; items: z.infer<typeof goodsReceiptItem>[]; evidence: Record<string, unknown> };
    if (input.receivedDate > civilToday(ctx.now))
      throw new OperationError(422, "RECEIPT_DATE_FUTURE", "La fecha de recepción no puede ser futura");
    if (input.items.some((item) => item.expiresOn && item.expiresOn < input.receivedDate))
      throw new OperationError(422, "RECEIPT_EXPIRY_DATE", "El vencimiento no puede preceder la recepción física");
    const purchase = await ctx.tx.purchaseOrder.findUnique({ where: { id: input.purchaseId } });
    if (!purchase || !["approved", "partially_received"].includes(purchase.status))
      throw new OperationError(409, "PURCHASE_RECEIPT_STATE", "La compra debe estar aprobada y todavía pendiente de recepción");
    if (new Set(input.items.map((item) => item.lineId)).size !== input.items.length)
      throw new OperationError(422, "RECEIPT_DUPLICATE_LINE", "Cada renglón puede aparecer una sola vez por recepción");
    const location = await ctx.tx.location.findFirst({ where: { id: input.locationId, active: true }, select: { id: true } });
    if (!location) throw new OperationError(422, "RECEIPT_LOCATION_REQUIRED", "Elegí una ubicación activa");
    const custodianId = input.custodianId ?? ctx.actor.id;
    const custodian = await ctx.tx.user.findFirst({ where: { id: custodianId, active: true }, select: { id: true } });
    if (!custodian) throw new OperationError(422, "RECEIPT_CUSTODIAN_REQUIRED", "Elegí una persona activa responsable de la custodia");
    await requireStockObjectScope(ctx,[location.id],[custodian.id]);
    const purchaseLines = readPurchaseLines(purchase.items);
    await requireEligibleAppSheetReplacementSkus(ctx.tx, [...new Set(purchaseLines.map(line => line.skuId))]);
    const purchaseLineById = new Map(purchaseLines.map((line) => [line.lineId, line]));
    const existingReceipts = await ctx.tx.goodsReceipt.findMany({ where: { purchaseId: purchase.id }, select: { items: true } });
    const receivedByLine = new Map<string, bigint>();
    for (const receipt of existingReceipts) {
      if (!Array.isArray(receipt.items)) throw new OperationError(409, "RECEIPT_HISTORY_CORRUPT", "El historial de recepción requiere revisión");
      for (const raw of receipt.items) {
        if (!raw || typeof raw !== "object" || typeof (raw as { lineId?: unknown }).lineId !== "string" || typeof (raw as { quantity?: unknown }).quantity !== "string")
          throw new OperationError(409, "RECEIPT_HISTORY_CORRUPT", "El historial de recepción requiere revisión");
        const line = purchaseLineById.get((raw as { lineId: string }).lineId);
        if (!line) throw new OperationError(409, "RECEIPT_HISTORY_CORRUPT", "El historial referencia un renglón inexistente");
        const quantity = parseQ((raw as { quantity: string }).quantity, line.unit, "Cantidad recibida previamente");
        receivedByLine.set(line.lineId, (receivedByLine.get(line.lineId) ?? ZERO) + quantity);
      }
    }
    const receiptId = ctx.envelope.targetId;
    const receivedAt = new Date(`${input.receivedDate}T12:00:00-03:00`);
    const receiptItems: Array<Record<string, unknown>> = [];
    for (const item of input.items) {
      const line = purchaseLineById.get(item.lineId);
      if (!line) throw new OperationError(422, "RECEIPT_LINE_SCOPE", "El renglón no pertenece a esta compra");
      const sku = await ctx.tx.catalogSku.findUnique({ where: { id: line.skuId } });
      if (!sku || sku.unit !== line.unit) throw new OperationError(409, "RECEIPT_SKU_CHANGED", "El producto o unidad de la compra requiere revisión");
      const quantity = positiveQuantity(item.quantity, line.unit, "Cantidad recibida");
      positiveUnitCost(line.unitCost);
      const ordered = parseQ(line.quantity, line.unit, "Cantidad comprada");
      const previouslyReceived = receivedByLine.get(line.lineId) ?? ZERO;
      if (previouslyReceived + quantity > ordered)
        throw new OperationError(422, "RECEIPT_QUANTITY_LIMIT", "La recepción supera la cantidad acordada pendiente");
      const costMinor = checkDatabaseMinor(moneyForQuantity(formatQ(quantity, line.unit), line.unitCost));
      const lotId = randomUUID();
      const balanceId = randomUUID();
      const lot = await ctx.tx.inventoryLot.create({ data: {
        id: lotId, skuId: sku.id, receiptId, purchaseLineId: line.lineId, label: item.lotLabel,
        unit: line.unit, unitCost: new Prisma.Decimal(line.unitCost), costCurrency: purchase.currency,
        receivedAt, expiresOn: item.expiresOn,
      } });
      await ctx.tx.stockBalance.create({ data: {
        id: balanceId, lotId, locationId: location.id, custodianId: custodian.id,
        unit: line.unit, quantity: dbQ(quantity, line.unit), reserved: dbQ(ZERO, line.unit),
      } });
      await ctx.tx.stockFact.create({ data: {
        requestId: ctx.envelope.requestId, lotId, kind: "receipt", quantity: dbQ(quantity, line.unit), unit: line.unit,
        toLocationId: location.id, toCustodianId: custodian.id, costMinor, currency: purchase.currency,
        reason: "purchase_goods_receipt", actorId: ctx.actor.id, occurredAt: ctx.now,
      } });
      receiptItems.push({ lineId: line.lineId, skuId: sku.id, lotId: lot.id, balanceId, quantity: formatQ(quantity, line.unit), unit: line.unit, unitCost: line.unitCost, costMinor: costMinor.toString(), currency: purchase.currency, lotLabel: item.lotLabel, expiresOn: item.expiresOn ?? null });
      receivedByLine.set(line.lineId, previouslyReceived + quantity);
    }
    const receipt = await ctx.tx.goodsReceipt.create({ data: {
      id: receiptId, purchaseId: purchase.id, receivedDate: input.receivedDate, receivedBy: ctx.actor.id,
      items: json(receiptItems), evidence: json(input.evidence),
    } });
    const fullyReceived = purchaseLines.every((line) => (receivedByLine.get(line.lineId) ?? ZERO) >= parseQ(line.quantity, line.unit, "Cantidad comprada"));
    const updatedPurchase = await ctx.tx.purchaseOrder.update({ where: { id: purchase.id }, data: { status: fullyReceived ? "received" : "partially_received" } });
    await touchAggregate(ctx, purchase.id);
    await audit(ctx, "GoodsReceived", { purchaseId: purchase.id, receiptId, receivedDate: input.receivedDate, items: receiptItems, evidence: input.evidence });
    return { receipt, purchaseOrder: updatedPurchase, lots: receiptItems };
  },
});

const stockOpeningSchema = z.strictObject({
  skuId: objectId,
  label: z.string().trim().min(1).max(200),
  quantity: decimal,
  unitCost: decimal,
  costCurrency: currency,
  receivedDate: civilDate,
  expiresOn: civilDate.optional(),
  locationId: objectId,
  custodianId: objectId.optional(),
  preparedBy: objectId,
  evidence,
  sourceRecordId: objectId.optional(),
});

registerCommand("StockOpeningRecorded", {
  kind: "lot", capability: "openings.approve", create: true, administrative: true,
  schema: stockOpeningSchema,
  authorize: async (ctx) => {
    const input = stockOpeningSchema.parse(ctx.envelope.data);
    const sku = await ctx.tx.catalogSku.findFirst({ where: { id: input.skuId, active: true }, select: { id: true, unit: true, sourceId: true } });
    if (!sku) throw new OperationError(422, "STOCK_OPENING_SKU_REQUIRED", "Elegí un producto de catálogo activo");
    await requireAppSheetOpeningSourceRecord(ctx, input.sourceRecordId, {
      kind: "stock", quantity: input.quantity, unit: sku.unit, skuSourceId: sku.sourceId ?? undefined,
    });
  },
  execute: async (ctx) => {
    const input = stockOpeningSchema.parse(ctx.envelope.data);
    if (input.preparedBy === ctx.actor.id)
      throw new OperationError(409, "INDEPENDENT_REVIEW_REQUIRED", "La apertura requiere una persona preparadora y otra aprobadora");
    if (input.receivedDate > civilToday(ctx.now) || (input.expiresOn && input.expiresOn < input.receivedDate))
      throw new OperationError(422, "STOCK_OPENING_DATE", "La fecha de apertura o vencimiento del lote no es válida");
    const [author, sku, location, custodian] = await Promise.all([
      ctx.tx.user.findFirst({ where: { id: input.preparedBy, active: true }, select: { id: true } }),
      ctx.tx.catalogSku.findFirst({ where: { id: input.skuId, active: true } }),
      ctx.tx.location.findFirst({ where: { id: input.locationId, active: true }, select: { id: true } }),
      ctx.tx.user.findFirst({ where: { id: input.custodianId ?? ctx.actor.id, active: true }, select: { id: true } }),
    ]);
    if (!author) throw new OperationError(422, "STOCK_OPENING_AUTHOR_REQUIRED", "La apertura requiere una persona preparadora activa");
    if (!sku) throw new OperationError(422, "STOCK_OPENING_SKU_REQUIRED", "Elegí un producto de catálogo activo");
    if (!location) throw new OperationError(422, "STOCK_OPENING_LOCATION_REQUIRED", "Elegí una ubicación activa");
    if (!custodian) throw new OperationError(422, "STOCK_OPENING_CUSTODIAN_REQUIRED", "Elegí una persona activa responsable de la custodia");
    await requireStockObjectScope(ctx,[location.id],[custodian.id]);
    const quantity = positiveQuantity(input.quantity, sku.unit, "Cantidad de apertura");
    const sourceRecordId = input.sourceRecordId;
    await requireAppSheetOpeningSourceRecord(ctx, sourceRecordId, {
      kind: "stock", quantity: formatQ(quantity, sku.unit), unit: sku.unit, skuSourceId: sku.sourceId ?? undefined,
    });
    positiveUnitCost(input.unitCost);
    const costMinor = checkDatabaseMinor(moneyForQuantity(formatQ(quantity, sku.unit), input.unitCost));
    const lot = await ctx.tx.inventoryLot.create({ data: {
      id: ctx.envelope.targetId,
      skuId: sku.id,
      label: input.label,
      unit: sku.unit,
      unitCost: new Prisma.Decimal(input.unitCost),
      costCurrency: input.costCurrency,
      receivedAt: new Date(`${input.receivedDate}T12:00:00-03:00`),
      expiresOn: input.expiresOn,
    } });
    const balance = await ctx.tx.stockBalance.create({ data: {
      id: randomUUID(),
      lotId: lot.id,
      locationId: location.id,
      custodianId: custodian.id,
      unit: sku.unit,
      quantity: dbQ(quantity, sku.unit),
      reserved: dbQ(ZERO, sku.unit),
    } });
    await ctx.tx.stockFact.create({ data: {
      requestId: ctx.envelope.requestId,
      lotId: lot.id,
      kind: "opening",
      quantity: dbQ(quantity, sku.unit),
      unit: sku.unit,
      toLocationId: location.id,
      toCustodianId: custodian.id,
      costMinor,
      currency: input.costCurrency,
      reason: "independently_reconciled_stock_opening",
      actorId: ctx.actor.id,
      occurredAt: ctx.now,
      ...(sourceRecordId ? { sourceRecordId } : {}),
    } });
    await audit(ctx, "StockOpeningRecorded", { preparedBy: author.id, custodianId: custodian.id, ...(sourceRecordId ? { sourceRecordId } : {}), evidence: input.evidence });
    return {
      lot,
      balance,
      opening: { quantity: formatQ(quantity, sku.unit), costMinor: costMinor.toString(), currency: input.costCurrency, preparedBy: author.id, approvedBy: ctx.actor.id },
    };
  },
});
