import type { RequestHandler } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "../db.js";
import { profileCapabilities, cutoverGateIds, cutoverProfiles, type Capability, type CutoverProfile } from "../../shared/operations/contracts.js";
import { canonicalJson } from "../../shared/operations/exact.js";
import { APPSHEET_CANONICAL_SOURCE_SYSTEM, APPSHEET_CANONICAL_MAPPING_ID, APPSHEET_CANONICAL_IMPORTER_VERSION, APPSHEET_CANONICAL_SCHEMA_VERSION, prepareAppSheetCaptureManifest } from "../../shared/operations/appsheet-canonical.js";
import { APPSHEET_HISTORY_MAPPING_ID, APPSHEET_HISTORY_SOURCE_SYSTEM, APPSHEET_HISTORY_IMPORTER_VERSION } from "../../shared/operations/appsheet-history.js";
import { appSheetDefinitionInventorySchema } from "../../shared/operations/appsheet-definition.js";
import { APPSHEET_EXPECTED_LIVE_APP_ID, appSheetAppliedDefinitionHash } from "./appsheet-canonical.js";
import { legacyPayloadHash } from "./legacy-upload-contract.js";
import { registerCommand, OperationError, json, audit, capabilities, requireCapability, objectId, evidence, civilDate, requireMemberScope, requireDocumentScope, objectScope, type CommandContext, type Tx } from "./core.js";
import { commercialAddress, commercialPreferences } from "./member-fields.js";
import { canManageDecisionInputAttestations } from "./access-snapshot.js";
const profile = z.enum(["owner","finance","commercial","stock","logistics","driver","cashier","clinical","viewer"]);
const defaultCapabilities = new Set(Object.values(profileCapabilities).flat());
const hashPattern = /^[a-f0-9]{64}$/;
type JsonObject = Record<string, unknown>;
const asJsonObject = (value: unknown): JsonObject | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
const hashJson = (value: unknown) => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
const sameHumanIdentity = (left: unknown, right: unknown) => typeof left === "string" && typeof right === "string" &&
 left.trim().toLocaleLowerCase("en-US") === right.trim().toLocaleLowerCase("en-US");
const appSheetReadinessError = (blocker: string, details: Record<string, unknown> = {}) =>
 new OperationError(423,"APPSHEET_REPLACEMENT_NOT_READY","La autoridad Bombo requiere evidencia completa y conciliada de AppSheet.",{blockers:[blocker],...details});

/** Revalidate capture fields retained in the database. Ingestion verifies the source manifest, including its private evidence and hash contract. */
async function requireStableAppSheetCapture(tx:Tx,captureId:string){
 const capture=await tx.appSheetCaptureManifest.findUnique({where:{captureId}});
 if(!capture||capture.sourceSystem!==APPSHEET_CANONICAL_SOURCE_SYSTEM||capture.sourceId!==capture.spreadsheetId||
    capture.captureId!==`appsreal-${capture.manifestHash.slice(0,16)}`||!hashPattern.test(capture.metadataHash)||!hashPattern.test(capture.headersHash)||
    !hashPattern.test(capture.manifestHash)||!hashPattern.test(capture.dataHash)||capture.definitionHash!==null||capture.definitionCoverage!==null)
  throw appSheetReadinessError("capture_identity_or_hash_invalid");
 let prepared;
 try{
  prepared=prepareAppSheetCaptureManifest({schemaVersion:APPSHEET_CANONICAL_SCHEMA_VERSION,...capture,
   firstReadAt:capture.firstReadAt.toISOString(),verificationStartedAt:capture.verificationStartedAt.toISOString(),
   verificationCompletedAt:capture.verificationCompletedAt.toISOString(),cutoffAt:capture.cutoffAt.toISOString(),
   coverage:capture.dataCoverage,pages:capture.pageManifest});
 }catch{
  throw appSheetReadinessError("capture_manifest_shape_or_timestamp_invalid");
 }
 const stability=asJsonObject(prepared.stability);
 const coverage=asJsonObject(prepared.dataCoverage);
 const sheets=coverage&&Array.isArray(coverage.sheets)?coverage.sheets.map(asJsonObject):null;
 const pages=Array.isArray(prepared.pageManifest)?prepared.pageManifest.map(asJsonObject):null;
 if(!stability||!coverage||!sheets||!pages||sheets.some(sheet=>!sheet)||pages.some(page=>!page))
  throw appSheetReadinessError("capture_manifest_shape_invalid");
 const stableCounts=["firstPassPages","verifiedPages","matchedPages"] as const;
 if(stability.stable!==true||stability.cutoverEligible!==true||stability.metadataStable!==true||stability.headersStable!==true||stability.pageHashesStable!==true||stability.scanComplete!==true||
    stability.changedPages!==0||stability.failedPages!==0||stability.missingPages!==0||stability.unresolvedFormulaCount!==0||stability.sourceWriteDetected!==false||
    stableCounts.some(key=>typeof stability[key]!=="number"||stability[key]!==capture.dataPageCount)||
    capture.dataSheetCount!==sheets.length||capture.dataPageCount!==pages.length||capture.dataPageCount===0||capture.dataUnresolvedFormulaCount!==0||
    coverage.metadataStable!==true||coverage.headersStableAll!==true||coverage.failedPages!==0||coverage.changedPages!==0||coverage.unresolvedFormulaCount!==0)
  throw appSheetReadinessError("capture_not_stable_or_complete");

 const sheetIds=new Set<number>(),titles=new Set<string>(),pageCounts=new Map<number,number>();
 for(const sheet of sheets){
  if(typeof sheet!.sheetId!=="number"||!Number.isSafeInteger(sheet!.sheetId)||typeof sheet!.title!=="string"||!sheet!.title||sheetIds.has(sheet!.sheetId)||titles.has(sheet!.title)||
     typeof sheet!.pageCount!=="number"||typeof sheet!.verifiedPageCount!=="number"||typeof sheet!.stablePageCount!=="number"||typeof sheet!.changedPageCount!=="number"||
     sheet!.pageCount!==sheet!.verifiedPageCount||sheet!.pageCount!==sheet!.stablePageCount||sheet!.changedPageCount!==0||
     typeof sheet!.bodyRead!=="boolean"||typeof sheet!.bodyExcluded!=="boolean")
   throw appSheetReadinessError("capture_sheet_coverage_incomplete");
  sheetIds.add(sheet!.sheetId);titles.add(sheet!.title);
  if(sheet!.title==="T_Usuarios"&&!(sheet!.bodyExcluded===true&&sheet!.bodyRead===false&&sheet!.bodyExclusionReason==="authentication-table-body-redacted"))
   throw appSheetReadinessError("authentication_body_redaction_missing");
  if(sheet!.title!=="T_Usuarios"&&(!sheet!.bodyRead||sheet!.bodyExcluded))
   throw appSheetReadinessError("unexpected_source_body_exclusion");
 }
 if(!titles.has("C_Cliente")||!titles.has("D_Catalogo_Mercaderia")||!titles.has("T_Usuarios")||
    stability.bodyExcludedSheets instanceof Array&&stability.bodyExcludedSheets.length!==1)
  throw appSheetReadinessError("required_source_sheet_missing");
 const expectedPageKeys=new Set<string>();
 for(const page of pages){
  if(typeof page!.path!=="string"||!/^pages\/[0-9]+-[0-9]+-[0-9]+\.json$/.test(page!.path)||typeof page!.sheetId!=="number"||typeof page!.title!=="string"||
     !Number.isSafeInteger(page!.pageIndex)||typeof page!.pageIndex!=="number"||!Number.isSafeInteger(page!.startRow)||typeof page!.startRow!=="number"||
     !Number.isSafeInteger(page!.endRow)||typeof page!.endRow!=="number"||typeof page!.pageHash!=="string"||!hashPattern.test(page!.pageHash)||
     page!.verifiedPageHash!==page!.pageHash||page!.stable!==true||asJsonObject(page!.counts)===null)
   throw appSheetReadinessError("capture_page_manifest_invalid");
  const sheet=sheets.find(candidate=>candidate!.sheetId===page!.sheetId);
  const key=`${page!.sheetId}:${page!.pageIndex}`;
  if(!sheet||sheet!.title!==page!.title||expectedPageKeys.has(key)||page!.pageIndex<0||page!.startRow<1||page!.endRow<page!.startRow)
   throw appSheetReadinessError("capture_page_identity_invalid");
  expectedPageKeys.add(key);pageCounts.set(page!.sheetId,(pageCounts.get(page!.sheetId)??0)+1);
 }
 if(sheets.some(sheet=>pageCounts.get(sheet!.sheetId as number)!==sheet!.pageCount))throw appSheetReadinessError("capture_page_coverage_mismatch");
 const pageRefs=pages.map(page=>({path:page!.path,sheetId:page!.sheetId,pageIndex:page!.pageIndex,startRow:page!.startRow,endRow:page!.endRow,pageHash:page!.pageHash,counts:page!.counts}));
 if(hashJson(pageRefs)!==capture.dataHash)throw appSheetReadinessError("capture_data_hash_mismatch");
 return capture;
}

