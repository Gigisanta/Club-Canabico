import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AppSheetDefinitionError, parseAppSheetDefinitionHtml } from "../server/operations/appsheet-definition.js";
import type { AppSheetDefinitionField, AppSheetDefinitionRecord } from "../shared/operations/appsheet-definition.js";

const require = createRequire(import.meta.url);
const tsxLoader = require.resolve("tsx");
const cliScript = fileURLToPath(new URL("../scripts/appsheet-definition.ts", import.meta.url));
const privateDirectory = ".local/appsheet-real-20261009";

function runCli(...args: string[]) {
  return spawnSync(process.execPath, ["--import", tsxLoader, cliScript, ...args], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
    encoding: "utf8",
    timeout: 30_000,
  });
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function propertyTable(rows: Array<[string, string]>): string {
  return `<table class="react-bridge-group"><tbody>${rows.map(([label, value]) =>
    `<tr><td><label>${escapeHtml(label)}</label></td><td>${escapeHtml(value)}</td></tr>`).join("")}</tbody></table>`;
}

function field(record: AppSheetDefinitionRecord, key: string): AppSheetDefinitionField {
  const result = record.fields.find((entry) => entry.semanticKey === key);
  assert.ok(result, `expected field ${key}`);
  return result;
}

function inventoryRecords(inventory: ReturnType<typeof parseAppSheetDefinitionHtml>, category: string): AppSheetDefinitionRecord[] {
  return inventory.sections.filter((section) => section.category === category).flatMap((section) => section.records);
}

function syntheticDefinition(extra = "", identityFixture: { appId?: string | null; sourcePaths?: string[] } = {}): string {
  const appId = identityFixture.appId === undefined ? "app-fixture-001" : identityFixture.appId;
  const appIdMetadata = appId === null ? "" : `<meta name="app id" content="${escapeHtml(appId)}">`;
  const tableProperties: Array<[string, string]> = [
    ["Table name", "C_Cliente"],
    ["Security filter", "[Enabled] = TRUE"],
    ...(identityFixture.sourcePaths ?? []).map((sourcePath): [string, string] => ["Source Path", sourcePath]),
  ];
  const typeQualifier = JSON.stringify({
    MaxLength: null,
    Valid_If: "[Enabled] = TRUE",
    Show_If: "ISNOTBLANK([Name])",
    Editable_If: "USERROLE() = \"Admin\"",
    Reset_If: "[Enabled] = FALSE",
    Required_If: null,
    Suggested_Values: null,
    ReferencedTableName: null,
  });
  return `<!doctype html><html><head>${appIdMetadata}</head><body>
    <main><h1>Application Documentation</h1>
      <p>2 Tables, 2 Columns, 1 Slices, 1 Views, 1 Format Rules, 1 Actions, 0 Workflow Rules</p>
      <section class="tableSection">
        <h5>C_Cliente Table name</h5>${propertyTable(tableProperties)}
        <h5>Private Settings Table name</h5>${propertyTable([["Table name", "Private Settings"], ["Access token", "synthetic-token-value"]])}
      </section>
      <section class="schemaSection"><section>
        <div class="marginBottom20 parentSection">
          <div class="flexContainer">
            <h5>C_Cliente_Schema Schema Name</h5>${propertyTable([["Schema Name", "C_Cliente_Schema"], ["Visible?", "ALWAYS"]])}
          </div>
          <div class="columns1Section">
          <h3>Column 1: Nombre_Completo_Cliente</h3>${propertyTable([
            ["Column name", "Nombre_Completo_Cliente"], ["Type", "Text"], ["Type Qualifier", typeQualifier],
            ["Key", "No"], ["Part of Key?", "No"], ["Virtual?", "Yes"], ["Reset on edit?", "No"],
            ["Editable Initial Value?", "No"], ["App formula", "IF([Enabled], CONCATENATE([Name], \" A&B\"), \"\")"],
            ["Initial value", "UNIQUEID()"], ["Spreadsheet formula", "=A1 & \"&\""],
          ])}
          <h3>Column 2: Credencial</h3>${propertyTable([
            ["Column name", "Credencial"], ["Type", "File"], ["Type Qualifier", JSON.stringify({ FolderLocation: "Socios/{Id_Cliente}", Valid_If: null, Show_If: null, Editable_If: null, Reset_If: null })],
            ["Key", "No"], ["Virtual?", "No"],
          ])}
          </div>
        </div>
      </section></section>
      <section class="sliceSection"><h5>Clientes Slice Name</h5>${propertyTable([["Slice Name", "Clientes"], ["Row filter condition", "[Enabled] = TRUE"]])}</section>
      <section class="viewSection"><h5>Clientes View name</h5>${propertyTable([["View name", "Clientes"], ["View type", "deck"]])}</section>
      <section class="uxSection formatRulesSection"><h5>Resaltado Rule name</h5>${propertyTable([["Rule name", "Resaltado"], ["Format these columns and actions", "Estado"]])}</section>
      <section class="actionsSection"><h5>Guardar Action name</h5>${propertyTable([["Action name", "Guardar"], ["Only if this condition is true", "[Enabled]"]])}</section>
      ${extra}
    </main></body></html>`;
}

