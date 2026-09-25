import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ExcelJS from "exceljs";
import {
  commitDataImport,
  DataImportConflictError,
  DataImportError,
  DataImportRejectedError,
  inspectDataImportFile,
  previewDataImport,
  type DataImportRepository,
  type DataImportTransaction,
  type StoredDataImportBatch,
  type StoredDataImportFact,
  type StoredDataImportProvenance,
} from "../server/data-import.js";
import type {
  DataImportFact,
  DataImportInput,
  DataImportKind,
  DataImportMapping,
  DataImportPreview,
} from "../shared/data-import.js";

const sourceSystem = "synthetic-fixture";
const cutoff = "2026-09-30";
const storageKey = (kind: DataImportFact["kind"], sourceId: string) => `${kind}\u0000${sourceId}`;

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/decision-import/${name}`, import.meta.url), "utf8");
}

function encode(content: string | Uint8Array): string {
  return Buffer.from(content).toString("base64");
}

function mappedInput(
  kind: DataImportKind,
  filename: string,
  content: string | Uint8Array,
  columns: DataImportMapping["columns"],
  options: { sheetName?: string; cutoff?: string; decimalSeparator?: "." | "," } = {},
): DataImportInput {
  return {
    kind,
    sourceSystem,
    filename,
    contentBase64: encode(content),
    mapping: {
      version: "demo-map-v1",
      columns,
      ...(options.sheetName ? { sheetName: options.sheetName } : {}),
      ...(options.decimalSeparator ? { decimalSeparator: options.decimalSeparator } : {}),
    },
    cutoff: options.cutoff ?? cutoff,
  };
}

function salesInput(options: { cutoff?: string } = {}): DataImportInput {
  return mappedInput("delivery_sales", "sales.csv", fixture("sales.csv"), {
    recordType: "recordType",
    sourceId: "sourceId",
    date: "date",
    parentSourceId: "parentSourceId",
    total: "total",
    discount: "discount",
    itemLabel: "itemLabel",
    productSourceId: "productSourceId",
    quantity: "quantity",
    unit: "unit",
    unitPrice: "unitPrice",
    lineTotal: "lineTotal",
  }, options);
}

function purchaseInput(content: string, options: { cutoff?: string } = {}): DataImportInput {
  return mappedInput("purchases", "purchase-order-date.csv", content, {
    recordType: "recordType",
    sourceId: "sourceId",
    date: "date",
    orderDate: "orderDate",
    total: "total",
    supplierSourceId: "supplierSourceId",
  }, options);
}

function memberInput(content = fixture("members.csv")): DataImportInput {
  return mappedInput("members", "members.csv", content, {
    recordType: "recordType",
    sourceId: "sourceId",
    memberKey: "memberKey",
    permitStatus: "permitStatus",
    permitExpiryDate: "permitExpiryDate",
    permitCheckedAt: "permitCheckedAt",
  });
}

function cloneBatch(batch: StoredDataImportBatch): StoredDataImportBatch {
  return {
    ...batch,
    mapping: { ...batch.mapping, columns: { ...batch.mapping.columns } },
    facts: batch.facts.map((fact) => ({ ...fact })) as DataImportFact[],
    errors: batch.errors.map((issue) => ({ ...issue })),
    conflicts: batch.conflicts.map((issue) => ({ ...issue })),
  };
}

class MemoryImportRepository implements DataImportRepository {
  batches = new Map<string, StoredDataImportBatch>();
  facts = new Map<string, StoredDataImportFact>();
  provenance: StoredDataImportProvenance[] = [];
  failOnKind: DataImportFact["kind"] | null = null;
  failOnMarkImported = false;

  async findBatchByIdempotencyKey(key: string): Promise<StoredDataImportBatch | null> {
    const batch = [...this.batches.values()].find((candidate) => candidate.idempotencyKey === key);
    return batch ? cloneBatch(batch) : null;
  }

  async createBatch(batch: StoredDataImportBatch): Promise<StoredDataImportBatch> {
    const prior = await this.findBatchByIdempotencyKey(batch.idempotencyKey);
    if (prior) return prior;
    this.batches.set(batch.id, cloneBatch(batch));
    return cloneBatch(batch);
  }

  async findFacts(source: string, requested: DataImportFact[]): Promise<Map<string, StoredDataImportFact>> {
    const result = new Map<string, StoredDataImportFact>();
    for (const fact of requested) {
      const stored = this.facts.get(`${source}\u0000${storageKey(fact.kind, fact.sourceId)}`);
      if (stored) result.set(storageKey(fact.kind, fact.sourceId), { ...stored });
    }
    return result;
  }

  seedFact(source: string, fact: DataImportFact, factHash: string): void {
    this.facts.set(`${source}\u0000${storageKey(fact.kind, fact.sourceId)}`, {
      id: `seed:${fact.kind}:${fact.sourceId}`,
      kind: fact.kind,
      sourceId: fact.sourceId,
      factHash,
    });
  }

  async transaction<T>(work: (tx: DataImportTransaction) => Promise<T>): Promise<T> {
    const stagedFacts = new Map(this.facts);
    const stagedBatches = new Map([...this.batches].map(([id, batch]) => [id, cloneBatch(batch)]));
    const stagedProvenance = this.provenance.map((row) => ({ ...row }));
    const tx: DataImportTransaction = {
      getBatchForUpdate: async (batchId) => {
        const batch = stagedBatches.get(batchId);
        return batch ? cloneBatch(batch) : null;
      },
      findFacts: async (source, requested) => {
        const result = new Map<string, StoredDataImportFact>();
        for (const fact of requested) {
          const stored = stagedFacts.get(`${source}\u0000${storageKey(fact.kind, fact.sourceId)}`);
          if (stored) result.set(storageKey(fact.kind, fact.sourceId), { ...stored });
        }
        return result;
      },
      findParentIds: async (parentKind, source, sourceIds) => {
        const result = new Map<string, string>();
        for (const sourceId of sourceIds) {
          const parent = stagedFacts.get(`${source}\u0000${storageKey(parentKind, sourceId)}`);
          if (parent) result.set(sourceId, parent.id);
        }
        return result;
      },
      insertFact: async (source, fact, factHash) => {
        if (fact.kind === this.failOnKind) throw new Error("synthetic_insert_failure");
        stagedFacts.set(`${source}\u0000${storageKey(fact.kind, fact.sourceId)}`, {
          id: `stored:${fact.kind}:${fact.sourceId}`,
          kind: fact.kind,
          sourceId: fact.sourceId,
          factHash,
        });
      },
      insertProvenance: async (batchId, source, fact, factHash, disposition) => {
        stagedProvenance.push({
          id: `${batchId}:${fact.kind}:${fact.sourceId}`,
          batchId,
          factKind: fact.kind,
          sourceSystem: source,
          sourceId: fact.sourceId,
          factHash,
          disposition,
        });
      },
      markImported: async (batchId, _actorId, insertedCount, skippedCount) => {
        if (this.failOnMarkImported) throw new Error("synthetic_batch_update_failure");
        const batch = stagedBatches.get(batchId);
        if (!batch || batch.status !== "ready") throw new Error("synthetic_state_conflict");
        stagedBatches.set(batchId, {
          ...batch,
          status: "imported",
          insertedCount,
          skippedCount,
          importedAt: new Date().toISOString(),
        });
      },
    };
    const result = await work(tx);
    this.facts = stagedFacts;
    this.batches = stagedBatches;
    this.provenance = stagedProvenance;
    return result;
  }
}

test("delivery sale preview and commit preserve cent/milliunit precision and are idempotent", async () => {
  const repository = new MemoryImportRepository();
  const input = salesInput();
  const preview = await previewDataImport(input, repository);
  assert.equal(preview.status, "ready");
  assert.equal(preview.acceptedCount, 2);
  assert.deepEqual(preview.errors, []);
  assert.deepEqual(preview.sample.map((fact) => fact.kind), ["delivery_sale", "delivery_sale_line"]);
  assert.equal(preview.sample[0]?.kind === "delivery_sale" ? preview.sample[0].totalCents : null, "2550");
  assert.equal(preview.sample[1]?.kind === "delivery_sale_line" ? preview.sample[1].quantityMilliunits : null, "1250");
  const samePreview = await previewDataImport(input, repository);
  assert.equal(samePreview.batchId, preview.batchId);

  const result = await commitDataImport({ batchId: preview.batchId }, "demo-actor", repository);
  assert.deepEqual(result, { batchId: preview.batchId, status: "imported", inserted: 2, skipped: 0 });
  const repeatedCommit = await commitDataImport({ batchId: preview.batchId }, "demo-actor", repository);
  assert.deepEqual(repeatedCommit, result);
  assert.equal(repository.facts.size, 2);
  assert.equal(repository.batches.get(preview.batchId)?.status, "imported");
  assert.equal(repository.provenance.length, 2);
  assert.ok(repository.provenance.every(({ batchId, disposition }) => batchId === preview.batchId && disposition === "inserted"));
});

test("delivery discounts must be nonnegative and cannot exceed gross total", async () => {
  for (const [invalidDiscount, expectedCode] of [["26.00", "discount_exceeds_gross_total"], ["-0.50", "must_be_nonnegative"]] as const) {
    const repository = new MemoryImportRepository();
    const input = salesInput();
    input.contentBase64 = encode(fixture("sales.csv").replace("25.50,0.50", `25.50,${invalidDiscount}`));
    const preview = await previewDataImport(input, repository);
    assert.equal(preview.status, "rejected");
    assert(preview.errors.some((issue) => issue.field === "discount" && issue.code === expectedCode));
    assert.equal(repository.facts.size, 0);
  }
});

test("repeat imports add skipped-batch provenance without duplicating canonical facts", async () => {
  const repository = new MemoryImportRepository();
  const first = await previewDataImport(salesInput(), repository);
  await commitDataImport({ batchId: first.batchId }, "demo-actor", repository);

  const secondInput = salesInput();
  secondInput.mapping = { ...secondInput.mapping, version: "demo-map-v2" };
  const second = await previewDataImport(secondInput, repository);
  assert.notEqual(second.batchId, first.batchId);
  assert.equal(second.skipped, 2);
  const result = await commitDataImport({ batchId: second.batchId }, "demo-actor", repository);
  assert.equal(result.inserted, 0);
  assert.equal(result.skipped, 2);
  assert.equal(repository.facts.size, 2);
  assert.equal(repository.provenance.length, 4);
  assert.deepEqual(repository.provenance.filter(({ batchId }) => batchId === first.batchId).map(({ disposition }) => disposition), ["inserted", "inserted"]);
  assert.deepEqual(repository.provenance.filter(({ batchId }) => batchId === second.batchId).map(({ disposition }) => disposition), ["skipped", "skipped"]);
});

test("purchase and stock templates parse header/line and milliunit facts", async () => {
  const purchaseRepository = new MemoryImportRepository();
  const purchase = mappedInput("purchases", "purchase.csv", fixture("purchase.csv"), {
    recordType: "recordType", sourceId: "sourceId", date: "date", parentSourceId: "parentSourceId",
    total: "total", supplierSourceId: "supplierSourceId", itemLabel: "itemLabel", productSourceId: "productSourceId",
    quantity: "quantity", unit: "unit", unitPrice: "unitPrice", lineTotal: "lineTotal",
  });
  const purchasePreview = await previewDataImport(purchase, purchaseRepository);
  assert.equal(purchasePreview.status, "ready");
  assert.equal(purchasePreview.sample[0]?.kind === "purchase_receipt" ? purchasePreview.sample[0].orderDate : null, null);
  assert.equal(purchasePreview.sample[1]?.kind === "purchase_receipt_line" ? purchasePreview.sample[1].quantityMilliunits : null, "4000");
  await commitDataImport({ batchId: purchasePreview.batchId }, "demo-actor", purchaseRepository);
  assert.equal(purchaseRepository.facts.size, 2);

  const stockRepository = new MemoryImportRepository();
  const stock = mappedInput("stock", "stock.csv", fixture("stock.csv"), {
    recordType: "recordType", sourceId: "sourceId", date: "date", productSourceId: "productSourceId",
    itemLabel: "itemLabel", locationSourceId: "locationSourceId", quantity: "quantity", unit: "unit", lostQuantity: "lostQuantity",
  });
  const stockPreview = await previewDataImport(stock, stockRepository);
  assert.equal(stockPreview.status, "ready");
  assert.equal(stockPreview.sample[0]?.kind === "stock_observation" ? stockPreview.sample[0].quantityMilliunits : null, "2500");
  assert.equal(stockPreview.sample[1]?.kind === "stockout" ? stockPreview.sample[1].lostQuantityMilliunits : null, "500");
});

test("purchase order dates are imported, hashed, and idempotent", async () => {
  const repository = new MemoryImportRepository();
  const content = "recordType,sourceId,date,orderDate,total,supplierSourceId\nheader,receipt-order-date-001,2026-09-08,2026-09-01,120.00,supplier-demo-01\n";
  const input = purchaseInput(content);
  const preview = await previewDataImport(input, repository);
  const samePreview = await previewDataImport(input, repository);
  assert.equal(preview.status, "ready");
  assert.equal(samePreview.batchId, preview.batchId);
  assert.equal(preview.sample[0]?.kind === "purchase_receipt" ? preview.sample[0].orderDate : null, "2026-09-01");

  await commitDataImport({ batchId: preview.batchId }, "demo-actor", repository);
  const storedFact = [...repository.facts.values()][0];
  assert.ok(storedFact);

  const changedOrderDate = await previewDataImport(purchaseInput(content.replace("2026-09-01", "2026-09-02")), repository);
  assert.equal(changedOrderDate.status, "rejected");
  assert.notEqual(repository.batches.get(preview.batchId)?.idempotencyKey, repository.batches.get(changedOrderDate.batchId)?.idempotencyKey);
  assert.deepEqual(changedOrderDate.conflicts, [{ row: 2, field: "sourceId", code: "source_conflict" }]);
  assert.notEqual(repository.batches.get(preview.batchId)?.factsHash, repository.batches.get(changedOrderDate.batchId)?.factsHash);
  assert.equal(repository.facts.size, 1);
  assert.equal(repository.provenance.length, 1);
});

test("invalid purchase order dates reject preview and commit without fact or provenance writes", async () => {
  const cases = [
    { value: "2026-02-30", cutoff: "2026-09-30", code: "invalid_date" },
    { value: "2026-09-09", cutoff: "2026-09-30", code: "after_receipt_date" },
    { value: "2026-10-01", cutoff: "2026-09-30", code: "after_cutoff" },
  ];
  for (const [index, testCase] of cases.entries()) {
    const repository = new MemoryImportRepository();
    const content = `recordType,sourceId,date,orderDate,total,supplierSourceId\nheader,receipt-invalid-order-${index},2026-09-08,${testCase.value},120.00,supplier-demo-01\n`;
    const preview = await previewDataImport(purchaseInput(content, { cutoff: testCase.cutoff }), repository);
    assert.equal(preview.status, "rejected");
    assert.deepEqual(preview.errors, [{ row: 2, field: "orderDate", code: testCase.code }]);
    assert.equal(repository.batches.get(preview.batchId)?.facts.length, 0);
    await assert.rejects(commitDataImport({ batchId: preview.batchId }, "demo-actor", repository), DataImportRejectedError);
    assert.equal(repository.facts.size, 0);
    assert.equal(repository.provenance.length, 0);
    assert.equal(repository.batches.get(preview.batchId)?.status, "rejected");
  }
});

test("cash movements import as historical facts only, separate from reconciliation", async () => {
  const movementRepository = new MemoryImportRepository();
  const movementInput = mappedInput("cash_movements", "cash-movements.csv", fixture("cash-movements.csv"), {
    recordType: "recordType", sourceId: "sourceId", date: "date", account: "account", category: "category", amount: "amount",
  });
  const movementPreview = await previewDataImport(movementInput, movementRepository);
  assert.equal(movementPreview.status, "ready");
  await commitDataImport({ batchId: movementPreview.batchId }, "demo-actor", movementRepository);
  assert.deepEqual([...movementRepository.facts.values()].map(({ kind }) => kind), ["cash_movement"]);
  assert.equal(movementPreview.sample[0]?.kind === "cash_movement" ? movementPreview.sample[0].amountCents : null, "-1250");

  const reconciliationRepository = new MemoryImportRepository();
  const reconciliationInput = mappedInput("cash_reconciliation", "cash-reconciliation.csv", fixture("cash-reconciliation.csv"), {
    recordType: "recordType", sourceId: "sourceId", date: "date", account: "account", expected: "expected", counted: "counted",
  });
  const reconciliation = await previewDataImport(reconciliationInput, reconciliationRepository);
  assert.equal(reconciliation.sample[0]?.kind === "cash_reconciliation" ? reconciliation.sample[0].varianceCents : null, "-150");
});

test("expense and promotion templates map financial facts without local ledger writes", async () => {
  const repository = new MemoryImportRepository();
  const expenseInput = mappedInput("expenses", "expense.csv", fixture("expense.csv"), {
    recordType: "recordType", sourceId: "sourceId", date: "date", category: "category", amount: "amount",
  });
  const expense = await previewDataImport(expenseInput, repository);
  assert.equal(expense.sample[0]?.kind === "expense" ? expense.sample[0].amountCents : null, "4500");
  await commitDataImport({ batchId: expense.batchId }, "demo-actor", repository);
  const promotionInput = mappedInput("promotions", "promotion.csv", fixture("promotion.csv"), {
    recordType: "recordType", sourceId: "sourceId", date: "date", label: "label", endDate: "endDate", discount: "discount",
  });
  const promotion = await previewDataImport(promotionInput, repository);
  assert.equal(promotion.status, "ready");
  assert.equal(promotion.sample[0]?.kind === "promotion" ? promotion.sample[0].discountCents : null, "500");
  assert.deepEqual([...repository.facts.values()].map(({ kind }) => kind), ["expense"]);
});

test("member import hashes source/member keys, redacts inspection samples, and stores date-only permit metadata", async () => {
  const previousPseudonymSecret = process.env.DATA_IMPORT_PII_SECRET;
  const previousJwtSecret = process.env.JWT_SECRET;
  const pseudonymSecret = "data-import-test-secret-long-enough-for-hmac";
  process.env.DATA_IMPORT_PII_SECRET = pseudonymSecret;
  const repository = new MemoryImportRepository();
  try {
    const content = fixture("members.csv");
    const inspection = await inspectDataImportFile({ filename: "members.csv", contentBase64: encode(content) });
    assert.equal(inspection.sampleRows[0]?.memberKey, "[redacted]");
    assert.equal(inspection.sampleRows[0]?.permitStatus, "[redacted]");

    const preview = await previewDataImport(memberInput(content), repository);
    const samePreview = await previewDataImport(memberInput(content), repository);
    const fact = preview.sample[0];
    assert.equal(samePreview.batchId, preview.batchId);
    assert.equal(fact?.kind, "member");
    if (fact?.kind !== "member") return;
    assert.equal(fact.sourceId, createHmac("sha256", pseudonymSecret)
      .update(`member-source-id\u0000${sourceSystem}\u0000demo-member-source-001`).digest("hex"));
    assert.equal(fact.memberKey, createHmac("sha256", pseudonymSecret)
      .update(`member-key\u0000${sourceSystem}\u0000member-demo-key-001`).digest("hex"));
    assert.equal(fact.sourceId.includes("demo-member-source-001"), false);
    assert.equal(fact.memberKey.includes("member-demo-key-001"), false);
    assert.equal(fact.permitCheckedAt, "2026-09-10");
    await commitDataImport({ batchId: preview.batchId }, "demo-actor", repository);
    assert.equal([...repository.facts.values()][0]?.sourceId, fact.sourceId);
  } finally {
    if (previousPseudonymSecret === undefined) delete process.env.DATA_IMPORT_PII_SECRET;
    else process.env.DATA_IMPORT_PII_SECRET = previousPseudonymSecret;
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
  }
});

test("member imports require a stable pseudonym key and do not write a batch when it is absent", async () => {
  const previousPseudonymSecret = process.env.DATA_IMPORT_PII_SECRET;
  const previousJwtSecret = process.env.JWT_SECRET;
  delete process.env.DATA_IMPORT_PII_SECRET;
  delete process.env.JWT_SECRET;
  const repository = new MemoryImportRepository();
  try {
    await assert.rejects(previewDataImport(memberInput(), repository), (error: unknown) =>
      error instanceof DataImportError && error.code === "member_pseudonym_key_required");
    assert.equal(repository.batches.size, 0);
    assert.equal(repository.facts.size, 0);
  } finally {
    if (previousPseudonymSecret === undefined) delete process.env.DATA_IMPORT_PII_SECRET;
    else process.env.DATA_IMPORT_PII_SECRET = previousPseudonymSecret;
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
  }
});

test("source IDs cannot map directly from email columns", async () => {
  const repository = new MemoryImportRepository();
  const input = mappedInput("expenses", "contacts.csv",
    "recordType,email,date,category,amount\nexpense,person@example.invalid,2026-09-08,servicios,15.25\n", {
      recordType: "recordType", sourceId: "email", date: "date", category: "category", amount: "amount",
    });

  await assert.rejects(previewDataImport(input, repository), (error: unknown) =>
    error instanceof DataImportError && error.code === "sensitive_source_id_mapping_blocked");
  assert.equal(repository.batches.size, 0);
  assert.equal(repository.facts.size, 0);
  assert.equal(repository.provenance.length, 0);
});

test("email values under generic source ID headers are redacted and rejected without import writes", async () => {
  const repository = new MemoryImportRepository();
  const email = "person@example.invalid";
  const content = `recordType,sourceId,date,category,amount\nexpense,${email},2026-09-08,servicios,15.25\n`;
  const input = mappedInput("expenses", "generic-id.csv", content, {
    recordType: "recordType", sourceId: "sourceId", date: "date", category: "category", amount: "amount",
  });
  const inspection = await inspectDataImportFile({ filename: input.filename, contentBase64: input.contentBase64 });
  assert.equal(inspection.sampleRows[0]?.sourceId, "[redacted]");

  const preview = await previewDataImport(input, repository);
  assert.equal(preview.status, "rejected");
  assert.deepEqual(preview.errors, [{ row: 2, field: "sourceId", code: "sensitive_value_blocked" }]);
  assert.equal(repository.batches.get(preview.batchId)?.facts.length, 0);
  assert.equal(JSON.stringify(repository.batches.get(preview.batchId)).includes(email), false);
  await assert.rejects(commitDataImport({ batchId: preview.batchId }, "demo-actor", repository), DataImportRejectedError);
  assert.equal(repository.facts.size, 0);
  assert.equal(repository.provenance.length, 0);
  assert.equal(repository.batches.get(preview.batchId)?.status, "rejected");
});

test("XLSX inspection and preview select a named sheet and return safe samples", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Gastos demo");
  sheet.addRow(["recordType", "sourceId", "date", "category", "amount", "email"]);
  sheet.addRow(["expense", "demo-xlsx-001", "2026-09-08", "internet", "15.25", "demo@example.invalid"]);
  const bytes = await workbook.xlsx.writeBuffer();
  const file = { filename: "demo.xlsx", contentBase64: encode(new Uint8Array(bytes)), sheetName: "Gastos demo" };
  const inspection = await inspectDataImportFile(file);
  assert.deepEqual(inspection.sheets, ["Gastos demo"]);
  assert.deepEqual(inspection.headers, ["recordType", "sourceId", "date", "category", "amount", "email"]);
  assert.equal(inspection.sampleRows[0]?.email, "[redacted]");

  const repository = new MemoryImportRepository();
  const input = mappedInput("expenses", file.filename, new Uint8Array(bytes), {
    recordType: "recordType", sourceId: "sourceId", date: "date", category: "category", amount: "amount",
  }, { sheetName: file.sheetName });
  const preview = await previewDataImport(input, repository);
  assert.equal(preview.status, "ready");
  assert.equal(preview.sample[0]?.kind === "expense" ? preview.sample[0].amountCents : null, "1525");
});

test("sparse XLSX rows beyond the old scan boundary are still previewed and committed", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Data");
  sheet.addRow(["recordType", "sourceId", "date", "category", "amount"]);
  sheet.getRow(2).values = ["expense", "demo-sparse-first", "2026-09-06", "servicios", "1.00"];
  sheet.getRow(15_001).values = ["expense", "demo-sparse-last", "2026-09-06", "servicios", "2.00"];
  const bytes = await workbook.xlsx.writeBuffer();
  const repository = new MemoryImportRepository();
  const input = mappedInput("expenses", "sparse.xlsx", new Uint8Array(bytes), {
    recordType: "recordType", sourceId: "sourceId", date: "date", category: "category", amount: "amount",
  }, { sheetName: "Data" });

  const preview = await previewDataImport(input, repository);
  assert.equal(preview.status, "ready");
  assert.equal(preview.rowCount, 2);
  assert.equal(preview.acceptedCount, 2);
  await commitDataImport({ batchId: preview.batchId }, "demo-actor", repository);
  assert.equal(repository.facts.size, 2);
});

test("post-cutoff rows are rejected and commit writes no historical facts", async () => {
  const repository = new MemoryImportRepository();
  const preview = await previewDataImport(salesInput({ cutoff: "2026-08-31" }), repository);
  assert.equal(preview.status, "rejected");
  assert.equal(preview.acceptedCount, 0);
  assert.equal(preview.errors.length, 2);
  await assert.rejects(
    commitDataImport({ batchId: preview.batchId }, "demo-actor", repository),
    DataImportRejectedError,
  );
  assert.equal(repository.facts.size, 0);
  assert.equal(repository.batches.get(preview.batchId)?.status, "rejected");
});

test("sensitive column mappings fail before an audit batch or fact is written", async () => {
  const repository = new MemoryImportRepository();
  const input = mappedInput("expenses", "expense.csv", fixture("expense.csv"), {
    recordType: "recordType", sourceId: "permitNumber", date: "date", category: "category", amount: "amount",
  });
  await assert.rejects(previewDataImport(input, repository), (error: unknown) =>
    error instanceof DataImportError && error.code === "sensitive_mapping_blocked");
  assert.equal(repository.batches.size, 0);
  assert.equal(repository.facts.size, 0);
});

test("existing source ID with different content aborts at commit with no fact writes", async () => {
  const repository = new MemoryImportRepository();
  const input = mappedInput("expenses", "expense.csv", fixture("expense.csv"), {
    recordType: "recordType", sourceId: "sourceId", date: "date", category: "category", amount: "amount",
  });
  const preview = await previewDataImport(input, repository);
  const fact = preview.sample[0]!;
  repository.seedFact(sourceSystem, fact, "different-fact-hash");
  await assert.rejects(
    commitDataImport({ batchId: preview.batchId }, "demo-actor", repository),
    DataImportConflictError,
  );
  assert.equal(repository.facts.size, 1);
  assert.equal(repository.batches.get(preview.batchId)?.status, "ready");
});

test("a failure after staging a header rolls back every fact and leaves batch ready", async () => {
  const repository = new MemoryImportRepository();
  const preview: DataImportPreview = await previewDataImport(salesInput(), repository);
  repository.failOnKind = "delivery_sale_line";
  await assert.rejects(commitDataImport({ batchId: preview.batchId }, "demo-actor", repository), /synthetic_insert_failure/);
  assert.equal(repository.facts.size, 0);
  assert.equal(repository.batches.get(preview.batchId)?.status, "ready");
  assert.equal(repository.provenance.length, 0);
});

test("a batch state write failure rolls back facts and staged provenance", async () => {
  const repository = new MemoryImportRepository();
  const preview = await previewDataImport(salesInput(), repository);
  repository.failOnMarkImported = true;
  await assert.rejects(commitDataImport({ batchId: preview.batchId }, "demo-actor", repository), /synthetic_batch_update_failure/);
  assert.equal(repository.facts.size, 0);
  assert.equal(repository.provenance.length, 0);
  assert.equal(repository.batches.get(preview.batchId)?.status, "ready");
});

test("reversal and cancellation record types are rejected without writes", async () => {
  const repository = new MemoryImportRepository();
  const content = "recordType,sourceId,date,category,amount\ncancelled,demo-cancel-001,2026-09-06,servicios,45.00\n";
  const input = mappedInput("expenses", "cancelled.csv", content, {
    recordType: "recordType", sourceId: "sourceId", date: "date", category: "category", amount: "amount",
  });
  const preview = await previewDataImport(input, repository);
  assert.equal(preview.status, "rejected");
  assert.deepEqual(preview.errors, [{ row: 2, field: "recordType", code: "unsupported_record_type" }]);
  await assert.rejects(commitDataImport({ batchId: preview.batchId }, "demo-actor", repository), DataImportRejectedError);
  assert.equal(repository.facts.size, 0);
  assert.equal(repository.provenance.length, 0);
});

test("zero cash movements are rejected and never become ledger entries", async () => {
  const repository = new MemoryImportRepository();
  const content = "recordType,sourceId,date,account,category,amount\ncash_movement,demo-zero-001,2026-09-05,caja,ajuste,0.00\n";
  const input = mappedInput("cash_movements", "zero.csv", content, {
    recordType: "recordType", sourceId: "sourceId", date: "date", account: "account", category: "category", amount: "amount",
  });
  const preview = await previewDataImport(input, repository);
  assert.equal(preview.status, "rejected");
  assert.equal(preview.errors[0]?.code, "must_be_nonzero");
  await assert.rejects(commitDataImport({ batchId: preview.batchId }, "demo-actor", repository), DataImportRejectedError);
  assert.equal(repository.facts.size, 0);
});

test("cash movement category direction is checked before commit and accepted signs persist", async () => {
  const validRepository = new MemoryImportRepository();
  const valid = mappedInput("cash_movements", "directions.csv",
    "recordType,sourceId,date,account,category,amount\n" +
    "cash_movement,demo-outflow-001,2026-09-05,caja,operating_expense,-12.50\n" +
    "cash_movement,demo-inflow-001,2026-09-05,caja,sale,25.00\n", {
      recordType: "recordType", sourceId: "sourceId", date: "date", account: "account", category: "category", amount: "amount",
    });
  const validPreview = await previewDataImport(valid, validRepository);
  assert.equal(validPreview.status, "ready");
  assert.equal(validPreview.acceptedCount, 2);
  await commitDataImport({ batchId: validPreview.batchId }, "demo-actor", validRepository);
  assert.deepEqual([...validRepository.facts.values()].map((fact) => fact.kind), ["cash_movement", "cash_movement"]);

  for (const [category, amount] of [["operating_expense", "12.50"], ["sale", "-12.50"]]) {
    const repository = new MemoryImportRepository();
    const input = mappedInput("cash_movements", "invalid-direction.csv",
      `recordType,sourceId,date,account,category,amount\ncash_movement,demo-invalid-001,2026-09-05,caja,${category},${amount}\n`, {
        recordType: "recordType", sourceId: "sourceId", date: "date", account: "account", category: "category", amount: "amount",
      });
    const preview = await previewDataImport(input, repository);
    assert.equal(preview.status, "rejected", `${category} ${amount}`);
    assert.deepEqual(preview.errors, [{ row: 2, field: "amount", code: "invalid_cash_direction" }]);
    await assert.rejects(commitDataImport({ batchId: preview.batchId }, "demo-actor", repository), DataImportRejectedError);
    assert.equal(repository.facts.size, 0);
    assert.equal(repository.provenance.length, 0);
    assert.equal(repository.batches.get(preview.batchId)?.status, "rejected");
  }
});

test("CSV rows with extra or missing cells are rejected instead of silently dropping values", async () => {
  for (const [filename, row] of [
    ["extra.csv", "expense,demo-shape-extra,2026-09-06,servicios,45.00,unexpected"],
    ["missing.csv", "expense,demo-shape-missing,2026-09-06,servicios"],
  ]) {
    const repository = new MemoryImportRepository();
    const content = `recordType,sourceId,date,category,amount\n${row}\n`;
    const input = mappedInput("expenses", filename!, content, {
      recordType: "recordType", sourceId: "sourceId", date: "date", category: "category", amount: "amount",
    });
    const preview = await previewDataImport(input, repository);
    assert.equal(preview.status, "rejected");
    assert.deepEqual(preview.errors[0], { row: 2, field: "row", code: "column_count_mismatch" });
    await assert.rejects(commitDataImport({ batchId: preview.batchId }, "demo-actor", repository), DataImportRejectedError);
    assert.equal(repository.facts.size, 0);
  }
});

test("sparse XLSX with more than the row limit is rejected, not truncated to a valid import", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Data");
  sheet.addRow(["recordType", "sourceId", "date", "category", "amount"]);
  for (let index = 0; index < 10_001; index++)
    sheet.getRow(2 + index * 2).values = ["expense", `demo-row-${index}`, "2026-09-06", "servicios", "1.00"];
  const bytes = await workbook.xlsx.writeBuffer();
  const repository = new MemoryImportRepository();
  const input = mappedInput("expenses", "oversized.xlsx", new Uint8Array(bytes), {
    recordType: "recordType", sourceId: "sourceId", date: "date", category: "category", amount: "amount",
  }, { sheetName: "Data" });
  const preview = await previewDataImport(input, repository);
  assert.equal(preview.status, "rejected");
  assert.deepEqual(preview.errors.map(({ code }) => code), ["row_limit_exceeded"]);
  assert.equal(preview.acceptedCount, 0);
  await assert.rejects(commitDataImport({ batchId: preview.batchId }, "demo-actor", repository), DataImportRejectedError);
  assert.equal(repository.facts.size, 0);
});