const finalDeltaReviewInputSchema=z.strictObject({
 manualPauseStartedAt:z.iso.datetime({offset:true}),
 manualPauseEndedAt:z.iso.datetime({offset:true}).nullable().optional(),
 manualPauseEvidenceRef:z.string().trim().min(3).max(500).refine(value=>! /^(n\/?a|none|ninguno|sin evidencia|pendiente)$/i.test(value)),
 expectedHandoffChangesRef:z.string().trim().min(3).max(500).refine(value=>! /^(n\/?a|none|ninguno|sin evidencia|pendiente)$/i.test(value)),
});
type FinalDeltaReviewInput=z.infer<typeof finalDeltaReviewInputSchema>;
export function finalDeltaProofForCapture(capture:AppSheetReplacementProof["capture"],input:FinalDeltaReviewInput){
 const stability=asJsonObject(capture.stability),pauseStartedAt=Date.parse(input.manualPauseStartedAt);
 const firstReadAt=capture.firstReadAt.getTime(),verificationStartedAt=capture.verificationStartedAt.getTime();
 const verificationCompletedAt=capture.verificationCompletedAt.getTime(),cutoffAt=capture.cutoffAt.getTime();
 const pauseEndedAt=input.manualPauseEndedAt?Date.parse(input.manualPauseEndedAt):null;
 if(!stability||stability.stable!==true||stability.cutoverEligible!==true||stability.metadataStable!==true||stability.headersStable!==true||
    stability.pageHashesStable!==true||stability.scanComplete!==true||stability.changedPages!==0||stability.failedPages!==0||
    stability.unresolvedFormulaCount!==0||stability.sourceWriteDetected!==false||
    ![pauseStartedAt,firstReadAt,verificationStartedAt,verificationCompletedAt,cutoffAt].every(Number.isFinite)||
    pauseStartedAt>Date.now()+60_000||pauseStartedAt>firstReadAt||firstReadAt>verificationStartedAt||
    verificationStartedAt>verificationCompletedAt||verificationCompletedAt>cutoffAt||
    [firstReadAt,verificationStartedAt,verificationCompletedAt,cutoffAt].some(value=>value<pauseStartedAt)||
    (pauseEndedAt!==null&&(!Number.isFinite(pauseEndedAt)||pauseEndedAt>Date.now()+60_000||pauseEndedAt<cutoffAt))||
    input.manualPauseEvidenceRef.trim().toLowerCase()===input.expectedHandoffChangesRef.trim().toLowerCase())
  throw appSheetReadinessError("final_delta_pause_or_fresh_capture_evidence_invalid");
 return {
  schemaVersion:1,
  manualPauseStartedAt:new Date(pauseStartedAt).toISOString(),
  manualPauseEndedAt:pauseEndedAt===null?null:new Date(pauseEndedAt).toISOString(),
  manualPauseEvidenceRef:input.manualPauseEvidenceRef.trim(),
  capture:{captureId:capture.captureId,manifestHash:capture.manifestHash,dataHash:capture.dataHash,
   firstReadAt:capture.firstReadAt.toISOString(),verificationStartedAt:capture.verificationStartedAt.toISOString(),
   verificationCompletedAt:capture.verificationCompletedAt.toISOString(),cutoffAt:capture.cutoffAt.toISOString(),sourceWriteDetected:false},
  expectedHandoffChanges:{disposition:"separate-review",reference:input.expectedHandoffChangesRef.trim()},
 };
}

function requireDefinitionEvidence(snapshot:{id:string;sourceSystem:string;fileHash:string;importerVersion:string;createdBy:string;controls:unknown;coverage:unknown},capture:{captureId:string;manifestHash:string;dataHash:string}){
 const controls=asJsonObject(snapshot.controls),projection=controls&&asJsonObject(controls.appSheetCanonical);
 const coverage=asJsonObject(snapshot.coverage),coverageProjection=coverage&&asJsonObject(coverage.appSheetCanonical);
 if(snapshot.sourceSystem!==APPSHEET_CANONICAL_SOURCE_SYSTEM||snapshot.fileHash!==capture.manifestHash||snapshot.importerVersion!==APPSHEET_CANONICAL_IMPORTER_VERSION||
    !projection||!coverageProjection||projection.projectionKind!=="masters"||projection.mappingId!==APPSHEET_CANONICAL_MAPPING_ID||projection.importerVersion!==APPSHEET_CANONICAL_IMPORTER_VERSION||
    projection.captureId!==capture.captureId||projection.manifestHash!==capture.manifestHash||
    projection.dataHash!==capture.dataHash||projection.captureDefinitionHash!==null||projection.definitionIdentityState!=="verified"||
    coverageProjection.captureId!==capture.captureId||coverageProjection.manifestHash!==capture.manifestHash||coverageProjection.dataHash!==capture.dataHash||
    coverageProjection.captureDefinitionHash!==null||coverageProjection.identityState!=="verified"||coverageProjection.projectionHash!==projection.projectionHash||
    !hashPattern.test(String(projection.projectionHash)))
  throw appSheetReadinessError("definition_identity_or_projection_binding_missing");
 const rawInventory=projection.definitionInventory;
 const parsed=appSheetDefinitionInventorySchema.safeParse(rawInventory);
 if(!parsed.success||parsed.data.app.id!==APPSHEET_EXPECTED_LIVE_APP_ID||projection.expectedAppId!==APPSHEET_EXPECTED_LIVE_APP_ID)
  throw appSheetReadinessError("definition_app_identity_unverified");
 const inventory=parsed.data,appliedHash=appSheetAppliedDefinitionHash(inventory);
 if(projection.appliedDefinitionHash!==appliedHash||coverageProjection.appliedDefinitionHash!==appliedHash||!hashPattern.test(appliedHash))
  throw appSheetReadinessError("definition_inventory_hash_mismatch");
 const categories=["tables","columns","slices","views","formatRules","actions","workflowRules"];
 const complete=categories.every(category=>{
  const item=inventory.coverage.find(entry=>entry.category===category);
  return item&&item.state==="matched_declared_count"&&item.redactedFieldCount===0&&item.ambiguousFieldCount===0;
 });
 if(!complete||inventory.redactedFieldCount!==0)throw appSheetReadinessError("appsheet_definition_coverage_incomplete");
 const botInventory=asJsonObject(projection.botInventory)??asJsonObject(coverageProjection.botInventory);
 if(!botInventory||botInventory.state!=="verified"||typeof botInventory.evidenceSha256!=="string"||!hashPattern.test(botInventory.evidenceSha256))
  throw appSheetReadinessError("appsheet_bot_inventory_unverified");
 const effects=asJsonObject(projection.effects),stageContext=asJsonObject(projection.stageContext),backup=stageContext&&asJsonObject(stageContext.backupEvidence);
 if(!effects||hashJson(effects)!==hashJson({stock:false,cash:false,orders:false,deliveries:false,messaging:false,priceApproval:false})||
    !stageContext||stageContext.target!=="production"||!backup||typeof backup.manifestHash!=="string"||!hashPattern.test(backup.manifestHash)||
    typeof backup.snapshotAt!=="string"||!Number.isFinite(Date.parse(backup.snapshotAt)))
  throw appSheetReadinessError("canonical_master_effects_or_production_backup_unverified");
 const review=asJsonObject(projection.technicalReview);
 if(!review||review.reviewKind!=="independent-technical"||review.approved!==true||review.projectionHash!==projection.projectionHash||
    review.captureId!==capture.captureId||review.manifestHash!==capture.manifestHash||review.definitionHash!==appliedHash||
    review.importer!==APPSHEET_CANONICAL_IMPORTER_VERSION||typeof review.reviewer!=="string"||!review.reviewer.trim()||review.reviewer===snapshot.createdBy||
    typeof review.reviewedAt!=="string"||!Number.isFinite(Date.parse(review.reviewedAt))||Date.parse(review.reviewedAt)>Date.now()+60_000||
    !Number.isSafeInteger(review.findingsCount)||review.findingsCount!==0||typeof review.commitSha!=="string"||! /^[a-f0-9]{40}$/.test(review.commitSha)||
    sameHumanIdentity(review.reviewer,snapshot.createdBy))
  throw appSheetReadinessError("canonical_master_technical_review_unbound");
 const reviewHash=hashJson({reviewKind:review.reviewKind,approved:review.approved,projectionHash:review.projectionHash,captureId:review.captureId,
  manifestHash:review.manifestHash,definitionHash:review.definitionHash,importer:review.importer,reviewer:review.reviewer,reviewedAt:review.reviewedAt,
  findingsCount:review.findingsCount,commitSha:review.commitSha});
 return {projection,coverageProjection,inventory,appliedHash,reviewHash,commitSha:review.commitSha,reviewer:String(review.reviewer),reviewedAt:String(review.reviewedAt),
  projectionHash:String(projection.projectionHash),backupManifestHash:String(backup.manifestHash),backupSnapshotAt:String(backup.snapshotAt)};
}

async function requireProjectionAudit(ctx:CommandContext,snapshotId:string,action:string){
 const rows=await ctx.tx.operationAudit.findMany({where:{objectId:snapshotId,action},select:{actorId:true,details:true},take:2});
 if(rows.length!==1)throw appSheetReadinessError("projection_stage_audit_missing_or_ambiguous",{snapshotId,action});
 const details=asJsonObject(rows[0]!.details);
 if(!details)throw appSheetReadinessError("projection_stage_audit_invalid",{snapshotId,action});
 return {actorId:rows[0]!.actorId,details};
}

