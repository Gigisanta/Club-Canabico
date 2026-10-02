const MAX_DECIMAL_PRECISION = 38;
const MAX_DECIMAL_SCALE = 12;
const MAX_INTEGER_DIGITS = MAX_DECIMAL_PRECISION - MAX_DECIMAL_SCALE;
const TEN = 10n;

const POWERS_OF_TEN = Array.from({ length: MAX_DECIMAL_SCALE + 1 }, (_, scale) => TEN ** BigInt(scale));

export type DecimalScale = number;
export type QuantityUnit = "g" | "ud";

export interface AllocationWeight {
  id: string;
  weight: bigint;
}

export interface MinorAllocation {
  id: string;
  amount: bigint;
}

export interface PartialReversal {
  /** Signed movement that reverses `original`. */
  amount: bigint;
  /** Absolute amount reversed after applying this movement. */
  reversedTotal: bigint;
  /** Absolute amount still available to reverse. */
  remaining: bigint;
}

function assertScale(scale: number): asserts scale is DecimalScale {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_DECIMAL_SCALE) {
    throw new RangeError(`scale must be an integer from 0 to ${MAX_DECIMAL_SCALE}`);
  }
}

function powerOfTen(scale: number): bigint {
  assertScale(scale);
  return POWERS_OF_TEN[scale]!;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * Parses a plain decimal string into a scaled BigInt without using floating point.
 * The representable range is Decimal(38,12): at most 26 integer digits and
 * at most 12 fractional digits. Excess fractional zeroes are harmless; any
 * excess non-zero digit is rejected instead of being silently rounded.
 */
export function parseDecimal(value: string, scale: number): bigint {
  assertScale(scale);
  if (typeof value !== "string") throw new TypeError("decimal value must be a string");

  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new TypeError("decimal value must be a plain base-10 string");

  const sign = match[1] === "-" ? -1n : 1n;
  const integerText = match[2]!;
  const integerDigits = integerText.replace(/^0+/, "") || "0";
  const fraction = match[3] ?? "";
  if (integerDigits.length > MAX_INTEGER_DIGITS) {
    throw new RangeError(`decimal exceeds precision ${MAX_DECIMAL_PRECISION}, scale ${MAX_DECIMAL_SCALE}`);
  }
  if (fraction.length > scale && /[1-9]/.test(fraction.slice(scale))) {
    throw new RangeError(`decimal has more than ${scale} fractional digits`);
  }

  const scaledFraction = fraction.slice(0, scale).padEnd(scale, "0");
  const result = BigInt(integerDigits) * powerOfTen(scale) + BigInt(scaledFraction || "0");
  return result === 0n ? 0n : sign * result;
}

/** Formats a scaled BigInt as a plain decimal with exactly `scale` places. */
export function formatDecimal(value: bigint, scale: number): string {
  assertScale(scale);
  if (typeof value !== "bigint") throw new TypeError("scaled value must be a bigint");

  const negative = value < 0n;
  const digits = abs(value).toString();
  if (scale === 0) return `${negative ? "-" : ""}${digits}`;

  const padded = digits.padStart(scale + 1, "0");
  const split = padded.length - scale;
  return `${negative ? "-" : ""}${padded.slice(0, split)}.${padded.slice(split)}`;
}

/** Parses stock quantities at the precision used by their unit: grams (3) or whole units (0). */
export function parseQuantity(value: string, unit: QuantityUnit): bigint {
  if (unit !== "g" && unit !== "ud") throw new TypeError("quantity unit must be 'g' or 'ud'");
  return parseDecimal(value, unit === "g" ? 3 : 0);
}

/** Converts a major-currency decimal to integer minor units (for example, pesos to cents). */
export function parseMoney(value: string): bigint {
  return parseDecimal(value, 2);
}

/** Parses a canonical integer string that represents already-scaled minor units. */
export function parseMinorUnits(value: string): bigint {
  if (typeof value !== "string") throw new TypeError("minor units must be a string");
  if (!/^(?:0|-?[1-9]\d*)$/.test(value)) {
    throw new TypeError("minor units must be a canonical signed integer string");
  }
  const digits = value[0] === "-" ? value.length - 1 : value.length;
  if (digits > MAX_DECIMAL_PRECISION) {
    throw new RangeError(`minor units exceed precision ${MAX_DECIMAL_PRECISION}`);
  }
  return BigInt(value);
}

/** Formats already-scaled minor units without converting through Number. */
export function formatMinorUnits(value: bigint): string {
  if (typeof value !== "bigint") throw new TypeError("minor units must be a bigint");
  return value.toString();
}

/** Rounds a rational value to an integer, with ties rounded away from zero. */
export function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (typeof numerator !== "bigint" || typeof denominator !== "bigint") {
    throw new TypeError("roundHalfUp operands must be bigints");
  }
  if (denominator <= 0n) throw new RangeError("denominator must be positive");

  const magnitude = abs(numerator);
  const quotient = magnitude / denominator;
  const remainder = magnitude % denominator;
  const rounded = quotient + (remainder * 2n >= denominator ? 1n : 0n);
  return numerator < 0n ? -rounded : rounded;
}

