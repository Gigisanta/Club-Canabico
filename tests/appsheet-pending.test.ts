import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  APPSHEET_PENDING_MAPPING_SPEC,
  pendingMappingFingerprintPayload,
  reconcileAppSheetPendingRows,
  type AppSheetPendingCaptureContext,
  type AppSheetPendingSourceRecord,
} from "../shared/operations/appsheet-pending.js";
import {
  AppSheetPendingPreviewError,
  writeAppSheetPendingPreviewPrivate,
  type AppSheetPendingPreview,
} from "../server/operations/appsheet-pending.js";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const context: AppSheetPendingCaptureContext = {
  captureId: "appsreal-synthetic",
  manifestHash: "a".repeat(64),
  mode: "stable",
  mappingHash: sha256(pendingMappingFingerprintPayload()),
};

function row(sourceTable: string, sourceRow: number, sourceKey: string, values: Record<string, string | null>, options: { duplicateFields?: string[]; unresolvedFields?: string[] } = {}): AppSheetPendingSourceRecord {
  return {
    sourceTable,
    sourceRow,
    sourceKey,
    sourceEvidenceHash: sha256(`${sourceTable}\0${sourceRow}\0${sourceKey}`),
    values,
    ...options,
  };
}

function project(rows: AppSheetPendingSourceRecord[]) {
  return reconcileAppSheetPendingRows(rows, context, sha256);
}

function resultFor(rows: AppSheetPendingSourceRecord[], table: string, sourceRow: number) {
  const result = project(rows).find(item => item.sourceTable === table && item.sourceRow === sourceRow);
  assert.ok(result, `missing preview result for ${table}:${sourceRow}`);
  return result.reconciliation;
}

test("confirmed pre-sale needs both an explicit state and linked detail rows", () => {
  const rows = [
    row("Pre_Venta", 2, "private-pre-sale", { Id_Preventa: "private-pre-sale", Estado_Preventa: "Confirmado", Id_facturado: null }),
    row("Pre_Detalle_Fact", 3, "private-pre-sale-line", { Id_Pre_Venta: "private-pre-sale" }),
    row("Pre_Detalle_Fact", 4, "private-pre-sale-line-2", { Id_Pre_Venta: "private-pre-sale" }),
  ];
  const classification = resultFor(rows, "Pre_Venta", 2).dimensions.preSale;
  assert.equal(classification.status, "confirmed_pending");
  assert.deepEqual(classification.reasonCodes, ["confirmed_presale_without_invoice_and_with_details"]);
  assert.equal(classification.relationships[0]?.status, "multiple");
  assert.equal(classification.relationships[0]?.matchCount, 2);
  assert.equal(classification.relationships[0]?.targets?.length, 2);
  const serialized = JSON.stringify(classification);
  assert.equal(serialized.includes("private-pre-sale"), false, "source identifiers must not escape into the DTO");
});

test("duplicate headers and unresolved formulas in a target schema prevent relationship certification", () => {
  const rows = [
    row("Pre_Venta", 2, "private-pre-sale", { Id_Preventa: "private-pre-sale", Estado_Preventa: "Confirmado", Id_facturado: null }),
    row("Pre_Detalle_Fact", 3, "linked-detail", { Id_Pre_Venta: "private-pre-sale" }),
    row("Pre_Detalle_Fact", 4, "formula-detail", { Id_Pre_Venta: "other-presale" }, { unresolvedFields: ["Id_Pre_Venta"] }),
    row("Pre_Detalle_Fact", 5, "duplicate-header-detail", { Id_Pre_Venta: "another-presale" }, { duplicateFields: ["Id_Pre_Venta"] }),
  ];
  const classification = resultFor(rows, "Pre_Venta", 2).dimensions.preSale;
  assert.equal(classification.status, "needs_review");
  assert.equal(classification.relationships[0]?.status, "unresolved");
  assert.equal(classification.relationships[0]?.matchCount, null);
  assert.equal(classification.relationships[0]?.matchesHash, null);
});