test("extracts AppSheet object groups, formula properties, references and stable evidence", () => {
  const inventory = parseAppSheetDefinitionHtml(syntheticDefinition());
  const schemas = inventoryRecords(inventory, "columns");
  const columns = schemas.flatMap((schema) => schema.children);
  const calculated = columns.find((record) => record.name === "Nombre_Completo_Cliente");
  assert.ok(calculated);
  assert.equal(field(calculated, "key").value, "No");
  assert.equal(field(calculated, "virtual").value, "Yes");
  assert.equal(field(calculated, "appFormula").value, `IF([Enabled], CONCATENATE([Name], " A&B"), "")`);
  assert.equal(field(calculated, "initialValue").value, "UNIQUEID()");
  assert.equal(field(calculated, "validIf").value, "[Enabled] = TRUE");
  assert.equal(field(calculated, "showIf").value, "ISNOTBLANK([Name])");
  assert.equal(field(calculated, "editableIf").value, 'USERROLE() = "Admin"');
  assert.equal(field(calculated, "resetIf").value, "[Enabled] = FALSE");
  assert.equal(field(calculated, "spreadsheetFormula").value, '=A1 & "&"');
  assert.equal(inventory.declaredCounts.columns, 2);
  assert.equal(inventory.observedCounts.columns, 2);
  assert.equal(inventory.coverage.find((entry) => entry.category === "columns")?.state, "matched_declared_count");
  assert.equal(inventory.coverage.find((entry) => entry.category === "workflowRules")?.state, "matched_declared_count");
  assert.equal(inventory.coverage.find((entry) => entry.category === "bots")?.state, "unsupported");
  assert.equal(inventory.source.sha256.length, 64);
  assert.equal(inventory.descriptorSha256.length, 64);
  assert.ok(inventory.evidence.every((entry) => entry.excerpt === null));
});

test("preserves the C_Cliente Credencial File reference instead of misclassifying its name as auth", () => {
  const inventory = parseAppSheetDefinitionHtml(syntheticDefinition());
  const columns = inventoryRecords(inventory, "columns").flatMap((schema) => schema.children);
  const credentialFile = columns.find((record) => record.name === "Credencial");
  assert.ok(credentialFile);
  assert.equal(field(credentialFile, "columnName").value, "Credencial");
  assert.equal(field(credentialFile, "type").value, "File");
  assert.equal(field(credentialFile, "columnName").state, "observed");
  assert.equal(inventory.coverage.find((entry) => entry.category === "columns")?.redactedFieldCount, 0);
});

test("redacts credential-bearing definitions and reports partial category coverage", () => {
  const inventory = parseAppSheetDefinitionHtml(syntheticDefinition());
  const settings = inventoryRecords(inventory, "tables").find((record) => record.name === "Private Settings");
  assert.ok(settings);
  const token = settings.fields.find((entry) => entry.label === "Access token");
  assert.ok(token);
  assert.equal(token.state, "redacted");
  assert.equal(token.value, null);
  assert.equal(JSON.stringify(inventory).includes("synthetic-token-value"), false);
  assert.equal(inventory.coverage.find((entry) => entry.category === "tables")?.state, "redacted");
  assert.ok(inventory.redactedFieldCount > 0);
});

test("reports count mismatches and rejects unverifiable app identity without exposing source values", () => {
  const wrongCount = syntheticDefinition().replace("1 Actions", "9 Actions");
  const mismatch = parseAppSheetDefinitionHtml(wrongCount);
  const actionCoverage = mismatch.coverage.find((entry) => entry.category === "actions");
  assert.equal(actionCoverage?.state, "count_mismatch");
  assert.equal(actionCoverage?.declaredCount, 9);
  assert.equal(actionCoverage?.observedCount, 1);
  assert.throws(
    () => parseAppSheetDefinitionHtml("<main>no identity</main>", { expectedAppId: "required-app-id" }),
    (error: unknown) => error instanceof AppSheetDefinitionError && error.code === "app_identity_unverifiable",
  );
  assert.throws(
    () => parseAppSheetDefinitionHtml(syntheticDefinition(), { expectedAppId: "different-app-id" }),
    (error: unknown) => error instanceof AppSheetDefinitionError && error.code === "app_identity_mismatch",
  );
  assert.throws(
    () => parseAppSheetDefinitionHtml("", {}),
    (error: unknown) => error instanceof AppSheetDefinitionError && error.code === "html_source_empty",
  );
});