/** Complete source-linked evidence gate. Missing publication/open-object/opening proof stays a hard blocker. */
type AppSheetReplacementProof={
 capture:{captureId:string;manifestHash:string;dataHash:string;definitionHash:string|null;firstReadAt:Date;verificationStartedAt:Date;
  verificationCompletedAt:Date;cutoffAt:Date;stability:unknown};
 appliedDefinitionHash:string;
 master:{id:string;fileHash:string;sourceRecords:number;projectionHash:string;commitSha:string;technicalReviewHash:string;backupManifestHash:string};
 history:{id:string;fileHash:string;sourceRecords:number;facts:number;publicationFingerprint:string;projectionHash:string;commitSha:string;technicalReviewHash:string};
};
/** Require the final AppSheet pause gate before using capture-backed opening or numbering data. */
export async function requireApprovedAppSheetFinalDeltaGate(tx:Tx,captureId:string){
 const gate=await tx.cutoverGate.findUnique({where:{id:"final-delta-reconciled"}});
 if(!gate||gate.status!=="approved"||gate.captureManifestId!==captureId||!gate.approvedBy||!gate.reviewedBy||
    gate.approvedBy===gate.reviewedBy||!gate.approvedAt||!Number.isFinite(gate.approvedAt.getTime()))
  throw appSheetReadinessError("final_delta_gate_missing_or_invalid",{captureId});
 const author=await tx.user.findUnique({where:{id:gate.approvedBy},select:{id:true,active:true}});
 const reviewer=await tx.user.findUnique({where:{id:gate.reviewedBy},select:{id:true,active:true}});
 if(!author?.active||!reviewer?.active||author.id===reviewer.id)
  throw appSheetReadinessError("final_delta_gate_human_review_invalid",{captureId});
 const capture=await requireStableAppSheetCapture(tx,captureId);
 const envelope=asJsonObject(gate.evidence),binding=envelope&&asJsonObject(envelope.appSheetReplacement);
 if(!binding||binding.schemaVersion!==1||binding.captureId!==capture.captureId||binding.manifestHash!==capture.manifestHash||binding.dataHash!==capture.dataHash)
  throw appSheetReadinessError("final_delta_capture_binding_mismatch",{captureId});
 const gateProof=asJsonObject(binding.gateProof),stored=gateProof&&asJsonObject(gateProof.finalDelta);
 const expectedChanges=stored&&asJsonObject(stored.expectedHandoffChanges);
 const parsed=stored?finalDeltaReviewInputSchema.safeParse({manualPauseStartedAt:stored.manualPauseStartedAt,
  manualPauseEndedAt:stored.manualPauseEndedAt,manualPauseEvidenceRef:stored.manualPauseEvidenceRef,
  expectedHandoffChangesRef:expectedChanges?.reference}):null;
 if(!stored||!parsed?.success)throw appSheetReadinessError("final_delta_pause_or_fresh_capture_evidence_invalid",{captureId});
 let current:Record<string,unknown>;
 try{current=finalDeltaProofForCapture(capture,parsed.data);}catch{
  throw appSheetReadinessError("final_delta_pause_or_fresh_capture_evidence_invalid",{captureId});
 }
 if(hashJson(stored)!==hashJson(current))throw appSheetReadinessError("final_delta_pause_or_fresh_capture_evidence_invalid",{captureId});
 return capture;
}
async function requireVerifiedAppSheetReplacement(ctx:CommandContext,captureId:string,options:{allowPendingObjects?:boolean}={}):Promise<AppSheetReplacementProof>{
 const capture=await requireStableAppSheetCapture(ctx.tx,captureId);
 const masters=await ctx.tx.legacyImportSnapshot.findMany({where:{sourceSystem:APPSHEET_CANONICAL_SOURCE_SYSTEM,captureManifestId:capture.captureId,fileHash:capture.manifestHash,importerVersion:APPSHEET_CANONICAL_IMPORTER_VERSION}});
 if(masters.length!==1)throw appSheetReadinessError("canonical_master_snapshot_missing_or_ambiguous");
 const master=masters[0]!;
 if(master.status!=="reviewed"||!master.reviewedBy||master.createdBy===master.reviewedBy)
  throw appSheetReadinessError("canonical_master_human_review_pending");
 const activeMasterReview=await ctx.tx.user.findUnique({where:{id:master.reviewedBy},select:{active:true}});
 if(!activeMasterReview?.active)throw appSheetReadinessError("canonical_master_reviewer_inactive");
 const definition=requireDefinitionEvidence(master,capture);
 const mastersOpenExceptions=await ctx.tx.legacyException.count({where:{snapshotId:master.id,status:"open"}});
 if(mastersOpenExceptions!==0)throw appSheetReadinessError("canonical_master_exceptions_unresolved",{count:mastersOpenExceptions});
 const masterRecords=await ctx.tx.legacySourceRecord.findMany({where:{snapshotId:master.id},select:{id:true,sourceTable:true,sourceKey:true,contentHash:true,treatment:true}});
 const tableCoverage=Array.isArray(definition.coverageProjection.tables)?definition.coverageProjection.tables.map(asJsonObject):null;
 if(!tableCoverage||tableCoverage.some(entry=>!entry))throw appSheetReadinessError("canonical_master_coverage_missing");
 for(const table of ["C_Cliente","D_Catalogo_Mercaderia"]){
  const declared=tableCoverage.find(item=>item!.sourceTable===table);
  const actual=masterRecords.filter(record=>record.sourceTable===table).length;
  if(!declared||declared!.sourceRecordCount!==actual||declared!.canonicalTargetCount!==actual||declared!.blockingExceptionCount!==0||declared!.reviewExceptionCount!==0)
   throw appSheetReadinessError("canonical_master_table_coverage_unverified",{sourceTable:table});
 }
 if(masterRecords.some(record=>record.treatment!=="fact_candidate"))throw appSheetReadinessError("canonical_master_record_treatment_unresolved");
 if(!masterRecords.length)throw appSheetReadinessError("canonical_master_projection_empty");
 const masterAudit=await requireProjectionAudit(ctx,master.id,"appsheet.canonical_masters_staged");
 const masterAuditDetails=masterAudit.details;
 const masterAuditMatches=masterAudit.actorId===master.createdBy&&masterAuditDetails.captureId===capture.captureId&&
  masterAuditDetails.manifestHash===capture.manifestHash&&masterAuditDetails.projectionHash===definition.projectionHash&&
  masterAuditDetails.importerVersion===APPSHEET_CANONICAL_IMPORTER_VERSION&&masterAuditDetails.reviewer===definition.reviewer&&
  masterAuditDetails.reviewedAt===definition.reviewedAt&&masterAuditDetails.commitSha===definition.commitSha&&
  masterAuditDetails.target==="production"&&masterAuditDetails.backupManifestHash===definition.backupManifestHash&&
  masterAuditDetails.backupSnapshotAt===definition.backupSnapshotAt&&masterAuditDetails.recordCount===masterRecords.length&&
  masterAuditDetails.destinationCount===masterRecords.length&&masterAuditDetails.exceptionCount===0;
 if(!masterAuditMatches)throw appSheetReadinessError("canonical_master_stage_audit_binding_mismatch");
 if(masterRecords.some(record=>! ["C_Cliente","D_Catalogo_Mercaderia"].includes(record.sourceTable)))
  throw appSheetReadinessError("canonical_master_unexpected_source_table");
 const recordsByTable=new Map<string,typeof masterRecords>();
 for(const record of masterRecords){const rows=recordsByTable.get(record.sourceTable)??[];rows.push(record);recordsByTable.set(record.sourceTable,rows);}
 const identities=[] as Array<{sourceTable:string;sourceKey:string;destinationType:string;destinationId:string;approvedBy:string|null}>;
 for(const [sourceTable,rows] of recordsByTable){
  const sourceKeys=[...new Set(rows.map(record=>record.sourceKey))];
  for(let start=0;start<sourceKeys.length;start+=500){
   identities.push(...await ctx.tx.legacyIdentity.findMany({where:{sourceSystem:APPSHEET_CANONICAL_SOURCE_SYSTEM,sourceTable,sourceKey:{in:sourceKeys.slice(start,start+500)}},
    select:{sourceTable:true,sourceKey:true,destinationType:true,destinationId:true,approvedBy:true}}));
  }
 }
 const identityByKey=new Map(identities.map(identity=>[canonicalJson([identity.sourceTable,identity.sourceKey,identity.destinationType]),identity]));
 const expectedIdentityCount=masterRecords.length;
 if(identities.length!==expectedIdentityCount||identityByKey.size!==identities.length||identities.some(identity=>!identity.approvedBy))
  throw appSheetReadinessError("canonical_master_identity_review_pending");
 const identityReviewers=[...new Set(identities.map(identity=>identity.approvedBy).filter((id):id is string=>Boolean(id)))];
 const activeIdentityReviewers=[] as Array<{id:string}>;
 for(let start=0;start<identityReviewers.length;start+=500){
  activeIdentityReviewers.push(...await ctx.tx.user.findMany({where:{id:{in:identityReviewers.slice(start,start+500)},active:true},select:{id:true}}));
 }
 if(activeIdentityReviewers.length!==identityReviewers.length)throw appSheetReadinessError("canonical_master_identity_reviewer_inactive");
 const membersById=new Map<string,{id:string;legacyCustomerId:string|null;sourceSystem:string|null;sourceId:string|null}>();
 const skusById=new Map<string,{id:string;sourceSystem:string|null;sourceId:string|null;active:boolean}>();
 const objectsById=new Map<string,{id:string;kind:string}>();
 const allDestinationIds=[...new Set(identities.map(identity=>identity.destinationId))];
 for(let start=0;start<allDestinationIds.length;start+=500){
  const ids=allDestinationIds.slice(start,start+500);
  const [members,skus,objects]=await Promise.all([
   ctx.tx.operationMember.findMany({where:{id:{in:ids}},select:{id:true,legacyCustomerId:true,sourceSystem:true,sourceId:true}}),
   ctx.tx.catalogSku.findMany({where:{id:{in:ids}},select:{id:true,sourceSystem:true,sourceId:true,active:true}}),
   ctx.tx.operationObject.findMany({where:{id:{in:ids}},select:{id:true,kind:true}}),
  ]);
  for(const row of members)membersById.set(row.id,row);
  for(const row of skus)skusById.set(row.id,row);
  for(const row of objects)objectsById.set(row.id,row);
 }
 const masterRecordKeys=new Set<string>();
 for(const record of masterRecords){
  const destinationType=record.sourceTable==="C_Cliente"?"member":"sku";
  const identity=identityByKey.get(canonicalJson([record.sourceTable,record.sourceKey,destinationType]));
  if(!identity)throw appSheetReadinessError("canonical_master_identity_missing");
  const destinationMatches=destinationType==="member"
   ?(()=>{const member=membersById.get(identity.destinationId);return Boolean(member&&member.legacyCustomerId===record.sourceKey&&
     member.sourceSystem===APPSHEET_CANONICAL_SOURCE_SYSTEM&&member.sourceId===record.sourceKey);})()
   :(()=>{const sku=skusById.get(identity.destinationId);return Boolean(sku&&sku.sourceSystem===APPSHEET_CANONICAL_SOURCE_SYSTEM&&
     sku.sourceId===record.sourceKey&&sku.active);})();
  const object=objectsById.get(identity.destinationId);
  if(!destinationMatches||!object||object.kind!==destinationType)throw appSheetReadinessError("canonical_master_destination_missing");
  masterRecordKeys.add(canonicalJson([record.sourceTable,record.sourceKey]));
 }
 if(masterRecordKeys.size!==masterRecords.length)throw appSheetReadinessError("canonical_master_source_identity_ambiguous");

 const historySnapshots=await ctx.tx.legacyImportSnapshot.findMany({where:{sourceSystem:APPSHEET_HISTORY_SOURCE_SYSTEM,captureManifestId:capture.captureId,fileHash:capture.manifestHash,importerVersion:APPSHEET_HISTORY_IMPORTER_VERSION}});
 if(historySnapshots.length!==1)throw appSheetReadinessError("historical_snapshot_missing_or_ambiguous");
 const history=historySnapshots[0]!;
 if(history.status!=="reviewed"||!history.reviewedBy||history.createdBy===history.reviewedBy)
  throw appSheetReadinessError("historical_human_review_pending");
 const activeHistoryReview=await ctx.tx.user.findUnique({where:{id:history.reviewedBy},select:{active:true}});
 if(!activeHistoryReview?.active)throw appSheetReadinessError("historical_reviewer_inactive");
 const controls=asJsonObject(history.controls),stage=controls&&asJsonObject(controls.appSheetHistoryStage);
 const coverage=asJsonObject(history.coverage),historyDefinition=coverage&&asJsonObject(coverage.definition);
 const historyEffects=stage&&asJsonObject(stage.effects);
 const historyInventoryResult=appSheetDefinitionInventorySchema.safeParse(historyDefinition?.inventory);
 const historyInventory=historyInventoryResult.success?historyInventoryResult.data:null;
 const historyAppliedHash=historyInventory?appSheetAppliedDefinitionHash(historyInventory):null;
 if(!stage||!coverage||!historyDefinition||!historyInventory||stage.schemaVersion!=="appsheet-history-stage/v1"||stage.projectionKind!=="history"||
    stage.sourceSystem!==APPSHEET_HISTORY_SOURCE_SYSTEM||stage.mappingId!==APPSHEET_HISTORY_MAPPING_ID||stage.importerVersion!==APPSHEET_HISTORY_IMPORTER_VERSION||
    stage.captureId!==capture.captureId||stage.manifestHash!==capture.manifestHash||stage.dataHash!==capture.dataHash||stage.captureDefinitionHash!==null||
    stage.definitionHash!==definition.appliedHash||stage.definitionIdentityState!=="verified"||historyAppliedHash!==definition.appliedHash||
    historyInventory.app.id!==APPSHEET_EXPECTED_LIVE_APP_ID||historyDefinition.identityState!=="verified"||historyDefinition.appliedDefinitionHash!==definition.appliedHash||
    historyDefinition.sourceSha256!==historyInventory.source.sha256||historyDefinition.descriptorSha256!==historyInventory.descriptorSha256||
    coverage.schemaVersion!=="appsheet-history-coverage/v1"||coverage.projectionKind!=="history"||coverage.sourceSystem!==APPSHEET_HISTORY_SOURCE_SYSTEM||
    coverage.captureId!==capture.captureId||coverage.manifestHash!==capture.manifestHash||coverage.dataHash!==capture.dataHash||coverage.captureDefinitionHash!==null||
    coverage.appliedDefinitionHash!==definition.appliedHash||coverage.mode!=="stable"||stage.mode!=="stable"||
    stage.status!=="staged"||stage.humanReview===undefined||asJsonObject(stage.humanReview)?.status!=="pending"||
    stage.operationalAuthority===undefined||asJsonObject(stage.operationalAuthority)?.status!=="unchanged"||stage.authorizationContext!=="user-authorized-plan"||
    stage.actorUserId!==history.createdBy||stage.reviewedBy!==null||stage.reviewedAt!==null||!historyEffects||hashJson(historyEffects)!==hashJson({
     stock:false,cashLedger:false,payments:false,deliveries:false,messages:false,documents:false,numbering:"not-generated",
    })||typeof stage.backupManifestHash!=="string"||!hashPattern.test(stage.backupManifestHash)||
    typeof stage.backupSnapshotAt!=="string"||!Number.isFinite(Date.parse(stage.backupSnapshotAt))||Date.parse(stage.backupSnapshotAt)>Date.now()+60_000)
  throw appSheetReadinessError("historical_projection_capture_binding_missing");
 const historyTechnicalReview=asJsonObject(stage.technicalReview);
 if(!historyTechnicalReview||historyTechnicalReview.reviewKind!=="independent-technical"||historyTechnicalReview.approved!==true||
    sameHumanIdentity(historyTechnicalReview.reviewer,history.createdBy)||typeof historyTechnicalReview.reviewer!=="string"||!historyTechnicalReview.reviewer.trim()||
    typeof historyTechnicalReview.reviewedAt!=="string"||!Number.isFinite(Date.parse(historyTechnicalReview.reviewedAt))||Date.parse(historyTechnicalReview.reviewedAt)>Date.now()+60_000||
    historyTechnicalReview.findingsCount!==0||!hashPattern.test(String(historyTechnicalReview.findingsHash))||
    historyTechnicalReview.commitSha!==masterAuditDetails.commitSha||historyTechnicalReview.projectionHash!==stage.projectionHash||
    !hashPattern.test(String(stage.projectionHash))||historyTechnicalReview.commitSha!==definition.commitSha)
  throw appSheetReadinessError("historical_technical_review_unbound");
 const historyReviewHash=hashJson({reviewKind:historyTechnicalReview.reviewKind,approved:historyTechnicalReview.approved,projectionHash:historyTechnicalReview.projectionHash,
  captureId:stage.captureId,manifestHash:stage.manifestHash,definitionHash:stage.definitionHash,importer:APPSHEET_HISTORY_IMPORTER_VERSION,
  reviewer:historyTechnicalReview.reviewer,reviewedAt:historyTechnicalReview.reviewedAt,findingsCount:historyTechnicalReview.findingsCount,
  findingsHash:historyTechnicalReview.findingsHash,commitSha:historyTechnicalReview.commitSha});
 const historyRecords=await ctx.tx.legacySourceRecord.findMany({where:{snapshotId:history.id},select:{id:true,sourceTable:true,contentHash:true}});
 const historyFacts=await ctx.tx.legacyHistoricalFact.findMany({where:{snapshotId:history.id,mappingId:APPSHEET_HISTORY_MAPPING_ID,correctionOf:null},select:{sourceRecordId:true,sourceHash:true}});
 const historyRecordHashes=new Map(historyRecords.map(record=>[record.id,record.contentHash]));
 if(historyRecords.length===0||historyFacts.length!==historyRecords.length||historyFacts.some(fact=>historyRecordHashes.get(fact.sourceRecordId)!==fact.sourceHash))
  throw appSheetReadinessError("historical_fact_coverage_incomplete");
 const [historyExceptions,allHistoryExceptions]=await Promise.all([
  ctx.tx.legacyException.count({where:{snapshotId:history.id,status:"open"}}),
  ctx.tx.legacyException.count({where:{snapshotId:history.id}}),
 ]);
 if(historyExceptions!==0)throw appSheetReadinessError("historical_exceptions_unresolved",{count:historyExceptions});
 const historyCoverageSheets=Array.isArray(coverage.sheets)?coverage.sheets.map(asJsonObject):null;
 const historySource=asJsonObject(coverage.source),historyTotals=asJsonObject(coverage.totals),historyStability=asJsonObject(coverage.stability);
 if(!historyCoverageSheets||historyCoverageSheets.some(sheet=>!sheet)||!historySource||!historyTotals||!historyStability||historyStability.stable!==true||
    historySource.spreadsheetId!==capture.spreadsheetId||historySource.dataRecordCount!==historyRecords.length||historyTotals.recordCount!==historyRecords.length||
    historyTotals.factCount!==historyFacts.length||historyTotals.exceptionCount!==allHistoryExceptions||coverage.exceptionTotal!==allHistoryExceptions||
    historyCoverageSheets.reduce((sum,sheet)=>sum+Number(sheet!.sourceRecordCount??0),0)!==historyRecords.length||
    historyCoverageSheets.reduce((sum,sheet)=>sum+Number(sheet!.factCount??0),0)!==historyFacts.length||
    historyCoverageSheets.some(sheet=>!Number.isSafeInteger(sheet!.sourceRecordCount)||!Number.isSafeInteger(sheet!.factCount)||
     !Array.isArray(sheet!.changedPageIndexes)||sheet!.changedPageIndexes.length!==0||sheet!.unresolvedFormulaCount!==0))
  throw appSheetReadinessError("historical_source_coverage_mismatch");
 for(const hash of [stage.recordsHash,stage.factsHash,stage.exceptionsHash])if(typeof hash!=="string"||!hashPattern.test(hash))
  throw appSheetReadinessError("historical_projection_content_hash_missing");
 const historyAudit=await requireProjectionAudit(ctx,history.id,"legacy.appsheet_history_staged");
 const historyAuditDetails=historyAudit.details;
 if(historyAudit.actorId!==history.createdBy||historyAuditDetails.sourceSystem!==APPSHEET_HISTORY_SOURCE_SYSTEM||
    historyAuditDetails.importerVersion!==APPSHEET_HISTORY_IMPORTER_VERSION||historyAuditDetails.captureId!==capture.captureId||
    historyAuditDetails.manifestHash!==capture.manifestHash||historyAuditDetails.dataHash!==capture.dataHash||
    historyAuditDetails.projectionHash!==stage.projectionHash||historyAuditDetails.mode!=="stable"||
    historyAuditDetails.reviewer!==historyTechnicalReview.reviewer||historyAuditDetails.technicalReviewAt!==historyTechnicalReview.reviewedAt||
    historyAuditDetails.commitSha!==historyTechnicalReview.commitSha||historyAuditDetails.target!=="production"||
    historyAuditDetails.backupManifestHash!==stage.backupManifestHash||historyAuditDetails.backupSnapshotAt!==stage.backupSnapshotAt||
    historyAuditDetails.recordCount!==historyRecords.length||historyAuditDetails.factCount!==historyFacts.length||
    historyAuditDetails.exceptionCount!==allHistoryExceptions||historyAuditDetails.reviewedBy!==null||historyAuditDetails.status!=="staged")
  throw appSheetReadinessError("historical_stage_audit_binding_mismatch");
 const publication=await ctx.tx.legacyHistoryPublication.findUnique({where:{sourceSystem:history.sourceSystem}});
 const corrections=await ctx.tx.legacyHistoricalFact.findMany({where:{snapshotId:history.id,mappingId:APPSHEET_HISTORY_MAPPING_ID,correctionOf:{not:null}},orderBy:{id:"asc"},select:{id:true,correctionOf:true}});
 const publicationFingerprint=legacyPayloadHash({snapshotId:history.id,fileHash:history.fileHash,mappingId:APPSHEET_HISTORY_MAPPING_ID,rows:historyRecords.length,corrections});
 if(!publication||publication.snapshotId!==history.id||publication.fileHash!==capture.manifestHash||publication.mappingId!==APPSHEET_HISTORY_MAPPING_ID||publication.fingerprint!==publicationFingerprint)
  throw appSheetReadinessError("historical_publication_missing_or_stale");

 // The pending-object projector currently produces a private preview only. Never turn it into an operationally complete attestation.
 if(!options.allowPendingObjects)throw appSheetReadinessError("pending_objects_checkpoint_unavailable");
 return {
  capture:{captureId:capture.captureId,manifestHash:capture.manifestHash,dataHash:capture.dataHash,definitionHash:capture.definitionHash,
   firstReadAt:capture.firstReadAt,verificationStartedAt:capture.verificationStartedAt,verificationCompletedAt:capture.verificationCompletedAt,
   cutoffAt:capture.cutoffAt,stability:capture.stability},
  appliedDefinitionHash:definition.appliedHash,
  master:{id:master.id,fileHash:master.fileHash,sourceRecords:masterRecords.length,projectionHash:definition.projectionHash,commitSha:definition.commitSha,
   technicalReviewHash:definition.reviewHash,backupManifestHash:definition.backupManifestHash},
  history:{id:history.id,fileHash:history.fileHash,sourceRecords:historyRecords.length,facts:historyFacts.length,publicationFingerprint:publication.fingerprint,
   projectionHash:String(stage.projectionHash),commitSha:String(historyTechnicalReview.commitSha),technicalReviewHash:historyReviewHash},
 };
}