test("explicit partial payments use the recorded invoice currency and retain the exact balance", () => {
  const rows = [
    row("C_Facturacion", 2, "private-invoice-id", { Id_Factura: "private-invoice-id", N_factura: "private-invoice-number", Total_Facturado: "100.00", Tipo_Moneda: "USD" }),
    row("C_Detalle_Fact", 3, "invoice-line", { Id_Factura: "private-invoice-id" }),
    row("Movimiento_Nueva", 4, "payment-1", {
      ID_Movimiento_Unique: "payment-1", ID_Movimiento: "cash-1", Tabla_Origen: "venta", Origen_ID: "private-invoice-id", ID_Origen_2: "private-invoice-number",
      Fecha: "2026-10-01", Tipo_Movimiento: "Ingreso", Concepto: "partial payment 1", Caja: "cash desk", Monto: "40.00", Tipo_Moneda: "USD", Afecta_Resultado: "true",
    }),
    row("Movimiento_Nueva", 5, "payment-2", {
      ID_Movimiento_Unique: "payment-2", ID_Movimiento: "cash-2", Tabla_Origen: "venta", Origen_ID: "private-invoice-id", ID_Origen_2: "private-invoice-number",
      Fecha: "2026-10-02", Tipo_Movimiento: "Ingreso", Concepto: "partial payment 2", Caja: "cash desk", Monto: "25.00", Tipo_Moneda: "USD", Afecta_Resultado: "true",
    }),
  ];
  const classification = resultFor(rows, "C_Facturacion", 2).dimensions.receivable;
  assert.equal(classification.status, "confirmed_pending");
  assert.equal(classification.settlement?.currency, "USD");
  assert.equal(classification.settlement?.dueMinorUnits, "10000");
  assert.equal(classification.settlement?.paidMinorUnits, "6500");
  assert.equal(classification.settlement?.remainingMinorUnits, "3500");
  assert.match(classification.settlement!.paymentRowsHash, /^[a-f0-9]{64}$/);
  const serialized = JSON.stringify(classification);
  assert.equal(serialized.includes("private-invoice-id"), false);
  assert.equal(serialized.includes("private-invoice-number"), false);
});

test("invoice with no source currency remains under review instead of receiving an ARS default", () => {
  const rows = [
    row("C_Facturacion", 2, "invoice", { Id_Factura: "invoice", N_factura: "number", Total_Facturado: "100.00" }),
    row("C_Detalle_Fact", 3, "line", { Id_Factura: "invoice" }),
  ];
  const classification = resultFor(rows, "C_Facturacion", 2).dimensions.receivable;
  assert.equal(classification.status, "needs_review");
  assert.deepEqual(classification.reasonCodes, ["invoice_currency_missing_no_default_applied"]);
  assert.equal(classification.settlement, undefined);
});

test("received merchandise without a source-proven total due is not mislabeled as unpaid", () => {
  const rows = [row("C_Mercaderia", 2, "lot-entry", {
    ID_Mercaderia: "lot-entry",
    Tipo_Registro_Mercaderia: "Entrada",
    Precio_Total_Abonado: "0.00",
  })];
  const classification = resultFor(rows, "C_Mercaderia", 2).dimensions.unpaidPurchase;
  assert.equal(classification.status, "needs_review");
  assert.deepEqual(classification.reasonCodes, ["purchase_total_due_and_currency_not_source_proven"]);
});

test("delivery with duplicate invoice or route references remains under review", () => {
  const invoiceAmbiguous = [
    row("C_Moto", 2, "delivery", { Id_Moto: "delivery", N_Factura: "number", Moto_Ruta_ID: "route", Entrega_completada: "false" }),
    row("C_Facturacion", 3, "invoice-1", { Id_Factura: "invoice-1", N_factura: "number" }),
    row("C_Facturacion", 4, "invoice-2", { Id_Factura: "invoice-2", N_factura: "number" }),
    row("O_Ruta", 5, "route", { Ruta_ID: "route", Ruta_Activa: "true" }),
  ];
  const invoiceReview = resultFor(invoiceAmbiguous, "C_Moto", 2).dimensions.delivery;
  assert.equal(invoiceReview.status, "needs_review");
  assert.deepEqual(invoiceReview.reasonCodes, ["delivery_invoice_reference_ambiguous"]);

  const routeAmbiguous = [
    row("C_Moto", 2, "delivery", { Id_Moto: "delivery", N_Factura: "number", Moto_Ruta_ID: "route", Entrega_completada: "false" }),
    row("C_Facturacion", 3, "invoice", { Id_Factura: "invoice", N_factura: "number" }),
    row("O_Ruta", 4, "route-1", { Ruta_ID: "route", Ruta_Activa: "true" }),
    row("O_Ruta", 5, "route-2", { Ruta_ID: "route", Ruta_Activa: "true" }),
  ];
  const routeReview = resultFor(routeAmbiguous, "C_Moto", 2).dimensions.delivery;
  assert.equal(routeReview.status, "needs_review");
  assert.deepEqual(routeReview.reasonCodes, ["delivery_route_reference_ambiguous"]);
});

