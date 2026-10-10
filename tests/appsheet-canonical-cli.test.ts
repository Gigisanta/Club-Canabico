import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { APPSHEET_EXPECTED_LIVE_APP_ID } from "../server/operations/appsheet-canonical.js";
import { runAppSheetCanonicalCli } from "../scripts/appsheet-canonical.js";
import { hash, sourceSystem, spreadsheetId, definitionInventory, canonicalCaptureFixture } from "./support/appsheet-canonical-fixture.js";

const PRIVATE_CAPTURE = ".local/appsheet-real-20261009";
const DEFINITION_FILE = "appsheet-definition-inventory-live-parity-final.json";
const PASS2_FILE = "verification-pass2.json";
type FixturePageRef = {
  path: string;
  sheetId: number;
  title: string;
  pageIndex: number;
  startRow: number;
  endRow: number;
  pageHash: string;
  verifiedPageHash: string;
  stable: boolean;
  counts: Record<string, number>;
};

function withDescriptorHash<T extends { descriptorSha256: string }>(value: T): T {
  const base = { ...value, descriptorSha256: "" };
  return { ...base, descriptorSha256: hash(base) };
}

function appIdentityFixture() {
  return withDescriptorHash({
    ...definitionInventory(),
    parserVersion: "fixture-parser/1",
    app: {
      id: APPSHEET_EXPECTED_LIVE_APP_ID,
      name: "Synthetic Bombo app",
      version: "fixture-v1",
      deploymentState: null,
      generatedAt: null,
    },
  });
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

async function createCliWorkspace(definition: unknown): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "appsheet-canonical-cli-"));
  execFileSync("git", ["init", "-q"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", [
    "-c", "user.name=Fixture",
    "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=/dev/null",
    "commit", "--allow-empty", "-m", "synthetic fixture",
  ], {
    cwd: workspace,
    stdio: "ignore",
  });

  const privateRoot = join(workspace, ".local");
  const captureDirectory = join(workspace, PRIVATE_CAPTURE);
  const pagesDirectory = join(captureDirectory, "pages");
  await mkdir(privateRoot, { mode: 0o700 });
  await mkdir(captureDirectory, { mode: 0o700 });
  await mkdir(pagesDirectory, { mode: 0o700 });

  const capture = canonicalCaptureFixture();
  const metadata = {
    schemaVersion: "appsheet-source-metadata/v1",
    sourceSystem,
    spreadsheet: { spreadsheetId, title: "Synthetic Bombo source" },
  };
  const headers = capture.headers;
  const coverageSheets = headers.sheets.map((sheet) => ({
    sheetId: sheet.sheetId,
    title: sheet.title,
    hidden: sheet.hidden,
    mode: sheet.mode,
    pageCount: sheet.pageCount,
    occupiedDataRows: 1,
  }));
  const coverage = {
    ...capture.manifest.coverage,
    bodySheetsCaptured: headers.sheets.length,
    totalPages: capture.pages.length,
    rowsWithValues: capture.pages.reduce((count, page) => count + page.counts.rowsWithValues, 0),
    formulaCellCount: capture.pages.reduce((count, page) => count + page.counts.formulaCellCount, 0),
    unresolvedFormulaCount: capture.pages.reduce((count, page) => count + page.counts.unresolvedFormulaCount, 0),
    dataRecordCount: 2,
    sheets: coverageSheets,
  };
  const stableRefs = capture.manifest.pages as unknown as FixturePageRef[];
  const dataHash = hash(stableRefs.map(({ path, sheetId, pageIndex, startRow, endRow, pageHash, counts }) => ({
    path, sheetId, pageIndex, startRow, endRow, pageHash, counts,
  })));
  const metadataHash = hash(metadata.spreadsheet);
  const headersHash = hash({ schemaVersion: headers.schemaVersion, spreadsheetId: headers.spreadsheetId, sheets: headers.sheets });
  const verification = {
    schemaVersion: "appsheet-sheet-verification/v1",
    verifiedPages: stableRefs.length,
    totalPagesExpected: stableRefs.length,
    bodyPersisted: false,
    pages: stableRefs.map((page) => ({
      sheetId: page.sheetId,
      title: page.title,
      pageIndex: page.pageIndex,
      path: page.path,
      pageHashFirst: page.pageHash,
      pageHashVerified: page.verifiedPageHash,
      stable: page.stable,
      counts: page.counts,
    })),
    mismatches: [],
  };
  const verificationBytes = Buffer.from(`${JSON.stringify(verification)}\n`, "utf8");
  const evidence = {
    verificationPass2: {
      path: PASS2_FILE,
      sha256: createHash("sha256").update(verificationBytes).digest("hex"),
    },
  };
  const hashContract = { page: "canonical-sha256-v1" };
  const manifestHash = hash({
    schemaVersion: capture.manifest.schemaVersion,
    sourceSystem,
    sourceId: spreadsheetId,
    spreadsheetId,
    metadataHash,
    headersHash,
    dataHash,
    definitionHash: null,
    stability: capture.manifest.stability,
    coverage,
    pages: stableRefs,
    evidence,
    hashContract,
  });
  const manifest = {
    ...capture.manifest,
    captureId: `appsreal-${manifestHash.slice(0, 16)}`,
    metadataHash,
    headersHash,
    manifestHash,
    dataHash,
    definitionHash: null,
    coverage,
    evidence,
    hashContract,
  };

  await writePrivateJson(join(captureDirectory, "metadata.json"), metadata);
  await writePrivateJson(join(captureDirectory, "headers.json"), headers);
  await writePrivateJson(join(captureDirectory, "manifest.json"), manifest);
  for (const page of capture.pages) {
    const ref = stableRefs.find((entry) => entry.sheetId === page.sheet.sheetId)!;
    await writePrivateJson(join(captureDirectory, ref.path), page);
  }
  await writeFile(join(captureDirectory, evidence.verificationPass2.path), verificationBytes, { mode: 0o600 });
  await writePrivateJson(join(captureDirectory, DEFINITION_FILE), definition);
  return workspace;
}

test("canonical CLI reports a stable identity-verified capture while incompatible parser blocks cutover", async () => {
  const workspace = await createCliWorkspace(appIdentityFixture());
  try {
    const result = await runAppSheetCanonicalCli([], workspace);
    assert.equal(result.code, 0, result.output);

    const report = JSON.parse(result.output) as {
      status: string;
      captureId: string;
      commitSha: string;
      definitionIdentityState: string;
      definitionParserVersion: string;
      definitionReadinessState: string;
      cutoverEligible: boolean;
      summary: { recordCount: number; memberTargetCount: number; catalogueTargetCount: number; globalDeltaBlockingCount: number };
    };
    assert.equal(report.status, "preview");
    assert.match(report.captureId, /^appsreal-[a-f0-9]{16}$/);
    assert.match(report.commitSha, /^[a-f0-9]{40}$/);
    assert.equal(report.definitionIdentityState, "verified");
    assert.equal(report.definitionParserVersion, "fixture-parser/1");
    assert.equal(report.definitionReadinessState, "isolated-archive-only");
    assert.equal(report.summary.recordCount, 2);
    assert.equal(report.summary.memberTargetCount, 1);
    assert.equal(report.summary.catalogueTargetCount, 1);
    assert.equal(report.summary.globalDeltaBlockingCount, 0);
    assert.equal(report.cutoverEligible, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