type OpeningSourceKind="cash"|"stock";
type OpeningSourceExpectation={kind:OpeningSourceKind;amountMinor?:bigint;currency?:string;quantity?:string;unit?:string;skuSourceId?:string;allowAlreadyLinked?:boolean};
/** Bind opening effects to a reviewed fact under the exact AppSheet capture; a caller-supplied ID alone proves nothing. */
export async function requireAppSheetOpeningSourceRecord(ctx:CommandContext,sourceRecordId:string|undefined,expected:OpeningSourceExpectation){
 const authority=await ctx.tx.operationAuthority.findUnique({where:{id:"operations"},select:{mode:true,cutoverProfile:true,captureManifestId:true}});
 const boundGates=await ctx.tx.cutoverGate.findMany({where:{captureManifestId:{not:null}},select:{captureManifestId:true}});
 const boundCaptureIds=[...new Set(boundGates.flatMap(row=>row.captureManifestId?[row.captureManifestId]:[]))];
 let captureId=authority?.mode==="active"&&authority.cutoverProfile==="appsheet-replacement"?authority.captureManifestId:null;
 if(boundCaptureIds.length>1)throw appSheetReadinessError("opening_cutover_capture_ambiguous");
 if(boundCaptureIds.length===1){if(captureId&&captureId!==boundCaptureIds[0])throw appSheetReadinessError("opening_cutover_capture_mismatch");captureId??=boundCaptureIds[0]!;}
 if(!sourceRecordId){if(captureId)throw appSheetReadinessError("opening_source_record_required");return null;}
 const source=await ctx.tx.legacySourceRecord.findUnique({where:{id:sourceRecordId},select:{id:true,sourceTable:true,sourceKey:true,contentHash:true,fileHash:true,snapshotId:true,treatment:true,
  snapshot:{select:{sourceSystem:true,fileHash:true,captureManifestId:true,importerVersion:true,status:true,createdBy:true,reviewedBy:true}}}});
 if(!source||source.treatment!=="fact_candidate"||source.snapshot.sourceSystem!==APPSHEET_HISTORY_SOURCE_SYSTEM||!source.snapshot.captureManifestId||source.snapshot.fileHash!==source.fileHash)
  throw appSheetReadinessError("opening_source_record_not_historical_capture");
 if(captureId&&captureId!==source.snapshot.captureManifestId)throw appSheetReadinessError("opening_source_record_capture_mismatch");
 captureId=source.snapshot.captureManifestId;
 const capture=await requireApprovedAppSheetFinalDeltaGate(ctx.tx,captureId);
 if(source.fileHash!==capture.manifestHash||source.snapshot.importerVersion!==APPSHEET_HISTORY_IMPORTER_VERSION||source.snapshot.status!=="reviewed"||!source.snapshot.reviewedBy||source.snapshot.createdBy===source.snapshot.reviewedBy)
  throw appSheetReadinessError("opening_source_record_not_reviewed_for_capture");
 const reviewer=await ctx.tx.user.findUnique({where:{id:source.snapshot.reviewedBy},select:{active:true}});
 if(!reviewer?.active)throw appSheetReadinessError("opening_source_reviewer_inactive");
 const [publication,fact,openExceptions]=await Promise.all([
  ctx.tx.legacyHistoryPublication.findUnique({where:{sourceSystem:APPSHEET_HISTORY_SOURCE_SYSTEM}}),
  ctx.tx.legacyHistoricalFact.findFirst({where:{snapshotId:source.snapshotId,sourceRecordId:source.id,mappingId:APPSHEET_HISTORY_MAPPING_ID,correctionOf:null},select:{sourceHash:true,kind:true,amountMinor:true,amountState:true,currency:true,currencyState:true,quantity:true,quantityState:true,unit:true,unitState:true,attributes:true}}),
  ctx.tx.legacyException.count({where:{snapshotId:source.snapshotId,sourceRecordId:source.id,status:"open"}}),
 ]);
 if(!publication||publication.snapshotId!==source.snapshotId||publication.fileHash!==capture.manifestHash||publication.mappingId!==APPSHEET_HISTORY_MAPPING_ID||fact?.sourceHash!==source.contentHash||openExceptions!==0)
  throw appSheetReadinessError("opening_source_history_publication_or_hash_missing");
 if(expected.kind==="cash"){
  if(["Movimiento","Movimiento_Nueva"].includes(source.sourceTable))throw appSheetReadinessError("cash_opening_source_is_cashflow");
  if(!["Movimiento","Movimiento_Nueva"].includes(source.sourceTable)||fact.kind!=="cash"||fact.amountState!=="known"||fact.currencyState!=="known"||fact.amountMinor!==expected.amountMinor||fact.currency!==expected.currency)
   throw appSheetReadinessError("cash_opening_source_value_mismatch");
 }else{
  if(source.sourceTable==="Mov_Stock1")throw appSheetReadinessError("stock_opening_source_is_ledger_movement");
  if(fact.quantityState!=="known"||fact.unitState!=="known"||!fact.quantity?.equals(expected.quantity??"")||fact.unit!==expected.unit)
   throw appSheetReadinessError("stock_opening_source_quantity_or_unit_mismatch");
  const attributes=asJsonObject(fact.attributes),relationships=attributes&&Array.isArray(attributes.relationships)?attributes.relationships.map(asJsonObject):[];
  const skuRelationship=relationships.find(item=>item?.targetTable==="D_Catalogo_Mercaderia"&&item.status==="unique"&&item.targetSourceKey===expected.skuSourceId);
  if(!expected.skuSourceId||!skuRelationship)throw appSheetReadinessError("stock_opening_source_sku_relationship_unverified");
 }
 if(!expected.allowAlreadyLinked){
  const linked=expected.kind==="cash"
   ?await ctx.tx.ledgerEvent.count({where:{kind:"opening",sourceRecordId:source.id}})
   :await ctx.tx.stockFact.count({where:{kind:"opening",sourceRecordId:source.id}});
  if(linked)throw appSheetReadinessError("opening_source_record_already_consumed");
 }
 return {captureId,sourceRecordId:source.id,sourceTable:source.sourceTable,sourceKey:source.sourceKey,contentHash:source.contentHash,sourceHash:fact.sourceHash};
}