/**
 * Multiplies a quantity at up to 3 decimal places by a major-currency unit
 * price (up to 12 decimal places), returning cents. Validate `ud` quantities
 * with parseQuantity first so they remain whole.
 */
export function moneyForQuantity(quantity: string, unitPrice: string): bigint {
  const quantityScaled = parseDecimal(quantity, 3);
  const priceScaled = parseDecimal(unitPrice, 12);
  const productInCentsNumerator = quantityScaled * priceScaled * 100n;
  const cents = roundHalfUp(productInCentsNumerator, 10n ** 15n);
  if (abs(cents).toString().length > MAX_DECIMAL_PRECISION) {
    throw new RangeError(`money result exceeds precision ${MAX_DECIMAL_PRECISION}`);
  }
  return cents;
}

/** Negates a minor-unit movement exactly. */
export function reverseMinor(value: bigint): bigint {
  if (typeof value !== "bigint") throw new TypeError("minor-unit movement must be a bigint");
  return -value;
}

/** Returns the unreversed magnitude, rejecting inconsistent reversal history. */
export function remainingReversibleMinor(original: bigint, alreadyReversed: bigint): bigint {
  if (typeof original !== "bigint" || typeof alreadyReversed !== "bigint") {
    throw new TypeError("reversal amounts must be bigints");
  }
  const originalMagnitude = abs(original);
  if (alreadyReversed < 0n || alreadyReversed > originalMagnitude) {
    throw new RangeError("previous reversals must be between zero and the original amount");
  }
  return originalMagnitude - alreadyReversed;
}

/** Applies one exact partial reversal, rejecting requests above the remaining original amount. */
export function applyPartialReversal(
  original: bigint,
  alreadyReversed: bigint,
  requested: bigint,
): PartialReversal {
  if (typeof requested !== "bigint") throw new TypeError("reversal request must be a bigint");
  const remaining = remainingReversibleMinor(original, alreadyReversed);
  if (requested <= 0n) throw new RangeError("partial reversal must be positive");
  if (requested > remaining) throw new RangeError("partial reversal exceeds the unreversed original amount");

  const sign = original < 0n ? 1n : -1n;
  const reversedTotal = alreadyReversed + requested;
  return { amount: sign * requested, reversedTotal, remaining: remaining - requested };
}