test("a legacy movement overlap prevents adding both movement tables into one receivable total", () => {
  const rows = [
    row("C_Facturacion", 2, "invoice", { Id_Factura: "invoice", N_factura: "number", Total_Facturado: "100.00", Tipo_Moneda: "ARS" }),
    row("C_Detalle_Fact", 3, "line", { Id_Factura: "invoice" }),
    row("Movimiento_Nueva", 4, "new-payment", { Tabla_Origen: "venta", Origen_ID: "invoice", ID_Origen_2: "number", Monto: "40.00", Tipo_Moneda: "ARS", Tipo_Movimiento: "Ingreso" }),
    row("Movimiento", 5, "old-payment", { Tabla_Origen: "venta", Origen_ID: "invoice", ID_Origen_2: "number", Monto: "40.00", Tipo_Moneda: "ARS", Tipo_Movimiento: "Ingreso" }),
  ];
  const classification = resultFor(rows, "C_Facturacion", 2).dimensions.receivable;
  assert.equal(classification.status, "needs_review");
  assert.deepEqual(classification.reasonCodes, ["legacy_movement_overlap_not_settled"]);
  assert.equal(classification.settlement, undefined);
});

test("legacy delivery movement category c_moto is linked to its invoice and blocks a false unpaid balance", () => {
  const rows = [
    row("C_Facturacion", 2, "invoice", { Id_Factura: "invoice", N_factura: "number", Total_Facturado: "100.00", Tipo_Moneda: "ARS" }),
    row("C_Detalle_Fact", 3, "line", { Id_Factura: "invoice" }),
    row("C_Moto", 4, "delivery", { Id_Moto: "delivery", N_Factura: "number" }),
    row("Movimiento", 5, "legacy-delivery-payment", {
      Tabla_Origen: "c_moto",
      Origen_ID: "delivery",
      ID_Origen_2: null,
      Monto: "100.00",
      Tipo_Moneda: "ARS",
      Tipo_Movimiento: "Ingreso",
    }),
  ];
  const classification = resultFor(rows, "C_Facturacion", 2).dimensions.receivable;
  assert.equal(classification.status, "needs_review");
  assert.deepEqual(classification.reasonCodes, ["legacy_movement_overlap_not_settled"]);
  assert.equal(classification.settlement, undefined);
});

test("duplicate cash identities or overlap composites prevent a partial-payment balance from being confirmed", () => {
  const invoiceRows = [
    row("C_Facturacion", 2, "invoice", { Id_Factura: "invoice", N_factura: "number", Total_Facturado: "100.00", Tipo_Moneda: "ARS" }),
    row("C_Detalle_Fact", 3, "line", { Id_Factura: "invoice" }),
  ];
  const baseMovement = {
    Tabla_Origen: "venta",
    Origen_ID: "invoice",
    ID_Origen_2: "number",
    Fecha: "2026-10-03",
    Tipo_Movimiento: "Ingreso",
    Concepto: "partial cash payment",
    Caja: "cash desk",
    Monto: "40.00",
    Tipo_Moneda: "ARS",
    Afecta_Resultado: "true",
  };
  const duplicateIdRows = [
    ...invoiceRows,
    row("Movimiento_Nueva", 4, "reused-key", { ...baseMovement, ID_Movimiento_Unique: "reused-key", ID_Movimiento: "cash-1" }),
    row("Movimiento_Nueva", 5, "reused-key", { ...baseMovement, Monto: "25.00", ID_Movimiento_Unique: "reused-key", ID_Movimiento: "cash-2" }),
  ];
  const duplicateId = resultFor(duplicateIdRows, "C_Facturacion", 2).dimensions.receivable;
  assert.equal(duplicateId.status, "needs_review");
  assert.deepEqual(duplicateId.reasonCodes, ["payment_candidate_unique_id_duplicated"]);
  assert.equal(duplicateId.settlement, undefined);

  const duplicateCompositeRows = [
    ...invoiceRows,
    row("Movimiento_Nueva", 4, "payment-1", { ...baseMovement, ID_Movimiento_Unique: "payment-1", ID_Movimiento: "cash-1" }),
    row("Movimiento_Nueva", 5, "payment-2", { ...baseMovement, ID_Movimiento_Unique: "payment-2", ID_Movimiento: "cash-2" }),
  ];
  const duplicateComposite = resultFor(duplicateCompositeRows, "C_Facturacion", 2).dimensions.receivable;
  assert.equal(duplicateComposite.status, "needs_review");
  assert.deepEqual(duplicateComposite.reasonCodes, ["payment_candidate_composite_duplicated"]);
  assert.equal(duplicateComposite.settlement, undefined);
});