async function requireAppSheetCashOpeningProof(ctx:CommandContext,proof:AppSheetReplacementProof){
 const [accounts,openings]=await Promise.all([
  ctx.tx.operationAccount.findMany({where:{active:true},orderBy:{id:"asc"},select:{id:true,currency:true,verified:true,openingMinor:true,openingApprovedBy:true}}),
  ctx.tx.ledgerEvent.findMany({where:{kind:"opening"},orderBy:{id:"asc"},select:{id:true,sourceRecordId:true,legs:{select:{accountId:true,currency:true,amountMinor:true}}}}),
 ]);
 if(!accounts.length||openings.length!==accounts.length||accounts.some(account=>!account.verified||!account.openingApprovedBy))
  throw appSheetReadinessError("cash_opening_accounts_or_events_incomplete",{accountCount:accounts.length,openingEventCount:openings.length});
 const accountsById=new Map(accounts.map(account=>[account.id,account]));
 const sourceBindings=[];
 for(const opening of openings){
  const leg=opening.legs.length===1?opening.legs[0]:null,account=leg?accountsById.get(leg.accountId):null;
  if(!opening.sourceRecordId||!leg||!account||leg.currency!==account.currency||leg.amountMinor!==account.openingMinor)
   throw appSheetReadinessError("cash_opening_event_source_or_balance_mismatch");
  const source=await requireAppSheetOpeningSourceRecord(ctx,opening.sourceRecordId,{kind:"cash",amountMinor:leg.amountMinor,currency:leg.currency,allowAlreadyLinked:true});
  if(!source||source.captureId!==proof.capture.captureId)throw appSheetReadinessError("cash_opening_source_capture_mismatch");
  sourceBindings.push({accountId:account.id,sourceRecordId:source.sourceRecordId,contentHash:source.contentHash,amountMinor:leg.amountMinor.toString(),currency:leg.currency});
 }
 return {accountCount:accounts.length,openingEventCount:openings.length,sourceBindingHash:hashJson(sourceBindings)};
}