test("derives app identity only from unanimous ProcessStateTables Source Path references", () => {
  const appId = "5b49e640-a7c9-40bb-bccf-ddbc9fcc63f0";
  const html = syntheticDefinition("", {
    appId: null,
    sourcePaths: [
      `/ProcessStateTables/${appId}/f996193a-7b13-4015-9dd8-d14581a85d45/data`,
      `/ProcessStateTables/${appId}/04c91123-b571-4f94-8852-29a2fd93f7e1/data`,
    ],
  });
  const inventory = parseAppSheetDefinitionHtml(html, { expectedAppId: appId });
  assert.equal(inventory.app.id, appId);
  assert.equal(inventory.app.identity?.method, "referenced-process-state-namespace");
  assert.equal(inventory.app.identity?.sourcePathReferenceCount, 2);
  assert.equal(inventory.app.identity?.candidateCount, 1);
  assert.equal(inventory.app.identity?.evidenceIds.length, 2);
  assert.match(inventory.app.identity?.evidenceId ?? "", /^e\d+$/);
  assert.equal(inventory.app.identity?.evidenceId, inventory.app.identity?.evidenceIds[0]);
  assert.ok(inventory.app.identity?.evidenceIds.every((id) => inventory.evidence.some((entry) => entry.id === id)));
  assert.ok(inventory.warnings.includes("application_id_derived_from_referenced_process_state_namespace"));
  const cliente = inventoryRecords(inventory, "tables").find((record) => record.name === "C_Cliente");
  assert.ok(cliente);
  assert.equal(cliente.fields.filter((entry) => entry.semanticKey === "sourcePath").length, 2);
  assert.equal(inventory.source.sha256.length, 64);
  assert.equal(inventory.descriptorSha256.length, 64);
});

test("leaves conflicting or malformed process-state identities unresolved and rejects expected mismatches", () => {
  const firstId = "5b49e640-a7c9-40bb-bccf-ddbc9fcc63f0";
  const secondId = "1a204f66-f089-413c-9777-b0d831d2cb15";
  const conflictHtml = syntheticDefinition("", {
    appId: null,
    sourcePaths: [
      `/ProcessStateTables/${firstId}/f996193a-7b13-4015-9dd8-d14581a85d45/data`,
      `/ProcessStateTables/${secondId}/04c91123-b571-4f94-8852-29a2fd93f7e1/data`,
    ],
  });
  const conflict = parseAppSheetDefinitionHtml(conflictHtml);
  assert.equal(conflict.app.id, null);
  assert.equal(conflict.app.identity?.method, "ambiguous");
  assert.equal(conflict.app.identity?.candidateCount, 2);
  assert.equal(conflict.app.identity?.sourcePathReferenceCount, 2);
  assert.ok(conflict.warnings.includes("application_identity_ambiguous_process_state_namespaces"));
  assert.throws(
    () => parseAppSheetDefinitionHtml(conflictHtml, { expectedAppId: firstId }),
    (error: unknown) => error instanceof AppSheetDefinitionError && error.code === "app_identity_ambiguous",
  );

  const headerConflict = parseAppSheetDefinitionHtml(syntheticDefinition("", {
    appId: firstId,
    sourcePaths: [`/ProcessStateTables/${secondId}/f996193a-7b13-4015-9dd8-d14581a85d45/data`],
  }));
  assert.equal(headerConflict.app.id, null);
  assert.equal(headerConflict.app.identity?.method, "ambiguous");
  assert.ok(headerConflict.warnings.includes("application_identity_header_source_namespace_conflict"));

  const malformed = parseAppSheetDefinitionHtml(syntheticDefinition("", {
    appId: null,
    sourcePaths: [
      `/OtherTables/${firstId}/f996193a-7b13-4015-9dd8-d14581a85d45/data`,
      `/ProcessStateTables/not-an-app-id/f996193a-7b13-4015-9dd8-d14581a85d45/data`,
    ],
  }));
  assert.equal(malformed.app.id, null);
  assert.equal(malformed.app.identity?.method, "unverified");
  assert.equal(malformed.app.identity?.candidateCount, 0);
  assert.throws(
    () => parseAppSheetDefinitionHtml(syntheticDefinition("", {
      appId: null,
      sourcePaths: [`/ProcessStateTables/${firstId}/f996193a-7b13-4015-9dd8-d14581a85d45/data`],
    }), { expectedAppId: secondId }),
    (error: unknown) => error instanceof AppSheetDefinitionError && error.code === "app_identity_mismatch",
  );
});

