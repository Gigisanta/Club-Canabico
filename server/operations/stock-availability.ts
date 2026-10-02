import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { formatDecimal, parseQuantity, type QuantityUnit } from "../../shared/operations/exact.js";
import { OperationError } from "./core.js";

export const stockAvailabilityRuleSchema = z.strictObject({
  locationId: z.string().min(1).max(100),
  custodianId: z.string().min(1).max(100),
  channel: z.enum(["local", "delivery"]),
  available: z.boolean(),
  reason: z.string().trim().min(1).max(500),
});

export const stockAvailabilityDefinitionSchema = z.strictObject({
  rules: z.array(stockAvailabilityRuleSchema).min(1).max(500),
});

export type StockAvailabilityRule = z.infer<typeof stockAvailabilityRuleSchema>;
export type StockAvailabilityChannel = StockAvailabilityRule["channel"];
export type StockAvailabilityBalance = {
  id: string;
  lotId: string;
  locationId: string;
  custodianId: string;
  unit: string;
  quantity: Prisma.Decimal | string;
  reserved: Prisma.Decimal | string;
  lot: { skuId: string };
};

export type StockAvailabilityState = "available" | "unavailable" | "pending" | "rehearsal_compatibility";

export interface StockAvailabilityBalanceResult {
  balanceId: string;
  lotId: string;
  skuId: string;
  unit: string;
  locationId: string;
  custodianId: string;
  quantity: string;
  reservedQuantity: string;
  physicalFreeQuantity: string;
  availableQuantity: string;
  state: StockAvailabilityState;
  reason: string;
  configurationId: string | null;
  version: number | null;
}

export interface StockAvailabilityResolution {
  coverage: "approved" | "pending" | "rehearsal_compatibility";
  configurationId: string | null;
  version: number | null;
  balances: StockAvailabilityBalanceResult[];
}

export interface ResolveStockAvailabilityInput {
  balances: readonly StockAvailabilityBalance[];
  channel: StockAvailabilityChannel;
  asOf: string;
  rehearsal: boolean;
}

type ConfigurationReader = Pick<Prisma.TransactionClient | PrismaClient, "operationalConfiguration">;

function tupleKey(locationId: string, custodianId: string, channel: StockAvailabilityChannel): string {
  return `${locationId}\u0000${custodianId}\u0000${channel}`;
}

function unitOf(value: string): QuantityUnit {
  if (value === "g" || value === "ud") return value;
  throw new OperationError(409, "STOCK_BALANCE_INVARIANT", "El saldo usa una unidad de stock no admitida");
}

function quantityText(value: bigint, unit: QuantityUnit): string {
  return formatDecimal(value, unit === "g" ? 3 : 0);
}

function physicalQuantities(balance: StockAvailabilityBalance) {
  const unit = unitOf(balance.unit);
  let quantity: bigint;
  let reserved: bigint;
  try {
    quantity = parseQuantity(typeof balance.quantity === "string" ? balance.quantity : balance.quantity.toString(), unit);
    reserved = parseQuantity(typeof balance.reserved === "string" ? balance.reserved : balance.reserved.toString(), unit);
  } catch {
    throw new OperationError(409, "STOCK_BALANCE_INVARIANT", "El saldo o la reserva no respetan la unidad y precisión del inventario");
  }
  if (quantity < 0n || reserved < 0n || reserved > quantity)
    throw new OperationError(409, "STOCK_BALANCE_INVARIANT", "El saldo o la reserva de un lote es inválido");
  return { unit, quantity, reserved, free: quantity - reserved };
}

function pendingResults(
  balances: readonly StockAvailabilityBalance[],
  reason: string,
  configurationId: string | null,
  version: number | null,
): StockAvailabilityBalanceResult[] {
  return balances.map((balance) => {
    const physical = physicalQuantities(balance);
    return {
      balanceId: balance.id,
      lotId: balance.lotId,
      skuId: balance.lot.skuId,
      unit: balance.unit,
      locationId: balance.locationId,
      custodianId: balance.custodianId,
      quantity: quantityText(physical.quantity, physical.unit),
      reservedQuantity: quantityText(physical.reserved, physical.unit),
      physicalFreeQuantity: quantityText(physical.free, physical.unit),
      availableQuantity: "0",
      state: "pending",
      reason,
      configurationId,
      version,
    };
  });
}

/**
 * Applies the approved physical-availability rule to already visibility-scoped balances.
 * Read permissions are intentionally supplied by the caller, not inferred here.
 */