test("capture provenance stays provisional and invalid or repeated identities fail closed", () => {
  const provisional = { ...context, mode: "preliminary-delta" as const };
  const result = reconcileAppSheetPendingRows(
    [row("Pre_Venta", 2, "presale", { Id_Preventa: "presale", Estado_Preventa: "Confirmado", Id_facturado: null })],
    provisional,
    sha256,
  );
  assert.equal(result[0]?.reconciliation.capture.provisional, true);
  assert.equal(result[0]?.reconciliation.capture.mode, "preliminary-delta");
  assert.equal(APPSHEET_PENDING_MAPPING_SPEC.policy.preliminaryCaptureNeverCertified, true);
  assert.throws(() => project([
    row("Pre_Venta", 2, "first", { Id_Preventa: "first", Estado_Preventa: "Confirmado", Id_facturado: null }),
    row("Pre_Venta", 2, "second", { Id_Preventa: "second", Estado_Preventa: "Confirmado", Id_facturado: null }),
  ]), /pending_source_row_duplicated/);
  assert.throws(() => reconcileAppSheetPendingRows([], { ...context, mappingHash: "invalid" }, sha256), /pending_capture_hash_invalid/);
});

test("private preview output rejects paths outside the capture and removes partial files after rename failure", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "appsheet-pending-test-"));
  const captureDirectory = join(workspace, "capture");
  await mkdir(captureDirectory, { mode: 0o700 });
  const preview: AppSheetPendingPreview = {
    summary: {
      schemaVersion: "appsheet-pending-reconciliation/1.0.0",
      mappingId: "appsheet-live-pending-reconciliation-v1",
      mappingHash: sha256(pendingMappingFingerprintPayload()),
      capture: { captureId: "appsreal-synthetic", manifestHash: "a".repeat(64), mode: "stable", provisional: false, pages: 1, sheets: 1, sourceRows: 0 },
      rowCount: 0,
      candidateRowCount: 0,
      needsReviewRowCount: 0,
      statusCounts: {},
      tableCounts: {},
    },
    records: [],
  };
  try {
    const outputPath = join(captureDirectory, "pending-preview.json");
    await writeAppSheetPendingPreviewPrivate(preview, outputPath, captureDirectory);
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
    const stored = JSON.parse(await readFile(outputPath, "utf8")) as { records: unknown[] };
    assert.deepEqual(stored.records, []);

    const outsidePath = join(workspace, "outside.json");
    await assert.rejects(
      writeAppSheetPendingPreviewPrivate(preview, outsidePath, captureDirectory),
      (error: unknown) => error instanceof AppSheetPendingPreviewError && error.code === "preview_output_must_be_inside_capture_directory",
    );
    await assert.rejects(stat(outsidePath), { code: "ENOENT" });

    const blockedOutput = join(captureDirectory, "blocked.json");
    await mkdir(blockedOutput);
    await assert.rejects(writeAppSheetPendingPreviewPrivate(preview, blockedOutput, captureDirectory));
    assert.deepEqual((await readdir(captureDirectory)).sort(), ["blocked.json", "pending-preview.json"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("CLI rejects nested output before reading a capture or creating a file", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "appsheet-pending-cli-test-"));
  const captureDirectory = join(workspace, "capture");
  await mkdir(captureDirectory, { mode: 0o700 });
  const scriptPath = resolve(process.cwd(), "scripts/appsheet-pending.ts");
  try {
    const result = await new Promise<{ code: number | null; stderr: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", scriptPath, "--capture", captureDirectory, "--output", "nested/preview.json"], {
        cwd: process.cwd(),
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", code => resolveResult({ code, stderr }));
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /output_must_be_a_filename_or_absolute_path/);
    assert.deepEqual(await readdir(captureDirectory), []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