test("keeps summary counts separate from later object ordinals", () => {
  const inventory = parseAppSheetDefinitionHtml(syntheticDefinition("<p>1000 View</p>"));
  assert.equal(inventory.declaredCounts.views, 1);
  assert.equal(inventory.observedCounts.views, 1);
  assert.equal(inventory.coverage.find((entry) => entry.category === "views")?.state, "matched_declared_count");
});

test("recovers structure when a malformed unquoted attribute contains a quote", () => {
  const malformed = syntheticDefinition().replace(
    "<main>",
    "<span data-note=unquoted\" token>content</span><main>",
  );
  const inventory = parseAppSheetDefinitionHtml(malformed);
  assert.equal(inventory.observedCounts.tables, 2);
  assert.equal(inventory.observedCounts.columns, 2);
  assert.equal(inventory.observedCounts.views, 1);
});

test("treats a literal less-than comparison as text and retains following definitions", () => {
  const html = syntheticDefinition();
  const actionSection = html.indexOf('<section class="actionsSection">');
  assert.notEqual(actionSection, -1);
  const malformed = html.slice(0, actionSection) + html.slice(actionSection).replace(
    "<td>[Enabled]</td>",
    "<td>[Enabled] < value</td>",
  );
  const inventory = parseAppSheetDefinitionHtml(malformed);
  assert.equal(inventory.observedCounts.actions, 1);
  assert.equal(inventory.observedCounts.views, 1);
  const action = inventoryRecords(inventory, "actions")[0];
  assert.ok(action);
  assert.equal(field(action, "condition").value, "[Enabled] < value");
});

test("CLI refuses an existing output without deleting or rewriting it", async () => {
  const root = process.cwd();
  const directory = join(root, privateDirectory);
  const sourceName = `fixture-${randomUUID()}.html`;
  const outputName = `existing-${randomUUID()}.json`;
  const source = join(directory, sourceName);
  const output = join(directory, outputName);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(source, syntheticDefinition(), { mode: 0o600 });
    await writeFile(output, "preserve-existing-inventory", { mode: 0o600 });
    const result = runCli("--file", join(privateDirectory, sourceName), "--output", join(privateDirectory, outputName));
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stderr.trim(), JSON.stringify({ error: "output_already_exists" }));
    assert.equal(await readFile(output, "utf8"), "preserve-existing-inventory");
  } finally {
    await Promise.all([rm(source, { force: true }), rm(output, { force: true })]);
  }
});

test("CLI parse rejection leaves no output and successful inventory writes remain private", async () => {
  const root = process.cwd();
  const directory = join(root, privateDirectory);
  const sourceName = `fixture-${randomUUID()}.html`;
  const rejectedName = `rejected-${randomUUID()}.json`;
  const outputName = `inventory-${randomUUID()}.json`;
  const source = join(directory, sourceName);
  const rejectedOutput = join(directory, rejectedName);
  const output = join(directory, outputName);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(source, syntheticDefinition(), { mode: 0o600 });
    const rejected = runCli("--file", join(privateDirectory, sourceName), "--output", join(privateDirectory, rejectedName), "--expected-app-id", "missing-app-id");
    assert.ifError(rejected.error);
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.equal(rejected.signal, null);
    assert.equal(rejected.stderr.trim(), JSON.stringify({ error: "app_identity_mismatch" }));
    await assert.rejects(() => stat(rejectedOutput), { code: "ENOENT" });

    const successful = runCli("--file", join(privateDirectory, sourceName), "--output", join(privateDirectory, outputName));
    assert.ifError(successful.error);
    assert.equal(successful.status, 0, successful.stderr);
    assert.equal(successful.signal, null);
    assert.equal(JSON.parse(successful.stdout).inventorySaved, true);
    assert.ok(JSON.parse(successful.stdout).app);
    const outputStat = await stat(output);
    assert.equal(outputStat.mode & 0o077, 0);
    const saved = JSON.parse(await readFile(output, "utf8")) as ReturnType<typeof parseAppSheetDefinitionHtml>;
    assert.equal(saved.observedCounts.tables, 2);
    assert.equal(saved.observedCounts.columns, 2);
  } finally {
    await Promise.all([rm(source, { force: true }), rm(rejectedOutput, { force: true }), rm(output, { force: true })]);
  }
});