export async function resolveStockAvailability(
  tx: ConfigurationReader,
  input: ResolveStockAvailabilityInput,
): Promise<StockAvailabilityResolution> {
  const rows = await tx.operationalConfiguration.findMany({
    where: {
      kind: "stock_availability",
      state: "approved",
      validFrom: { lte: input.asOf },
      OR: [{ validUntil: null }, { validUntil: { gte: input.asOf } }],
    },
    orderBy: [{ validFrom: "desc" }, { version: "desc" }, { id: "asc" }],
    take: 2,
  });
  const row = rows[0];
  if (!row) {
    if (input.rehearsal) {
      const balances = input.balances.map((balance) => {
        const physical = physicalQuantities(balance);
        const available = physical.free > 0n;
        return {
          balanceId: balance.id,
          lotId: balance.lotId,
          skuId: balance.lot.skuId,
          unit: balance.unit,
          locationId: balance.locationId,
          custodianId: balance.custodianId,
          quantity: quantityText(physical.quantity, physical.unit),
          reservedQuantity: quantityText(physical.reserved, physical.unit),
          physicalFreeQuantity: quantityText(physical.free, physical.unit),
          availableQuantity: available ? quantityText(physical.free, physical.unit) : "0",
          state: available ? "rehearsal_compatibility" as const : "unavailable" as const,
          reason: available ? "Compatibilidad de disponibilidad habilitada para ensayo sintético" : "No hay cantidad física libre por encima de las reservas vigentes",
          configurationId: null,
          version: null,
        };
      });
      return { coverage: "rehearsal_compatibility", configurationId: null, version: null, balances };
    }
    return {
      coverage: "pending",
      configurationId: null,
      version: null,
      balances: pendingResults(input.balances, "Falta una regla física aprobada de disponibilidad", null, null),
    };
  }

  const configurationId = row.id;
  const version = row.version;
  if (!row.approvedBy || !row.approvedAt || (rows[1]?.validFrom === row.validFrom && rows[1]?.version === row.version)) {
    return {
      coverage: "pending",
      configurationId,
      version,
      balances: pendingResults(input.balances, "La regla aprobada de disponibilidad es ambigua o carece de aprobación verificable", configurationId, version),
    };
  }

  const stored = row.definition as { rules?: unknown } | null;
  const parsed = stockAvailabilityDefinitionSchema.safeParse({ rules: stored && typeof stored === "object" ? stored.rules : undefined });
  if (!parsed.success) {
    return {
      coverage: "pending",
      configurationId,
      version,
      balances: pendingResults(input.balances, "La regla aprobada de disponibilidad requiere revisión", configurationId, version),
    };
  }

  const rules = new Map<string, StockAvailabilityRule>();
  for (const rule of parsed.data.rules) {
    const key = tupleKey(rule.locationId, rule.custodianId, rule.channel);
    if (rules.has(key)) {
      return {
        coverage: "pending",
        configurationId,
        version,
        balances: pendingResults(input.balances, "La regla aprobada repite una combinación de ubicación, custodia y canal", configurationId, version),
      };
    }
    rules.set(key, rule);
  }

  return {
    coverage: "approved",
    configurationId,
    version,
    balances: input.balances.map((balance) => {
      const physical = physicalQuantities(balance);
      const rule = rules.get(tupleKey(balance.locationId, balance.custodianId, input.channel));
      if (!rule) {
        return {
          balanceId: balance.id,
          lotId: balance.lotId,
          skuId: balance.lot.skuId,
          unit: balance.unit,
          locationId: balance.locationId,
          custodianId: balance.custodianId,
          quantity: quantityText(physical.quantity, physical.unit),
          reservedQuantity: quantityText(physical.reserved, physical.unit),
          physicalFreeQuantity: quantityText(physical.free, physical.unit),
          availableQuantity: "0",
          state: "pending" as const,
          reason: "Falta una regla para esta ubicación, custodia y canal",
          configurationId,
          version,
        };
      }
      const available = rule.available && physical.free > 0n;
      return {
        balanceId: balance.id,
        lotId: balance.lotId,
        skuId: balance.lot.skuId,
        unit: balance.unit,
        locationId: balance.locationId,
        custodianId: balance.custodianId,
        quantity: quantityText(physical.quantity, physical.unit),
        reservedQuantity: quantityText(physical.reserved, physical.unit),
        physicalFreeQuantity: quantityText(physical.free, physical.unit),
        availableQuantity: available ? quantityText(physical.free, physical.unit) : "0",
        state: available ? "available" as const : "unavailable" as const,
        reason: rule.available ? (available ? rule.reason : "No hay cantidad física libre por encima de las reservas vigentes") : rule.reason,
        configurationId,
        version,
      };
    }),
  };
}