async function requireAppSheetStockOpeningProof(ctx:CommandContext,proof:AppSheetReplacementProof){
 const openings=await ctx.tx.stockFact.findMany({where:{kind:"opening"},orderBy:{id:"asc"},select:{id:true,sourceRecordId:true,quantity:true,unit:true,lotId:true}});
 if(!openings.length)throw appSheetReadinessError("physical_opening_facts_missing");
 const lots=await ctx.tx.inventoryLot.findMany({where:{id:{in:[...new Set(openings.map(opening=>opening.lotId))]}},select:{id:true,sku:{select:{sourceId:true}}}});
 const skuSources=new Map(lots.map(lot=>[lot.id,lot.sku.sourceId]));
 const sourceBindings=[];
 for(const opening of openings){
  if(!opening.sourceRecordId)throw appSheetReadinessError("physical_opening_source_record_missing");
  const skuSourceId=skuSources.get(opening.lotId);
  if(skuSourceId===undefined)throw appSheetReadinessError("physical_opening_lot_or_master_link_missing");
  const source=await requireAppSheetOpeningSourceRecord(ctx,opening.sourceRecordId,{kind:"stock",quantity:opening.quantity.toString(),unit:opening.unit,skuSourceId:skuSourceId??undefined,allowAlreadyLinked:true});
  if(!source||source.captureId!==proof.capture.captureId)throw appSheetReadinessError("physical_opening_source_capture_mismatch");
  sourceBindings.push({factId:opening.id,sourceRecordId:source.sourceRecordId,contentHash:source.contentHash,quantity:opening.quantity.toString(),unit:opening.unit});
 }
 return {openingFactCount:openings.length,sourceBindingHash:hashJson(sourceBindings)};
}

registerCommand("AccessGranted",{kind:"access",capability:"access.manage",create:true,administrative:true,
 schema:z.strictObject({userId:objectId,profile,additional:z.array(z.string()).default([]),scope:z.strictObject({accountIds:z.array(objectId).optional(),memberIds:z.array(objectId).optional(),locationIds:z.array(objectId).optional(),custodianIds:z.array(objectId).optional()}).default({})}),
 execute:async ctx=>{
  const v=ctx.envelope.data as {userId:string;profile:string;additional:string[];scope:Record<string,unknown>};
  if (!await ctx.tx.user.findUnique({where:{id:v.userId}})) throw new OperationError(404,"USER_NOT_FOUND","Usuario no encontrado");
  if(v.additional.some(c=>!defaultCapabilities.has(c as Capability))) throw new OperationError(400,"UNKNOWN_CAPABILITY","Capacidad desconocida");
  const granted=[...new Set([...profileCapabilities[v.profile],...v.additional])];
  await ctx.tx.operationAccess.upsert({where:{userId:v.userId},create:{userId:v.userId,profile:v.profile,capabilities:json(granted),scope:json(v.scope)},update:{profile:v.profile,capabilities:json(granted),scope:json(v.scope),enabled:true}});
  await ctx.tx.user.update({where:{id:v.userId},data:{authorizationEpoch:{increment:1}}});
  await ctx.tx.operationSession.updateMany({where:{userId:v.userId,revokedAt:null},data:{revokedAt:ctx.now}});
  await ctx.tx.offlineLease.updateMany({where:{userId:v.userId,revokedAt:null},data:{revokedAt:ctx.now}});
  return {userId:v.userId,profile:v.profile,capabilities:granted,requiresLogin:true};
 }});
registerCommand("AccessRevoked",{kind:"access",capability:"access.manage",create:true,administrative:true,
 schema:z.strictObject({userId:objectId,reason:z.string().min(1).max(1000)}),
 execute:async ctx=>{
  const id=ctx.envelope.data.userId as string;
  if(id===ctx.actor.id)throw new OperationError(409,"SELF_REVOCATION","Otro propietario debe revisar la revocación propia");
  await ctx.tx.user.update({where:{id},data:{active:false,authorizationEpoch:{increment:1}}});
  await ctx.tx.operationAccess.updateMany({where:{userId:id},data:{enabled:false}});
  await ctx.tx.operationSession.updateMany({where:{userId:id},data:{revokedAt:ctx.now}});
  await ctx.tx.operationDevice.updateMany({where:{userId:id},data:{revokedAt:ctx.now}});
  await ctx.tx.offlineLease.updateMany({where:{userId:id},data:{revokedAt:ctx.now}});
  return {userId:id,status:"revoked"};
 }});
registerCommand("DeviceRegistered",{kind:"device",capability:"delivery.report",create:true,administrative:true,
 schema:z.strictObject({name:z.string().min(1).max(100)}),
 execute:async ctx=>{
  if(!z.uuid().safeParse(ctx.envelope.targetId).success)throw new OperationError(400,"DEVICE_UUID_REQUIRED","El dispositivo requiere UUID");
  const device=await ctx.tx.operationDevice.create({data:{id:ctx.envelope.targetId,userId:ctx.actor.id,name:ctx.envelope.data.name as string}});
  return {device};
 }});
registerCommand("DeviceCertified",{kind:"device",capability:"access.manage",administrative:true,
 schema:z.strictObject({storageCertified:z.literal(true),evidence}),
 execute:async ctx=>({device:await ctx.tx.operationDevice.update({where:{id:ctx.envelope.targetId},data:{storageCertified:true,storageCertifiedAt:ctx.now,evidence:json(ctx.envelope.data.evidence)}})})});
registerCommand("DeviceRevoked",{kind:"device",capability:"access.manage",administrative:true,
 schema:z.strictObject({reason:z.string().min(1).max(1000)}),
 execute:async ctx=>{
  await ctx.tx.operationDevice.update({where:{id:ctx.envelope.targetId},data:{revokedAt:ctx.now}});
  await ctx.tx.offlineLease.updateMany({where:{deviceId:ctx.envelope.targetId,revokedAt:null},data:{revokedAt:ctx.now}});
  return {status:"revoked"};
 }});
registerCommand("MemberCreated",{kind:"member",capability:"members.write",create:true,
 schema:z.strictObject({name:z.string().min(1).max(200),email:z.union([z.email(),z.literal("")]).default(""),phone:z.string().max(80).default(""),address:commercialAddress.default({}),preferences:commercialPreferences.default({})}),
 execute:async ctx=>({member:await ctx.tx.operationMember.create({data:{id:ctx.envelope.targetId,...ctx.envelope.data as {name:string;email:string;phone:string},address:json(ctx.envelope.data.address),preferences:json(ctx.envelope.data.preferences)}})})});
registerCommand("MemberUpdated",{kind:"member",capability:"members.write",
 schema:z.strictObject({name:z.string().min(1).max(200),email:z.union([z.email(),z.literal("")]),phone:z.string().max(80),address:commercialAddress,preferences:commercialPreferences}),
 execute:async ctx=>({member:await ctx.tx.operationMember.update({where:{id:ctx.envelope.targetId},data:{...ctx.envelope.data as {name:string;email:string;phone:string},address:json(ctx.envelope.data.address),preferences:json(ctx.envelope.data.preferences)}})})});
registerCommand("PermissionVerified",{kind:"member",capability:"permissions.verify",
 schema:z.strictObject({kind:z.string().min(1).max(80),validFrom:civilDate,validUntil:civilDate,evidenceDocumentId:z.uuid()}),
 execute:async ctx=>{
  const v=ctx.envelope.data as {kind:string;validFrom:string;validUntil:string;evidenceDocumentId:string};
  if(v.validUntil<v.validFrom)throw new OperationError(400,"PERMISSION_DATES","La vigencia está invertida");
  const document=await ctx.tx.operationDocument.findUnique({where:{id:v.evidenceDocumentId}});
  if(!document||document.memberId!==ctx.envelope.targetId||document.state!=="available")throw new OperationError(422,"PERMISSION_EVIDENCE","Se requiere documento disponible del socio");
  if(document.sensitivity==="clinical")await requireCapability(ctx.tx,ctx.actor,"clinical.review");
  const permission=await ctx.tx.memberPermission.create({data:{memberId:ctx.envelope.targetId,...v,status:"verified",reviewerId:ctx.actor.id,reviewedAt:ctx.now}});
  return {permission};
 }});
registerCommand("ClinicalRecordReviewed",{kind:"member",capability:"clinical.review",administrative:true,
 schema:z.strictObject({status:z.enum(["verified","rejected","needs_information"]),evidenceDocumentId:z.uuid(),evidence}),execute:async ctx=>{
  const document=await ctx.tx.operationDocument.findUnique({where:{id:ctx.envelope.data.evidenceDocumentId as string}});
  if(!document||document.memberId!==ctx.envelope.targetId||document.sensitivity!=="clinical"||document.state!=="available")throw new OperationError(422,"CLINICAL_EVIDENCE_REQUIRED","La revisión requiere un documento clínico disponible del socio");
  const provenance=json({evidenceDocumentId:document.id,checksum:document.checksum,reference:ctx.envelope.data.evidence});
  const clinical=await ctx.tx.memberClinicalRecord.upsert({where:{memberId:ctx.envelope.targetId},create:{memberId:ctx.envelope.targetId,provenance,encryptedObjectKey:document.objectKey,verification:ctx.envelope.data.status as string,reviewedBy:ctx.actor.id,reviewedAt:ctx.now},update:{provenance,encryptedObjectKey:document.objectKey,verification:ctx.envelope.data.status as string,reviewedBy:ctx.actor.id,reviewedAt:ctx.now}});
  return {clinical};
 }});