/** Largest-remainder allocation in stable ID order; weights must be non-negative. */
export function allocateMinor(total: bigint, weights: AllocationWeight[]): MinorAllocation[] {
  if (typeof total !== "bigint") throw new TypeError("allocation total must be a bigint");
  if (!Array.isArray(weights)) throw new TypeError("allocation weights must be an array");

  const seen = new Set<string>();
  const ordered = weights.map(({ id, weight }) => {
    if (typeof id !== "string" || id.trim().length === 0) throw new TypeError("allocation IDs must be non-empty strings");
    if (seen.has(id)) throw new RangeError(`duplicate allocation ID: ${id}`);
    seen.add(id);
    if (typeof weight !== "bigint") throw new TypeError("allocation weights must be bigints");
    if (weight < 0n) throw new RangeError("allocation weights must be non-negative");
    return { id, weight };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  const totalWeight = ordered.reduce((sum, item) => sum + item.weight, 0n);
  if (totalWeight === 0n) {
    if (total !== 0n) throw new RangeError("a non-zero total requires a positive allocation weight");
    return ordered.map(({ id }) => ({ id, amount: 0n }));
  }

  const magnitude = abs(total);
  const shares = ordered.map(({ id, weight }) => {
    const numerator = magnitude * weight;
    return {
      id,
      amount: numerator / totalWeight,
      remainder: numerator % totalWeight,
    };
  });
  const unallocated = magnitude - shares.reduce((sum, share) => sum + share.amount, 0n);
  const byRemainder = [...shares].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  for (let index = 0; BigInt(index) < unallocated; index += 1) byRemainder[index]!.amount += 1n;

  const sign = total < 0n ? -1n : 1n;
  return shares.map(({ id, amount }) => ({ id, amount: amount * sign }));
}

const exactAmountField = /(?:amount|monto|importe|unitprice|price|precio|total|subtotal|gross|net|discount|descuento|tax|impuesto|fee|cost|costo|revenue|paid|balance|payment|refund|cash|profit|margin|quantity|qty|cantidad)(?:(?:minor(?:units?)?|cents?))?$/i;
const minorUnitSuffix = /(?:minor(?:units?)?|cents?)$/i;

function isExactAmountField(key: string): boolean {
  if (minorUnitSuffix.test(key)) return true;
  if (exactAmountField.test(key)) return true;
  const currencySuffix = /[A-Z]{3}$/.exec(key);
  return currencySuffix !== null && exactAmountField.test(key.slice(0, -currencySuffix[0].length));
}

function assertAmountString(key: string, value: unknown): void {
  if (typeof value !== "string") {
    throw new TypeError(`exact amount field '${key}' must be a string`);
  }
  if (minorUnitSuffix.test(key)) parseMinorUnits(value);
  else parseDecimal(value, MAX_DECIMAL_SCALE);
}

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError("JSON strings must contain valid Unicode");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("JSON strings must contain valid Unicode");
    }
  }
}

function canonicalize(value: unknown, key: string | undefined, ancestors: Set<object>): string {
  if (key !== undefined && isExactAmountField(key)) assertAmountString(key, value);
  if (value === null) return "null";
  if (typeof value === "string") {
    assertWellFormedUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON does not support non-finite numbers");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("value is not in the JSON data model");

  if (ancestors.has(value)) throw new TypeError("canonical JSON cannot contain circular references");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError("canonical JSON arrays must be ordinary arrays");
      if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError("canonical JSON arrays cannot have symbol properties");
      const ownNames = Object.getOwnPropertyNames(value);
      if (ownNames.length !== value.length + 1 || ownNames.some((name) => name !== "length" && !/^(?:0|[1-9]\d*)$/.test(name))) {
        throw new TypeError("canonical JSON arrays must be dense and have no extra properties");
      }
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          throw new TypeError("canonical JSON arrays must contain ordinary data values");
        }
        items.push(canonicalize(descriptor.value, undefined, ancestors));
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonical JSON objects must be plain objects");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError("canonical JSON objects cannot have symbol properties");

    const names = Object.getOwnPropertyNames(value);
    const keys = Object.keys(value);
    if (names.length !== keys.length) throw new TypeError("canonical JSON objects must contain only enumerable properties");
    keys.sort(); // RFC 8785 orders names by UTF-16 code units.
    const entries = keys.map((property) => {
      assertWellFormedUnicode(property);
      const descriptor = Object.getOwnPropertyDescriptor(value, property);
      if (!descriptor || !("value" in descriptor)) throw new TypeError("canonical JSON objects cannot contain accessors");
      return `${JSON.stringify(property)}:${canonicalize(descriptor.value, property, ancestors)}`;
    });
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** RFC 8785 JSON serialization, with exact amount-like fields required to be validated strings. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, undefined, new Set<object>());
}
