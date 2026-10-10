const MINOR_SCALE = 2;
const MINOR_FACTOR = 10n ** BigInt(MINOR_SCALE);
const wholeFormatter = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 });

export function majorToMinor(value: string): string {
  const input = value.trim().replace(/\s/g, "");
  const commaDecimal = input.includes(",");
  const thousandsOnly = !commaDecimal && /^-?\d{1,3}(?:\.\d{3})+$/.test(input);
  const normalized = commaDecimal
    ? input.replace(/\./g, "").replace(",", ".")
    : thousandsOnly ? input.replace(/\./g, "") : input;
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error("Ingresá un importe válido con hasta dos decimales.");
  }
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [whole, fraction = ""] = unsigned.split(".");
  const minor = BigInt(whole) * MINOR_FACTOR + BigInt((fraction + "00").slice(0, 2));
  return `${negative && minor !== 0n ? "-" : ""}${minor.toString()}`;
}

export function formatMinor(value: unknown, currency?: unknown): string {
  if (typeof value !== "string" && typeof value !== "bigint") return "Sin saldo conciliado";
  const raw = String(value);
  if (!/^-?\d+$/.test(raw)) return "Sin saldo conciliado";
  const minor = BigInt(raw);
  if (currency !== "ARS" && currency !== "USD") return `${minor.toString()} unidades mínimas · moneda desconocida`;
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const major = absolute / MINOR_FACTOR;
  const fraction = (absolute % MINOR_FACTOR).toString().padStart(MINOR_SCALE, "0");
  const grouped = wholeFormatter.format(major);
  return `${negative ? "−" : ""}${currency} ${grouped},${fraction}`;
}

export function displayDecimal(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return "—";
  return String(value).replace(".", ",");
}

export function amountFormToMinor(value: string): string {
  return majorToMinor(value);
}