const cutoverGateReviewSchema=z.strictObject({gateId:z.enum(cutoverGateIds),cutoverProfile:z.enum(cutoverProfiles).default("legacy"),captureId:z.string().regex(/^appsreal-[a-f0-9]{16}$/).optional(),authorId:objectId,evidence,
 manualPauseStartedAt:z.iso.datetime({offset:true}).optional(),manualPauseEndedAt:z.iso.datetime({offset:true}).nullable().optional(),
 manualPauseEvidenceRef:z.string().trim().min(3).max(500).optional(),expectedHandoffChangesRef:z.string().trim().min(3).max(500).optional()}).superRefine((value,ctx)=>{
 if(value.cutoverProfile==="appsheet-replacement"&&!value.captureId)ctx.addIssue({code:"custom",path:["captureId"],message:"La revisión de reemplazo requiere una captura identificada."});
 const finalDeltaFields=[value.manualPauseStartedAt,value.manualPauseEndedAt,value.manualPauseEvidenceRef,value.expectedHandoffChangesRef];
 if(value.cutoverProfile==="appsheet-replacement"&&value.gateId==="final-delta-reconciled"){
  if(!value.manualPauseStartedAt)ctx.addIssue({code:"custom",path:["manualPauseStartedAt"],message:"Registrá cuándo se pausó manualmente AppSheet."});
  if(!value.manualPauseEvidenceRef?.trim())ctx.addIssue({code:"custom",path:["manualPauseEvidenceRef"],message:"Agregá la referencia verificable de la pausa."});
  if(!value.expectedHandoffChangesRef?.trim())ctx.addIssue({code:"custom",path:["expectedHandoffChangesRef"],message:"Vinculá por separado la revisión de cambios esperados del legado."});
 }else if(finalDeltaFields.some(field=>field!==undefined)){
  ctx.addIssue({code:"custom",path:["gateId"],message:"La evidencia de pausa sólo corresponde al control de diferencias finales del reemplazo."});
 }
});
type CutoverGateReview=z.infer<typeof cutoverGateReviewSchema>;
async function requireGateHumanReview(ctx:CommandContext,v:CutoverGateReview){
 if(v.authorId===ctx.actor.id)throw new OperationError(409,"INDEPENDENT_REVIEW_REQUIRED","Autor y revisor deben ser personas distintas");
 const [author,reviewer]=await Promise.all([
  ctx.tx.user.findUnique({where:{id:v.authorId},select:{id:true,active:true}}),
  ctx.tx.user.findUnique({where:{id:ctx.actor.id},select:{id:true,active:true}}),
 ]);
 if(!author)throw new OperationError(404,"AUTHOR_NOT_FOUND","Autor no encontrado");
 if(!author.active||!reviewer?.active)throw new OperationError(409,"AUTHOR_INACTIVE","El autor y la persona revisora deben seguir activos");
 if(v.cutoverProfile==="legacy")return {captureId:null as string|null,proof:null as AppSheetReplacementProof|null,gateProof:null as Record<string,unknown>|null};
 if(v.gateId==="legacy-writes-disabled")throw appSheetReadinessError("legacy_writes_remain_enabled_by_cutover_decision");
 const proof=await requireVerifiedAppSheetReplacement(ctx,v.captureId!,{allowPendingObjects:true});
 if(v.gateId==="open-objects-approved")throw appSheetReadinessError("pending_objects_checkpoint_unavailable");
 let gateProof:Record<string,unknown>|null=null;
 if(v.gateId==="final-delta-reconciled"){
  const finalDeltaInput=finalDeltaReviewInputSchema.parse({manualPauseStartedAt:v.manualPauseStartedAt,manualPauseEndedAt:v.manualPauseEndedAt,
   manualPauseEvidenceRef:v.manualPauseEvidenceRef,expectedHandoffChangesRef:v.expectedHandoffChangesRef});
  gateProof={finalDelta:finalDeltaProofForCapture(proof.capture,finalDeltaInput)};
 }
 if(v.gateId==="cash-opening-approved")gateProof=await requireAppSheetCashOpeningProof(ctx,proof);
 if(v.gateId==="physical-opening-approved")gateProof=await requireAppSheetStockOpeningProof(ctx,proof);
 return {captureId:proof.capture.captureId,proof,gateProof};
}
function replacementGateEvidence(evidenceValue:Record<string,unknown>,proof:AppSheetReplacementProof,gateProof:Record<string,unknown>|null){
 return json({humanEvidence:evidenceValue,appSheetReplacement:{schemaVersion:1,captureId:proof.capture.captureId,manifestHash:proof.capture.manifestHash,dataHash:proof.capture.dataHash,
  captureDefinitionHash:proof.capture.definitionHash,appliedDefinitionHash:proof.appliedDefinitionHash,
  masterSnapshotId:proof.master.id,masterFileHash:proof.master.fileHash,masterSourceRecordCount:proof.master.sourceRecords,
  masterProjectionHash:proof.master.projectionHash,masterCommitSha:proof.master.commitSha,masterTechnicalReviewHash:proof.master.technicalReviewHash,
  backupManifestHash:proof.master.backupManifestHash,
  historySnapshotId:proof.history.id,historyFileHash:proof.history.fileHash,historySourceRecordCount:proof.history.sourceRecords,
  historyFactCount:proof.history.facts,historyPublicationFingerprint:proof.history.publicationFingerprint,
  historyProjectionHash:proof.history.projectionHash,historyCommitSha:proof.history.commitSha,historyTechnicalReviewHash:proof.history.technicalReviewHash,gateProof}});
}
registerCommand("CutoverGateReviewed",{kind:"cutover",capability:"cutover.approve",create:true,administrative:true,
 schema:cutoverGateReviewSchema,
 authorize:async ctx=>{await requireGateHumanReview(ctx,cutoverGateReviewSchema.parse(ctx.envelope.data));},
 execute:async ctx=>{
  const v=cutoverGateReviewSchema.parse(ctx.envelope.data);
  const {captureId,proof,gateProof}=await requireGateHumanReview(ctx,v);
  const storedEvidence=v.cutoverProfile==="appsheet-replacement"&&proof?replacementGateEvidence(v.evidence,proof,gateProof):json(v.evidence);
  await ctx.tx.cutoverGate.upsert({where:{id:v.gateId},create:{id:v.gateId,status:"approved",evidence:storedEvidence,captureManifestId:captureId,approvedBy:v.authorId,reviewedBy:ctx.actor.id,approvedAt:ctx.now},update:{status:"approved",evidence:storedEvidence,captureManifestId:captureId,approvedBy:v.authorId,reviewedBy:ctx.actor.id,approvedAt:ctx.now}});
  return {gateId:v.gateId,status:"approved",cutoverProfile:v.cutoverProfile,captureId};
}});
function replacementBindingMatchesProof(binding:JsonObject,proof:AppSheetReplacementProof){
 return binding.captureId===proof.capture.captureId&&binding.manifestHash===proof.capture.manifestHash&&binding.dataHash===proof.capture.dataHash&&
  binding.captureDefinitionHash===proof.capture.definitionHash&&binding.appliedDefinitionHash===proof.appliedDefinitionHash&&
  binding.masterSnapshotId===proof.master.id&&binding.masterFileHash===proof.master.fileHash&&binding.masterSourceRecordCount===proof.master.sourceRecords&&
  binding.masterProjectionHash===proof.master.projectionHash&&binding.masterCommitSha===proof.master.commitSha&&
  binding.masterTechnicalReviewHash===proof.master.technicalReviewHash&&binding.backupManifestHash===proof.master.backupManifestHash&&
  binding.historySnapshotId===proof.history.id&&binding.historyFileHash===proof.history.fileHash&&
  binding.historySourceRecordCount===proof.history.sourceRecords&&binding.historyFactCount===proof.history.facts&&
  binding.historyPublicationFingerprint===proof.history.publicationFingerprint&&binding.historyProjectionHash===proof.history.projectionHash&&
  binding.historyCommitSha===proof.history.commitSha&&binding.historyTechnicalReviewHash===proof.history.technicalReviewHash;
}
async function requireApprovedCutoverGates(ctx:CommandContext,cutoverProfile:CutoverProfile,captureId?:string,proof?:AppSheetReplacementProof){
 const requiredGateIds=cutoverProfile==="appsheet-replacement"?cutoverGateIds.filter(id=>id!=="legacy-writes-disabled"):cutoverGateIds;
 const gates=await ctx.tx.cutoverGate.findMany({where:{id:{in:[...requiredGateIds]},status:"approved"}});
 const gateActorIds=[...new Set(gates.flatMap(g=>[g.approvedBy,g.reviewedBy].filter((id):id is string=>typeof id==="string"&&id.length>0)))];
 const activeGateActors=gateActorIds.length?await ctx.tx.user.findMany({where:{id:{in:gateActorIds},active:true},select:{id:true}}):[];
 const activeGateActorIds=new Set(activeGateActors.map(user=>user.id));
 const gatesById=new Map(gates.map(g=>[g.id,g]));
 const capture=cutoverProfile==="appsheet-replacement"&&captureId?await ctx.tx.appSheetCaptureManifest.findUnique({where:{captureId},select:{captureId:true,manifestHash:true,dataHash:true,definitionHash:true}}):null;
 const boundEvidence=[...gatesById.values()].flatMap(gate=>{
  if(cutoverProfile!=="appsheet-replacement")return [];
  const envelope=asJsonObject(gate.evidence),binding=envelope&&asJsonObject(envelope.appSheetReplacement);
  return binding?[binding]:[];
 });
 const expectedAppliedDefinitionHash=proof?.appliedDefinitionHash??boundEvidence[0]?.appliedDefinitionHash;
 const missing=requiredGateIds.filter(id=>{
  const gate=gatesById.get(id);
  const envelope=gate&&asJsonObject(gate.evidence),binding=envelope&&asJsonObject(envelope.appSheetReplacement);
  return !gate?.approvedBy||!gate.reviewedBy||gate.approvedBy===gate.reviewedBy||!activeGateActorIds.has(gate.approvedBy)||!activeGateActorIds.has(gate.reviewedBy)||
   (cutoverProfile==="appsheet-replacement"&&(!captureId||!capture||gate.captureManifestId!==captureId||!binding||binding.captureId!==captureId||
    binding.manifestHash!==capture.manifestHash||binding.dataHash!==capture.dataHash||binding.captureDefinitionHash!==capture.definitionHash||
    binding.appliedDefinitionHash!==expectedAppliedDefinitionHash||Boolean(proof&&!replacementBindingMatchesProof(binding,proof))));
 });
 if(missing.length)throw new OperationError(422,"CUTOVER_GATES_PENDING","Faltan controles para el cambio de autoridad",{missing});
 if(cutoverProfile==="appsheet-replacement"&&proof){
  const gate=gatesById.get("final-delta-reconciled"),envelope=gate&&asJsonObject(gate.evidence),binding=envelope&&asJsonObject(envelope.appSheetReplacement);
  const gateProof=binding&&asJsonObject(binding.gateProof),stored=gateProof&&asJsonObject(gateProof.finalDelta);
  const savedInput=stored?finalDeltaReviewInputSchema.safeParse({manualPauseStartedAt:stored.manualPauseStartedAt,
   manualPauseEndedAt:stored.manualPauseEndedAt,manualPauseEvidenceRef:stored.manualPauseEvidenceRef,
   expectedHandoffChangesRef:asJsonObject(stored.expectedHandoffChanges)?.reference}):null;
  if(!stored||!savedInput?.success||hashJson(stored)!==hashJson(finalDeltaProofForCapture(proof.capture,savedInput.data)))
   throw appSheetReadinessError("final_delta_pause_or_fresh_capture_evidence_invalid");
 }
}
async function requireReplacementOpeningGateEvidence(ctx:CommandContext,proof:AppSheetReplacementProof){
 const gates=await ctx.tx.cutoverGate.findMany({where:{id:{in:["cash-opening-approved","physical-opening-approved"]},status:"approved"},select:{id:true,evidence:true}});
 const byId=new Map(gates.map(gate=>[gate.id,gate]));
 const cash=await requireAppSheetCashOpeningProof(ctx,proof),stock=await requireAppSheetStockOpeningProof(ctx,proof);
 for(const [id,current] of [["cash-opening-approved",cash],["physical-opening-approved",stock]] as const){
  const envelope=asJsonObject(byId.get(id)?.evidence),binding=envelope&&asJsonObject(envelope.appSheetReplacement),stored=binding&&asJsonObject(binding.gateProof);
  if(!stored||!binding||!replacementBindingMatchesProof(binding,proof)||hashJson(stored)!==hashJson(current))
   throw appSheetReadinessError("opening_gate_evidence_missing_or_stale",{gateId:id});
 }
}
const authoritySuspensionSchema=z.strictObject({reason:z.string().trim().min(8).max(1000)});
async function requireActiveOperationsAuthority(ctx:CommandContext){
 if(ctx.envelope.targetId!=="operations")throw new OperationError(400,"AUTHORITY_ID","Circuito inválido");
 const actor=await ctx.tx.user.findUnique({where:{id:ctx.actor.id},select:{active:true,role:true}});
 if(!actor?.active||actor.role!=="owner")throw new OperationError(403,"OWNER_REQUIRED","Sólo el propietario activo puede suspender la autoridad operativa");
 const authority=await ctx.tx.operationAuthority.findUnique({where:{id:"operations"}});
 if(authority?.mode!=="active")throw new OperationError(409,"AUTHORITY_NOT_ACTIVE","La autoridad operativa no está activa");
 return authority;
}
registerCommand("AuthoritySuspended",{kind:"authority",capability:"cutover.approve",create:true,administrative:true,
 schema:authoritySuspensionSchema,
 authorize:async ctx=>{await requireActiveOperationsAuthority(ctx);},
 execute:async ctx=>{
  const current=await requireActiveOperationsAuthority(ctx);
  const reason=(ctx.envelope.data.reason as string).trim();
  // Preserve capture, profile, approval evidence, first-write timestamp and all operational rows.
  const authority=await ctx.tx.operationAuthority.update({where:{id:"operations"},data:{mode:"shadow",epoch:{increment:1}}});
  await audit(ctx,"AuthoritySuspendedReason",{reason,previousMode:current.mode,cutoverProfile:current.cutoverProfile,
   captureManifestId:current.captureManifestId,firstRealWriteAt:current.firstRealWriteAt?.toISOString()??null});
  return {authority,reason};
 }});
const authorityActivationSchema=z.strictObject({cutoverProfile:z.enum(cutoverProfiles).default("legacy"),captureId:z.string().regex(/^appsreal-[a-f0-9]{16}$/).optional(),evidence}).superRefine((value,ctx)=>{
 if(value.cutoverProfile==="appsheet-replacement"&&!value.captureId)ctx.addIssue({code:"custom",path:["captureId"],message:"El reemplazo de AppSheet requiere una captura identificada."});
});
registerCommand("AuthorityActivated",{kind:"authority",capability:"cutover.approve",create:true,administrative:true,
 schema:authorityActivationSchema,
 authorize:async ctx=>{
  if(ctx.envelope.targetId!=="operations")throw new OperationError(400,"AUTHORITY_ID","Circuito inválido");
  const input=authorityActivationSchema.parse(ctx.envelope.data);
  if(input.cutoverProfile==="appsheet-replacement"){
   const proof=await requireVerifiedAppSheetReplacement(ctx,input.captureId!);
   await requireApprovedCutoverGates(ctx,input.cutoverProfile,input.captureId,proof);
   await requireReplacementOpeningGateEvidence(ctx,proof);
  }else await requireApprovedCutoverGates(ctx,input.cutoverProfile,input.captureId);
  if(process.env.CLUB_OPERATIONS_APPROVED!=="true")throw new OperationError(423,"CLUB_OPERATIONS_APPROVAL_REQUIRED","La habilitación operativa requiere aprobación documentada");
 },
 execute:async ctx=>{
  if(ctx.envelope.targetId!=="operations")throw new OperationError(400,"AUTHORITY_ID","Circuito inválido");
  const input=authorityActivationSchema.parse(ctx.envelope.data);
  if(input.cutoverProfile==="appsheet-replacement"){
   const proof=await requireVerifiedAppSheetReplacement(ctx,input.captureId!);
   await requireApprovedCutoverGates(ctx,input.cutoverProfile,input.captureId,proof);
   await requireReplacementOpeningGateEvidence(ctx,proof);
  }else await requireApprovedCutoverGates(ctx,input.cutoverProfile,input.captureId);
  const old=await ctx.tx.operationAuthority.findUnique({where:{id:"operations"}});
  if(old?.mode==="active")throw new OperationError(409,"AUTHORITY_ALREADY_ACTIVE","El circuito ya está activo");
  const authority=await ctx.tx.operationAuthority.upsert({where:{id:"operations"},create:{id:"operations",mode:"active",cutoverProfile:input.cutoverProfile,captureManifestId:input.cutoverProfile==="appsheet-replacement"?input.captureId:null,epoch:2,approvedBy:ctx.actor.id,evidence:json(input.evidence)},update:{mode:"active",cutoverProfile:input.cutoverProfile,captureManifestId:input.cutoverProfile==="appsheet-replacement"?input.captureId:null,epoch:{increment:1},approvedBy:ctx.actor.id,evidence:json(input.evidence)}});
  return {authority};
 }});
/** Field/route enforcement for compatibility APIs. Driver and clinical profiles have no broad legacy views. */
export const legacyAccessGuard: RequestHandler = async (req,res,next)=>{
 try {
    if(/^\/(operations|delivery|legacy-imports)(\/|$)/.test(req.path)||/^\/reports\/operations(\/|$)/.test(req.path))return next();
    const decisionInputAttestationPost = req.method === "POST" && req.path === "/decision-inputs/attestations";
    const grant=await db.operationAccess.findUnique({where:{userId:req.user.id}});
    const caps=await capabilities(db,req.user);
    if(grant&&(!grant.enabled||["driver","clinical"].includes(grant.profile)))throw new OperationError(403,"LEGACY_SCOPE","Usá las vistas autorizadas de tu perfil");
    const scope=grant?.scope as {accountIds?:string[];memberIds?:string[];locationIds?:string[]}|undefined;
    if(scope&&Object.values(scope).some(v=>Array.isArray(v)))throw new OperationError(403,"LEGACY_SCOPE","Las vistas antiguas no permiten comprobar tu alcance por objeto; usá operación");
    const finance=/^\/(finance|cash|expenses|closures|decision-analysis\/(cash|finance))/.test(req.path)||req.path==="/views/finance";
    if(finance&&grant&&!caps.includes("finance.read"))throw new OperationError(403,"CAPABILITY_REQUIRED","Acceso financiero restringido");
    if(/^\/reports/.test(req.path)&&grant&&!caps.includes("reports.read"))throw new OperationError(403,"CAPABILITY_REQUIRED","Exportación restringida");
    if(decisionInputAttestationPost&&!canManageDecisionInputAttestations(req.user,grant))
      throw new OperationError(403,"LEGACY_SCOPE","La declaración financiera requiere un perfil gestor sin alcance por objeto");
    if(req.method!=="GET"&&req.method!=="HEAD"){
      const authority=await db.operationAuthority.findUnique({where:{id:"operations"}});
      if(authority?.mode==="active"&&!(decisionInputAttestationPost&&canManageDecisionInputAttestations(req.user,grant)))
        throw new OperationError(410,"LEGACY_WRITER_RETIRED","Este circuito usa los comandos operativos de Bombo");
    }
    next();
  }catch(e){next(e);}
};
export async function authorizeDocument(ctx: Pick<CommandContext,"tx"|"actor"|"now">, documentId: string) {
  const doc=await ctx.tx.operationDocument.findUnique({where:{id:documentId}});
  if(!doc)throw new OperationError(404,"DOCUMENT_NOT_FOUND","Documento no encontrado");
  const caps=await capabilities(ctx.tx,ctx.actor);
  await requireDocumentScope(ctx.tx,ctx.actor,doc);
  if(doc.sensitivity==="clinical"){
    await requireCapability(ctx.tx,ctx.actor,"clinical.read");
  }else if(!caps.includes("documents.read")){
    const grant=await ctx.tx.documentAuthorization.findUnique({where:{documentId_userId:{documentId,userId:ctx.actor.id}}});
    const delivery=doc.deliveryId?await ctx.tx.deliveryAssignment.findUnique({where:{id:doc.deliveryId}}):null;
    if(!caps.includes("delivery.report")||!grant||grant.expiresAt<=ctx.now||delivery?.driverId!==ctx.actor.id||grant.deliveryId!==doc.deliveryId)
      throw new OperationError(403,"DOCUMENT_SCOPE","Documento fuera de tu autorización");
  }
  if(doc.validUntil&&doc.validUntil<new Intl.DateTimeFormat("en-CA",{timeZone:"America/Argentina/Buenos_Aires"}).format(ctx.now))throw new OperationError(403,"DOCUMENT_EXPIRED","Documento vencido");
  return doc;
}
