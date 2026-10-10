import type { RequestHandler } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "../db.js";
import { profileCapabilities, cutoverGateIds, cutoverProfiles, type Capability, type CutoverProfile } from "../../shared/operations/contracts.js";
import { canonicalJson } from "../../shared/operations/exact.js";
import { APPSHEET_CANONICAL_SOURCE_SYSTEM, APPSHEET_CANONICAL_MAPPING_ID, APPSHEET_CANONICAL_IMPORTER_VERSION, APPSHEET_CANONICAL_SCHEMA_VERSION, prepareAppSheetCaptureManifest } from "../../shared/operations/appsheet-canonical.js";
import { APPSHEET_HISTORY_MAPPING_ID, APPSHEET_HISTORY_SOURCE_SYSTEM, APPSHEET_HISTORY_IMPORTER_VERSION,
 appSheetHistoryStageHasBoundTechnicalReview } from "../../shared/operations/appsheet-history.js";
import { appSheetDefinitionInventorySchema } from "../../shared/operations/appsheet-definition.js";
import { APPSHEET_EXPECTED_LIVE_APP_ID, appSheetAppliedDefinitionHash, appSheetCanonicalCurrentDestinationHash } from "./appsheet-canonical.js";
import { appSheetDatabaseDestinationIdentity } from "./appsheet-database-target.js";
import { requireReviewedAppSheetPendingImport } from "./appsheet-pending-import.js";
import { legacyPayloadHash } from "./legacy-upload-contract.js";
import { registerCommand, OperationError, json, audit, capabilities, requireCapability, requireCanonicalAppSheetReplacementProfile, objectId, evidence, civilDate, requireMemberScope, requireDocumentScope, objectScope, type CommandContext, type Tx } from "./core.js";
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
 const bodySheetCount=sheets.filter(sheet=>sheet!.bodyExcluded!==true).length;
 const stableCounts=["firstPassPages","verifiedPages","matchedPages"] as const;
 if(stability.stable!==true||stability.cutoverEligible!==true||stability.metadataStable!==true||stability.headersStable!==true||stability.pageHashesStable!==true||stability.scanComplete!==true||
    stability.changedPages!==0||stability.failedPages!==0||stability.missingPages!==0||stability.unresolvedFormulaCount!==0||stability.sourceWriteDetected!==false||
    stableCounts.some(key=>typeof stability[key]!=="number"||stability[key]!==capture.dataPageCount)||
    capture.dataSheetCount!==bodySheetCount||capture.dataPageCount!==pages.length||capture.dataPageCount===0||capture.dataUnresolvedFormulaCount!==0||
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
 if(sheets.some(sheet=>(pageCounts.get(sheet!.sheetId as number)??0)!==sheet!.pageCount))throw appSheetReadinessError("capture_page_coverage_mismatch");
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
 if(input.manualPauseEndedAt!==null&&input.manualPauseEndedAt!==undefined)
  throw appSheetReadinessError("final_delta_manual_pause_ended");
 const stability=asJsonObject(capture.stability),pauseStartedAt=Date.parse(input.manualPauseStartedAt);
 const firstReadAt=capture.firstReadAt.getTime(),verificationStartedAt=capture.verificationStartedAt.getTime();
 const verificationCompletedAt=capture.verificationCompletedAt.getTime(),cutoffAt=capture.cutoffAt.getTime();
 if(!stability||stability.stable!==true||stability.cutoverEligible!==true||stability.metadataStable!==true||stability.headersStable!==true||
    stability.pageHashesStable!==true||stability.scanComplete!==true||stability.changedPages!==0||stability.failedPages!==0||
    stability.unresolvedFormulaCount!==0||stability.sourceWriteDetected!==false||
    ![pauseStartedAt,firstReadAt,verificationStartedAt,verificationCompletedAt,cutoffAt].every(Number.isFinite)||
    pauseStartedAt>Date.now()+60_000||pauseStartedAt>firstReadAt||firstReadAt>verificationStartedAt||
    verificationStartedAt>verificationCompletedAt||verificationCompletedAt>cutoffAt||
    [firstReadAt,verificationStartedAt,verificationCompletedAt,cutoffAt].some(value=>value<pauseStartedAt)||
    input.manualPauseEvidenceRef.trim().toLowerCase()===input.expectedHandoffChangesRef.trim().toLowerCase())
  throw appSheetReadinessError("final_delta_pause_or_fresh_capture_evidence_invalid");
 return {
  schemaVersion:1,
  manualPauseStartedAt:new Date(pauseStartedAt).toISOString(),
  manualPauseEndedAt:null,
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
 const effectFlags=["stock","cash","orders","deliveries","messaging","priceApproval"] as const;
 if(!effects||Object.keys(effects).length!==effectFlags.length||!effectFlags.every(flag=>effects[flag]===false)||
    !stageContext||stageContext.target!=="production"||!backup||typeof backup.manifestHash!=="string"||!hashPattern.test(backup.manifestHash)||
    typeof backup.snapshotAt!=="string"||!Number.isFinite(Date.parse(backup.snapshotAt))||
    typeof stageContext.destinationIdentity!=="string"||!/^appsheet-db-v1:[a-f0-9]{64}$/.test(stageContext.destinationIdentity))
  throw appSheetReadinessError("canonical_master_effects_or_production_backup_unverified");
 let runtimeDestinationIdentity:string|null=null;
 try{if(process.env.DATABASE_URL)runtimeDestinationIdentity=appSheetDatabaseDestinationIdentity("production",new URL(process.env.DATABASE_URL));}catch{}
 if(!runtimeDestinationIdentity||stageContext.destinationIdentity!==runtimeDestinationIdentity)
  throw appSheetReadinessError("canonical_master_database_target_mismatch");
 const review=asJsonObject(projection.technicalReview);
 if(!review||review.reviewKind!=="independent-technical"||review.approved!==true||review.projectionHash!==projection.projectionHash||
    review.captureId!==capture.captureId||review.manifestHash!==capture.manifestHash||review.definitionHash!==appliedHash||
    review.target!==stageContext.target||review.destinationIdentity!==stageContext.destinationIdentity||
    review.importer!==APPSHEET_CANONICAL_IMPORTER_VERSION||typeof review.reviewer!=="string"||!review.reviewer.trim()||review.reviewer===snapshot.createdBy||
    typeof review.reviewedAt!=="string"||!Number.isFinite(Date.parse(review.reviewedAt))||Date.parse(review.reviewedAt)>Date.now()+60_000||
    !Number.isSafeInteger(review.findingsCount)||review.findingsCount!==0||typeof review.commitSha!=="string"||! /^[a-f0-9]{40}$/.test(review.commitSha)||
    sameHumanIdentity(review.reviewer,snapshot.createdBy))
  throw appSheetReadinessError("canonical_master_technical_review_unbound");
 const reviewHash=hashJson({reviewKind:review.reviewKind,approved:review.approved,projectionHash:review.projectionHash,captureId:review.captureId,
  manifestHash:review.manifestHash,definitionHash:review.definitionHash,importer:review.importer,reviewer:review.reviewer,reviewedAt:review.reviewedAt,
  findingsCount:review.findingsCount,commitSha:review.commitSha,target:review.target,destinationIdentity:review.destinationIdentity});
 return {projection,coverageProjection,inventory,appliedHash,reviewHash,commitSha:review.commitSha,reviewer:String(review.reviewer),reviewedAt:String(review.reviewedAt),
  projectionHash:String(projection.projectionHash),destinationIdentity:String(stageContext.destinationIdentity),backupManifestHash:String(backup.manifestHash),backupSnapshotAt:String(backup.snapshotAt)};
}

async function requireProjectionAudit(ctx:CommandContext,snapshotId:string,action:string){
 const rows=await ctx.tx.operationAudit.findMany({where:{objectId:snapshotId,action},select:{actorId:true,details:true},take:2});
 if(rows.length!==1)throw appSheetReadinessError("projection_stage_audit_missing_or_ambiguous",{snapshotId,action});
 const details=asJsonObject(rows[0]!.details);
 if(!details)throw appSheetReadinessError("projection_stage_audit_invalid",{snapshotId,action});
 return {actorId:rows[0]!.actorId,details};
}

const canonicalIdentityReviewedAction="appsheet.canonical_identity_reviewed";
const canonicalIdentitiesReviewedAction="appsheet.canonical_identities_reviewed";

type CanonicalIdentityAuditBinding={
 id:string;sourceTable:string;sourceKey:string;destinationType:string;destinationId:string;approvedBy:string|null;
};
type CanonicalIdentityAuditSource={id:string;contentHash:string};
type CanonicalIdentityAuditFingerprint={sourceTable:string;sourceKey:string;destinationType:string;destinationId:string;dataHash:string;operationVersion?:number};

/** Prove that identity approvals belong to this snapshot review, not a reused legacy approval or another capture. */
async function hasCanonicalIdentityReviewAudits(tx:Tx,input:{snapshotId:string;reviewerId:string;reviewedAt:Date;captureId:string;manifestHash:string;
 projectionHash:string;destinationIdentity:string;expectedIdentityCount:number;identities:CanonicalIdentityAuditBinding[];
 recordsByKey:Map<string,CanonicalIdentityAuditSource>;fingerprintsByKey:Map<string,CanonicalIdentityAuditFingerprint>}):Promise<boolean>{
 const [snapshotAudits,identityAudits]=await Promise.all([
  tx.operationAudit.findMany({where:{objectId:input.snapshotId,action:canonicalIdentitiesReviewedAction},
   select:{actorId:true,requestId:true,details:true,createdAt:true},take:2}),
  input.identities.length?tx.operationAudit.findMany({where:{objectId:{in:input.identities.map(identity=>identity.id)},action:canonicalIdentityReviewedAction},
   select:{actorId:true,objectId:true,requestId:true,details:true,createdAt:true}}):Promise.resolve([]),
 ]);
 if(snapshotAudits.length!==1)return false;
 const snapshotAudit=snapshotAudits[0]!,snapshotDetails=asJsonObject(snapshotAudit.details);
 if(snapshotAudit.actorId!==input.reviewerId||!snapshotAudit.requestId||snapshotAudit.createdAt<input.reviewedAt||!snapshotDetails||
   snapshotDetails.schemaVersion!==1||snapshotDetails.snapshotId!==input.snapshotId||snapshotDetails.captureId!==input.captureId||
   snapshotDetails.manifestHash!==input.manifestHash||snapshotDetails.projectionHash!==input.projectionHash||
   snapshotDetails.destinationIdentity!==input.destinationIdentity||snapshotDetails.identityCount!==input.expectedIdentityCount||
   snapshotDetails.expectedIdentityCount!==input.expectedIdentityCount)return false;
 const byIdentity=new Map<string,typeof identityAudits>();
 for(const auditRow of identityAudits){const rows=byIdentity.get(auditRow.objectId)??[];rows.push(auditRow);byIdentity.set(auditRow.objectId,rows);}
 for(const identity of input.identities){
  const record=input.recordsByKey.get(canonicalJson([identity.sourceTable,identity.sourceKey]));
  const fingerprint=input.fingerprintsByKey.get(canonicalJson([identity.sourceTable,identity.sourceKey]));
  // approvedBy is a mutable, identity-wide pointer to the latest explicit approval.
  // A different capture can be reviewed later by another checker, so this pointer
  // must not replace (or invalidate) the capture-bound audit below. Null remains an
  // explicit revocation and therefore fails closed.
  if(!record||!fingerprint||identity.approvedBy===null)return false;
  const matching=(byIdentity.get(identity.id)??[]).filter(row=>{
   const details=asJsonObject(row.details);
  return row.actorId===input.reviewerId&&row.requestId===snapshotAudit.requestId&&row.createdAt>=input.reviewedAt&&details?.schemaVersion===1&&
    details.identityId===identity.id&&details.snapshotId===input.snapshotId&&details.captureId===input.captureId&&
    details.manifestHash===input.manifestHash&&details.projectionHash===input.projectionHash&&details.destinationIdentity===input.destinationIdentity&&
    details.sourceRecordId===record.id&&details.sourceTable===identity.sourceTable&&details.sourceKey===identity.sourceKey&&
    details.sourceContentHash===record.contentHash&&details.destinationType===identity.destinationType&&details.destinationId===identity.destinationId&&
    details.destinationDataHash===fingerprint.dataHash&&details.approvedBy===input.reviewerId;
  });
  if(matching.length!==1)return false;
 }
 return true;
}

const canonicalIdentityReviewSchema=z.strictObject({
 captureId:z.string().regex(/^appsreal-[a-f0-9]{16}$/),manifestHash:z.string().regex(/^[a-f0-9]{64}$/),
 projectionHash:z.string().regex(/^[a-f0-9]{64}$/),destinationCount:z.number().int().min(1).max(100_000),
 evidenceReference:z.string().trim().min(3).max(500),
});
type CanonicalIdentityReviewInput=z.infer<typeof canonicalIdentityReviewSchema>;
function productionAppSheetDestinationIdentity():string|null{
 try{return process.env.DATABASE_URL?appSheetDatabaseDestinationIdentity("production",new URL(process.env.DATABASE_URL)):null;}catch{return null;}
}
type CanonicalReviewIdentity={id:string;sourceSystem:string;sourceTable:string;sourceKey:string;destinationType:string;destinationId:string;approvedBy:string|null};
type CanonicalReviewRecord={id:string;sourceTable:string;sourceKey:string;sourceRow:number;fileHash:string;contentHash:string;importerVersion:string;treatment:string};
type CanonicalIdentityReviewPlan={snapshot:{id:string;sourceSystem:string;fileHash:string;importerVersion:string;status:string;createdBy:string;reviewedBy:string|null;reviewedAt:Date|null;
 controls:unknown;coverage:unknown;captureManifestId:string|null};capture:Awaited<ReturnType<typeof requireStableAppSheetCapture>>;
 definition:ReturnType<typeof requireDefinitionEvidence>;records:CanonicalReviewRecord[];identities:CanonicalReviewIdentity[];
 fingerprints:Map<string,{destinationType:string;sourceTable:string;sourceKey:string;destinationId:string;dataHash:string;operationVersion:number}>};

/** Build the complete approval plan from the exact stable snapshot; no partial identity set can be approved. */
async function prepareCanonicalIdentityReview(ctx:CommandContext,input:CanonicalIdentityReviewInput):Promise<CanonicalIdentityReviewPlan>{
 const snapshot=await ctx.tx.legacyImportSnapshot.findUnique({where:{id:ctx.envelope.targetId},select:{id:true,sourceSystem:true,fileHash:true,importerVersion:true,status:true,createdBy:true,
  reviewedBy:true,reviewedAt:true,controls:true,coverage:true,captureManifestId:true}});
 if(!snapshot||snapshot.sourceSystem!==APPSHEET_CANONICAL_SOURCE_SYSTEM||snapshot.importerVersion!==APPSHEET_CANONICAL_IMPORTER_VERSION||
   snapshot.fileHash!==input.manifestHash||snapshot.captureManifestId!==input.captureId||snapshot.status!=="staged"||snapshot.reviewedBy!==null||snapshot.reviewedAt!==null)
  throw appSheetReadinessError("canonical_identity_review_snapshot_not_pending");
 if(snapshot.createdBy===ctx.actor.id)throw new OperationError(403,"INDEPENDENT_IDENTITY_REVIEW_REQUIRED","Quien preparó los maestros no puede aprobar sus identidades.");
 const capture=await requireStableAppSheetCapture(ctx.tx,input.captureId);
 if(capture.manifestHash!==snapshot.fileHash)throw appSheetReadinessError("canonical_identity_review_capture_mismatch");
 const definition=requireDefinitionEvidence(snapshot,capture),runtimeDestinationIdentity=productionAppSheetDestinationIdentity();
 if(!runtimeDestinationIdentity||definition.destinationIdentity!==runtimeDestinationIdentity)
  throw appSheetReadinessError("canonical_identity_review_database_target_mismatch");
 if(definition.projectionHash!==input.projectionHash)throw appSheetReadinessError("canonical_identity_review_projection_mismatch");

 const records=await ctx.tx.legacySourceRecord.findMany({where:{snapshotId:snapshot.id},orderBy:[{sourceTable:"asc"},{sourceRow:"asc"}],
  select:{id:true,sourceTable:true,sourceKey:true,sourceRow:true,fileHash:true,contentHash:true,importerVersion:true,treatment:true}});
 if(!records.length||records.length!==input.destinationCount||records.some(record=>!["C_Cliente","D_Catalogo_Mercaderia"].includes(record.sourceTable)||
   !record.sourceKey||record.fileHash!==snapshot.fileHash||record.importerVersion!==snapshot.importerVersion||record.treatment!=="fact_candidate"))
  throw appSheetReadinessError("canonical_identity_review_source_records_invalid");
 const sourceKeys=new Set<string>();
 for(const record of records){const key=canonicalJson([record.sourceTable,record.sourceKey]);if(sourceKeys.has(key))throw appSheetReadinessError("canonical_identity_review_duplicate_source_key");sourceKeys.add(key);}
 const openExceptions=await ctx.tx.legacyException.count({where:{snapshotId:snapshot.id,status:"open"}});
 if(openExceptions!==0)throw appSheetReadinessError("canonical_identity_review_exceptions_unresolved",{count:openExceptions});
 const declaredTables=Array.isArray(definition.coverageProjection.tables)?definition.coverageProjection.tables.map(asJsonObject):null;
 if(!declaredTables||declaredTables.some(table=>!table))throw appSheetReadinessError("canonical_identity_review_coverage_missing");
 for(const sourceTable of ["C_Cliente","D_Catalogo_Mercaderia"]){
  const declared=declaredTables.find(table=>table!.sourceTable===sourceTable),actual=records.filter(record=>record.sourceTable===sourceTable).length;
  if(!declared||declared!.sourceRecordCount!==actual||declared!.canonicalTargetCount!==actual||declared!.blockingExceptionCount!==0||declared!.reviewExceptionCount!==0)
   throw appSheetReadinessError("canonical_identity_review_table_coverage_invalid",{sourceTable});
 }
 const projection=asJsonObject(asJsonObject(snapshot.controls)?.appSheetCanonical),rawFingerprints=projection&&Array.isArray(projection.destinationFingerprints)?projection.destinationFingerprints.map(asJsonObject):null;
 if(!projection||!rawFingerprints||rawFingerprints.length!==records.length||rawFingerprints.some(row=>!row))
  throw appSheetReadinessError("canonical_identity_review_destination_fingerprints_missing");
 const fingerprints=new Map<string,{destinationType:string;sourceTable:string;sourceKey:string;destinationId:string;dataHash:string;operationVersion:number}>();
 for(const raw of rawFingerprints){
  const row=raw!;
  if(!["member","sku"].includes(String(row.destinationType))||!["C_Cliente","D_Catalogo_Mercaderia"].includes(String(row.sourceTable))||
    typeof row.sourceKey!=="string"||typeof row.destinationId!=="string"||typeof row.dataHash!=="string"||!hashPattern.test(row.dataHash)||
    typeof row.operationVersion!=="number"||!Number.isSafeInteger(row.operationVersion)||row.operationVersion<0)
   throw appSheetReadinessError("canonical_identity_review_destination_fingerprint_invalid");
  const expectedType=row.sourceTable==="C_Cliente"?"member":"sku",key=canonicalJson([row.sourceTable,row.sourceKey]);
  if(row.destinationType!==expectedType||fingerprints.has(key))throw appSheetReadinessError("canonical_identity_review_destination_fingerprint_ambiguous");
  fingerprints.set(key,row as {destinationType:string;sourceTable:string;sourceKey:string;destinationId:string;dataHash:string;operationVersion:number});
 }
 const keysByTable=new Map<string,string[]>();
 for(const record of records){const rows=keysByTable.get(record.sourceTable)??[];rows.push(record.sourceKey);keysByTable.set(record.sourceTable,rows);}
 const identities:CanonicalReviewIdentity[]=[];
 for(const [sourceTable,keys] of keysByTable){
  const destinationType=sourceTable==="C_Cliente"?"member":"sku";
  for(let start=0;start<keys.length;start+=500)identities.push(...await ctx.tx.legacyIdentity.findMany({where:{sourceSystem:APPSHEET_CANONICAL_SOURCE_SYSTEM,
   sourceTable,sourceKey:{in:keys.slice(start,start+500)},destinationType},select:{id:true,sourceSystem:true,sourceTable:true,sourceKey:true,destinationType:true,destinationId:true,approvedBy:true}}));
 }
 if(identities.length!==records.length||new Set(identities.map(identity=>canonicalJson([identity.sourceTable,identity.sourceKey,identity.destinationType]))).size!==records.length)
  throw appSheetReadinessError("canonical_identity_review_identity_coverage_invalid");
 const recordByKey=new Map(records.map(record=>[canonicalJson([record.sourceTable,record.sourceKey]),record]));
 const memberIdentities=identities.filter(identity=>identity.destinationType==="member"),skuIdentities=identities.filter(identity=>identity.destinationType==="sku");
 const destinationIds=[...new Set(identities.map(identity=>identity.destinationId))];
 if(destinationIds.length!==identities.length)throw appSheetReadinessError("canonical_identity_review_destination_reused");
 const [members,skus,objects]=await Promise.all([
  memberIdentities.length?ctx.tx.operationMember.findMany({where:{id:{in:memberIdentities.map(identity=>identity.destinationId)}},
   select:{id:true,legacyCustomerId:true,sourceSystem:true,sourceId:true,name:true,email:true,phone:true,address:true,preferences:true}}):Promise.resolve([]),
  skuIdentities.length?ctx.tx.catalogSku.findMany({where:{id:{in:skuIdentities.map(identity=>identity.destinationId)}},
   select:{id:true,code:true,name:true,variety:true,category:true,unit:true,active:true,sourceSystem:true,sourceId:true,appSheet:true}}):Promise.resolve([]),
  ctx.tx.operationObject.findMany({where:{id:{in:destinationIds}},select:{id:true,kind:true,version:true}}),
 ]);
 const memberById=new Map(members.map(member=>[member.id,member])),skuById=new Map(skus.map(sku=>[sku.id,sku])),objectById=new Map(objects.map(object=>[object.id,object]));
 for(const identity of identities){
  const key=canonicalJson([identity.sourceTable,identity.sourceKey]),record=recordByKey.get(key),fingerprint=fingerprints.get(key),object=objectById.get(identity.destinationId);
  if(!record||!fingerprint||fingerprint.destinationId!==identity.destinationId||!object||object.kind!==identity.destinationType||object.version!==fingerprint.operationVersion)
   throw appSheetReadinessError("canonical_identity_review_destination_version_or_lineage_mismatch");
  const current=identity.destinationType==="member"?memberById.get(identity.destinationId):skuById.get(identity.destinationId);
  const lineageMatches=identity.destinationType==="member"
   ?Boolean(current&&"legacyCustomerId" in current&&current.legacyCustomerId===identity.sourceKey&&current.sourceSystem===APPSHEET_CANONICAL_SOURCE_SYSTEM&&current.sourceId===identity.sourceKey)
   :Boolean(current&&"active" in current&&current.sourceSystem===APPSHEET_CANONICAL_SOURCE_SYSTEM&&current.sourceId===identity.sourceKey);
  if(!current||!lineageMatches||appSheetCanonicalCurrentDestinationHash(current,identity.destinationType as "member"|"sku")!==fingerprint.dataHash)
   throw appSheetReadinessError("canonical_identity_review_destination_changed");
 }
 const stageAudit=await requireProjectionAudit(ctx,snapshot.id,"appsheet.canonical_masters_staged"),stageDetails=stageAudit.details;
 if(stageAudit.actorId!==snapshot.createdBy||stageDetails.captureId!==capture.captureId||stageDetails.manifestHash!==capture.manifestHash||
   stageDetails.projectionHash!==definition.projectionHash||stageDetails.destinationIdentity!==definition.destinationIdentity||stageDetails.target!=="production"||
   stageDetails.importerVersion!==APPSHEET_CANONICAL_IMPORTER_VERSION||stageDetails.recordCount!==records.length||stageDetails.destinationCount!==records.length||stageDetails.exceptionCount!==0)
  throw appSheetReadinessError("canonical_identity_review_stage_audit_mismatch");
 if(input.captureId!==capture.captureId||input.manifestHash!==capture.manifestHash||input.projectionHash!==definition.projectionHash||input.destinationCount!==identities.length)
  throw appSheetReadinessError("canonical_identity_review_request_binding_mismatch");
 return {snapshot,capture,definition,records,identities,fingerprints};
}

const canonicalMemberMutationCommands=["MemberUpdated","PermissionVerified","ClinicalRecordReviewed"] as const;
function isServerDate(value:Date){return value instanceof Date&&Number.isFinite(value.getTime());}
function responseDateIsFinite(value:unknown){
 if(typeof value!=="string")return false;
 const date=new Date(value);
 return Number.isFinite(date.getTime());
}

type CanonicalMemberMutationCandidate={member:{id:string;legacyCustomerId:string|null;sourceSystem:string|null;sourceId:string|null;
 name:string;email:string;phone:string;address:unknown;preferences:unknown};baselineVersion:number;currentVersion:number;baselineHash:string;currentHash:string};

/** Accept only contiguous, server-receipted member-safe commands after identity approval. */
async function canonicalMemberMutationChainIds(tx:Tx,candidates:CanonicalMemberMutationCandidate[]):Promise<Set<string>>{
 const eligible=new Set<string>(),validCandidates=candidates.filter(candidate=>Number.isSafeInteger(candidate.baselineVersion)&&candidate.baselineVersion>=0&&
  Number.isSafeInteger(candidate.currentVersion)&&candidate.currentVersion>=candidate.baselineVersion);
 if(!validCandidates.length)return eligible;
 const lowestBaseline=Math.min(...validCandidates.map(candidate=>candidate.baselineVersion));
 const receipts=await tx.commandReceipt.findMany({where:{targetId:{in:validCandidates.map(candidate=>candidate.member.id)},
  resultingVersion:{gt:lowestBaseline}},orderBy:[{targetId:"asc"},{resultingVersion:"asc"}],
  select:{requestId:true,actorId:true,targetId:true,command:true,response:true,resultingVersion:true,committedAt:true}});
 const receiptsRequiringAudit=receipts.filter(receipt=>canonicalMemberMutationCommands.includes(receipt.command as typeof canonicalMemberMutationCommands[number]));
 const audits=receiptsRequiringAudit.length?await tx.operationAudit.findMany({where:{objectId:{in:[...new Set(receiptsRequiringAudit.map(receipt=>receipt.targetId))]},
  action:{in:[...canonicalMemberMutationCommands]},requestId:{in:receiptsRequiringAudit.map(receipt=>receipt.requestId)}},
  select:{actorId:true,action:true,objectId:true,requestId:true,details:true,createdAt:true}}):[];
 const receiptsByMember=new Map<string,typeof receipts>(),auditsByRequest=new Map<string,typeof audits>();
 for(const receipt of receipts){const rows=receiptsByMember.get(receipt.targetId)??[];rows.push(receipt);receiptsByMember.set(receipt.targetId,rows);}
 for(const row of audits){const key=`${row.objectId}\0${row.requestId??""}\0${row.action}`,rows=auditsByRequest.get(key)??[];rows.push(row);auditsByRequest.set(key,rows);}
 for(const candidate of validCandidates){
  const {member,baselineVersion,currentVersion,baselineHash,currentHash}=candidate;
  const rows=(receiptsByMember.get(member.id)??[]).filter(receipt=>receipt.resultingVersion>baselineVersion);
  if(rows.length!==currentVersion-baselineVersion||rows.some(receipt=>!canonicalMemberMutationCommands.includes(receipt.command as typeof canonicalMemberMutationCommands[number])))continue;
  if(!rows.length){if(currentHash===baselineHash)eligible.add(member.id);continue;}
  let expectedVersion=baselineVersion+1,latestMemberHash=baselineHash,valid=true;
  for(const receipt of rows){
   // Identity review revalidated the destination at baselineVersion; a contiguous
   // post-baseline server receipt chain proves causality. Database timestamps use
   // transaction start and are validated for shape, not used as a wall-clock order.
   if(receipt.resultingVersion!==expectedVersion++||receipt.resultingVersion>currentVersion||
      !canonicalMemberMutationCommands.includes(receipt.command as typeof canonicalMemberMutationCommands[number])||
      receipt.targetId!==member.id||!isServerDate(receipt.committedAt)){valid=false;break;}
   const matchingAudits=auditsByRequest.get(`${member.id}\0${receipt.requestId}\0${receipt.command}`)??[];
   if(matchingAudits.length!==1){valid=false;break;}
   const auditRow=matchingAudits[0]!,details=asJsonObject(auditRow.details),response=asJsonObject(receipt.response);
   if(auditRow.actorId!==receipt.actorId||auditRow.objectId!==member.id||auditRow.requestId!==receipt.requestId||
      !isServerDate(auditRow.createdAt)||!details||details.version!==receipt.resultingVersion||!response||
      response.requestId!==receipt.requestId||response.targetId!==member.id||response.version!==receipt.resultingVersion){valid=false;break;}
   const result=asJsonObject(response.result);
   if(!result){valid=false;break;}
   if(receipt.command==="MemberUpdated"){
    const updatedMember=asJsonObject(result.member);
    if(!updatedMember||updatedMember.id!==member.id||updatedMember.legacyCustomerId!==member.legacyCustomerId||
       updatedMember.sourceSystem!==member.sourceSystem||updatedMember.sourceId!==member.sourceId){valid=false;break;}
    const updatedHash=appSheetCanonicalCurrentDestinationHash(updatedMember,"member");
    if(!hashPattern.test(updatedHash)){valid=false;break;}
    latestMemberHash=updatedHash;
   }else if(receipt.command==="PermissionVerified"){
    const permission=asJsonObject(result.permission);
    if(!permission||permission.memberId!==member.id||permission.status!=="verified"||permission.reviewerId!==receipt.actorId||
       !responseDateIsFinite(permission.reviewedAt)){valid=false;break;}
   }else{
    const clinical=asJsonObject(result.clinical);
    if(!clinical||clinical.memberId!==member.id||!["verified","rejected","needs_information"].includes(String(clinical.verification))||
       clinical.reviewedBy!==receipt.actorId||!responseDateIsFinite(clinical.reviewedAt)){valid=false;break;}
   }
  }
  if(valid&&expectedVersion===currentVersion+1&&currentHash===latestMemberHash)eligible.add(member.id);
 }
 return eligible;
}

/** Return only canonical members reviewed for this exact production capture and still matching their staged fingerprint. */
export async function eligibleAppSheetCanonicalMemberIds(tx:Tx,captureId:string|null,onlyMemberIds?:string[]):Promise<Set<string>>{
 if(!captureId||onlyMemberIds?.length===0)return new Set();
 let capture:Awaited<ReturnType<typeof requireStableAppSheetCapture>>;
 try{capture=await requireStableAppSheetCapture(tx,captureId);}catch(error){
  if(error instanceof OperationError&&error.code==="APPSHEET_REPLACEMENT_NOT_READY")return new Set();
  throw error;
 }
 const destinationIdentity=productionAppSheetDestinationIdentity();
 if(!destinationIdentity)return new Set();
 const snapshots=await tx.legacyImportSnapshot.findMany({where:{sourceSystem:APPSHEET_CANONICAL_SOURCE_SYSTEM,captureManifestId:capture.captureId,
  fileHash:capture.manifestHash,importerVersion:APPSHEET_CANONICAL_IMPORTER_VERSION},select:{id:true,status:true,createdBy:true,reviewedBy:true,reviewedAt:true,
  controls:true,coverage:true,fileHash:true,sourceSystem:true,importerVersion:true}});
 if(snapshots.length!==1)return new Set();
 const snapshot=snapshots[0]!,controls=asJsonObject(snapshot.controls),projection=controls&&asJsonObject(controls.appSheetCanonical);
 const stageContext=projection&&asJsonObject(projection.stageContext),projectionHash=typeof projection?.projectionHash==="string"?projection.projectionHash:"";
 if(snapshot.status!=="reviewed"||!snapshot.reviewedBy||snapshot.reviewedBy===snapshot.createdBy||!snapshot.reviewedAt||
   snapshot.fileHash!==capture.manifestHash||snapshot.sourceSystem!==APPSHEET_CANONICAL_SOURCE_SYSTEM||snapshot.importerVersion!==APPSHEET_CANONICAL_IMPORTER_VERSION||
   !stageContext||stageContext.target!=="production"||stageContext.destinationIdentity!==destinationIdentity||!hashPattern.test(projectionHash))return new Set();
 const [reviewer,snapshotReviews]=await Promise.all([
  tx.user.findUnique({where:{id:snapshot.reviewedBy},select:{active:true}}),
  tx.operationAudit.findMany({where:{objectId:snapshot.id,action:canonicalIdentitiesReviewedAction},select:{actorId:true,requestId:true,details:true,createdAt:true},take:2}),
 ]);
 if(!reviewer?.active||!snapshot.reviewedAt||snapshotReviews.length!==1||snapshotReviews[0]!.actorId!==snapshot.reviewedBy||
   !snapshotReviews[0]!.requestId||snapshotReviews[0]!.createdAt<snapshot.reviewedAt)return new Set();
 const snapshotReview=asJsonObject(snapshotReviews[0]!.details);
 if(!snapshotReview||snapshotReview.schemaVersion!==1||snapshotReview.snapshotId!==snapshot.id||snapshotReview.captureId!==capture.captureId||
   snapshotReview.manifestHash!==capture.manifestHash||snapshotReview.projectionHash!==projectionHash||snapshotReview.destinationIdentity!==destinationIdentity||
   typeof snapshotReview.identityCount!=="number"||snapshotReview.identityCount<1||snapshotReview.identityCount!==snapshotReview.expectedIdentityCount)return new Set();
 const members=await tx.operationMember.findMany({where:{sourceSystem:APPSHEET_CANONICAL_SOURCE_SYSTEM,...(onlyMemberIds?{id:{in:onlyMemberIds}}:{})},
  select:{id:true,legacyCustomerId:true,sourceSystem:true,sourceId:true,name:true,email:true,phone:true,address:true,preferences:true}});
 if(!members.length)return new Set();
 const sourceKeys=[...new Set(members.filter(member=>member.sourceId&&member.sourceId===member.legacyCustomerId).map(member=>member.sourceId!))];
 if(!sourceKeys.length)return new Set();
 const [records,identities]=await Promise.all([
  tx.legacySourceRecord.findMany({where:{snapshotId:snapshot.id,sourceTable:"C_Cliente",sourceKey:{in:sourceKeys}},
   select:{id:true,sourceTable:true,sourceKey:true,contentHash:true,fileHash:true,importerVersion:true,treatment:true}}),
  tx.legacyIdentity.findMany({where:{sourceSystem:APPSHEET_CANONICAL_SOURCE_SYSTEM,sourceTable:"C_Cliente",destinationType:"member",sourceKey:{in:sourceKeys}},
   select:{id:true,sourceSystem:true,sourceTable:true,sourceKey:true,destinationType:true,destinationId:true,approvedBy:true}}),
 ]);
 const recordByKey=new Map(records.map(record=>[record.sourceKey,record])),identityByKey=new Map(identities.map(identity=>[identity.sourceKey,identity]));
 const auditRows=identities.length?await tx.operationAudit.findMany({where:{objectId:{in:identities.map(identity=>identity.id)},action:canonicalIdentityReviewedAction},
  select:{actorId:true,objectId:true,requestId:true,details:true,createdAt:true}}):[];
 const auditByIdentity=new Map<string,typeof auditRows>();
 for(const auditRow of auditRows){const rows=auditByIdentity.get(auditRow.objectId)??[];rows.push(auditRow);auditByIdentity.set(auditRow.objectId,rows);}
 const memberIds=members.map(member=>member.id);
 const objects=await tx.operationObject.findMany({where:{id:{in:memberIds}},select:{id:true,kind:true,version:true}});
 const objectById=new Map(objects.map(object=>[object.id,object]));
 const fingerprints=Array.isArray(projection.destinationFingerprints)?projection.destinationFingerprints.map(asJsonObject):[];
 const fingerprintByKey=new Map<string,Record<string,unknown>>();
 for(const fingerprint of fingerprints){
  if(!fingerprint||fingerprint.sourceTable!=="C_Cliente")continue;
  const key=String(fingerprint.sourceKey);
  if(fingerprintByKey.has(key))return new Set();
  fingerprintByKey.set(key,fingerprint);
 }
 const candidates:CanonicalMemberMutationCandidate[]=[];
 for(const member of members){
  if(!member.sourceId||member.sourceId!==member.legacyCustomerId)continue;
  const record=recordByKey.get(member.sourceId),identity=identityByKey.get(member.sourceId),fingerprint=fingerprintByKey.get(member.sourceId),object=objectById.get(member.id);
  const perIdentityAudit=identity?auditByIdentity.get(identity.id)??[]:[];
  if(!record||record.fileHash!==snapshot.fileHash||record.importerVersion!==snapshot.importerVersion||record.treatment!=="fact_candidate"||
   !identity||identity.destinationId!==member.id||identity.approvedBy===null||
    !fingerprint||fingerprint.destinationType!=="member"||fingerprint.destinationId!==member.id||typeof fingerprint.dataHash!=="string"||!hashPattern.test(fingerprint.dataHash)||
    typeof fingerprint.operationVersion!=="number"||!Number.isSafeInteger(fingerprint.operationVersion)||!object||object.kind!=="member"||
    object.version<fingerprint.operationVersion)continue;
  const identityAuditsForCapture=perIdentityAudit.filter(row=>{
   const details=asJsonObject(row.details);
  return row.actorId===snapshot.reviewedBy&&details?.approvedBy===snapshot.reviewedBy&&details.snapshotId===snapshot.id&&
    details.captureId===capture.captureId&&details.projectionHash===projectionHash&&
    details.destinationIdentity===destinationIdentity;
  });
  if(identityAuditsForCapture.length!==1)continue;
  const identityAudit=identityAuditsForCapture[0]!,details=asJsonObject(identityAudit.details);
  if(identityAudit.actorId!==snapshot.reviewedBy||identityAudit.requestId!==snapshotReviews[0]!.requestId||!identityAudit.createdAt||identityAudit.createdAt<snapshot.reviewedAt||
    !details||details.schemaVersion!==1||details.identityId!==identity.id||details.snapshotId!==snapshot.id||
    details.captureId!==capture.captureId||details.manifestHash!==capture.manifestHash||details.projectionHash!==projectionHash||
    details.destinationIdentity!==destinationIdentity||details.sourceRecordId!==record.id||details.sourceTable!==record.sourceTable||
    details.sourceKey!==record.sourceKey||details.sourceContentHash!==record.contentHash||details.destinationType!=="member"||details.destinationId!==member.id||
    details.destinationDataHash!==fingerprint.dataHash||details.approvedBy!==snapshot.reviewedBy)continue;
  const currentHash=appSheetCanonicalCurrentDestinationHash(member,"member");
  if(!hashPattern.test(currentHash))continue;
  candidates.push({member,baselineVersion:fingerprint.operationVersion,currentVersion:object.version,baselineHash:fingerprint.dataHash,currentHash});
 }
 return canonicalMemberMutationChainIds(tx,candidates);
}

/** null means no AppSheet replacement authority is active; an empty set means none of its imported members are eligible. */
export async function appSheetReplacementCanonicalMemberIds(tx:Tx,onlyMemberIds?:string[]):Promise<Set<string>|null>{
 const authority=await tx.operationAuthority.findUnique({where:{id:"operations"},select:{mode:true,cutoverProfile:true,captureManifestId:true}});
 if(authority?.mode!=="active"||authority.cutoverProfile!=="appsheet-replacement")return null;
 return eligibleAppSheetCanonicalMemberIds(tx,authority.captureManifestId,onlyMemberIds);
}

/** Keep native MemberCreated rows available while failing closed for unreviewed or mismatched imported provenance. */
export async function requireEligibleAppSheetReplacementMember(tx:Tx,memberId:string):Promise<void>{
 const member=await tx.operationMember.findUnique({where:{id:memberId},select:{id:true,sourceSystem:true,sourceId:true,legacyCustomerId:true}});
 if(!member)throw new OperationError(404,"MEMBER_NOT_FOUND","Socio no encontrado");
 const authority=await tx.operationAuthority.findUnique({where:{id:"operations"},select:{mode:true,cutoverProfile:true,captureManifestId:true}});
 if(authority?.mode!=="active"||authority.cutoverProfile!=="appsheet-replacement")return;
 // Native members do not depend on the state of the imported capture. Resolve
 // them before the canonical eligibility query loads capture, inventory, or
 // destination fingerprints. Any partial provenance remains fail-closed below.
 if(member.sourceSystem===null&&member.sourceId===null&&member.legacyCustomerId===null)return;
 const eligibleCanonicalIds=await eligibleAppSheetCanonicalMemberIds(tx,authority.captureManifestId,[memberId]);
 if(member.sourceSystem===APPSHEET_CANONICAL_SOURCE_SYSTEM&&eligibleCanonicalIds.has(member.id))return;
 throw new OperationError(423,"APPSHEET_MEMBER_NOT_ELIGIBLE","El socio importado no pertenece a la captura AppSheet revisada por la autoridad activa.",{memberId});
}

registerCommand("AppSheetCanonicalIdentitiesReviewed",{kind:"legacyImport",capability:"imports.review",administrative:true,
 schema:canonicalIdentityReviewSchema,execute:async ctx=>{
  await requireCapability(ctx.tx,ctx.actor,"imports.review");
  const input=canonicalIdentityReviewSchema.parse(ctx.envelope.data),plan=await prepareCanonicalIdentityReview(ctx,input);
  const reviewedAt=ctx.now;
  const idsByPreviousApprover=new Map<string|null,string[]>();
  for(const identity of plan.identities){const ids=idsByPreviousApprover.get(identity.approvedBy)??[];ids.push(identity.id);idsByPreviousApprover.set(identity.approvedBy,ids);}
  for(const [previousApprover,ids] of idsByPreviousApprover){
   const updated=await ctx.tx.legacyIdentity.updateMany({where:{id:{in:ids},approvedBy:previousApprover},data:{approvedBy:ctx.actor.id}});
   if(updated.count!==ids.length)throw appSheetReadinessError("canonical_identity_review_concurrent_change");
  }
  const snapshotUpdate=await ctx.tx.legacyImportSnapshot.updateMany({where:{id:plan.snapshot.id,sourceSystem:APPSHEET_CANONICAL_SOURCE_SYSTEM,
   fileHash:plan.capture.manifestHash,captureManifestId:plan.capture.captureId,status:"staged",reviewedBy:null,reviewedAt:null},
   data:{status:"reviewed",reviewedBy:ctx.actor.id,reviewedAt}});
  if(snapshotUpdate.count!==1)throw appSheetReadinessError("canonical_identity_review_snapshot_changed");
  const recordByKey=new Map(plan.records.map(record=>[canonicalJson([record.sourceTable,record.sourceKey]),record]));
  const identityAudits=plan.identities.map(identity=>{
   const key=canonicalJson([identity.sourceTable,identity.sourceKey]),record=recordByKey.get(key),fingerprint=plan.fingerprints.get(key);
   if(!record||!fingerprint)throw appSheetReadinessError("canonical_identity_review_audit_binding_missing");
   return {actorId:ctx.actor.id,action:canonicalIdentityReviewedAction,objectId:identity.id,requestId:ctx.envelope.requestId,createdAt:reviewedAt,
    details:json({schemaVersion:1,identityId:identity.id,snapshotId:plan.snapshot.id,captureId:plan.capture.captureId,manifestHash:plan.capture.manifestHash,
     projectionHash:plan.definition.projectionHash,destinationIdentity:plan.definition.destinationIdentity,sourceRecordId:record.id,sourceTable:record.sourceTable,
     sourceKey:record.sourceKey,sourceContentHash:record.contentHash,destinationType:identity.destinationType,destinationId:identity.destinationId,
     destinationDataHash:fingerprint.dataHash,approvedBy:ctx.actor.id})};
  });
  for(let start=0;start<identityAudits.length;start+=500)await ctx.tx.operationAudit.createMany({data:identityAudits.slice(start,start+500)});
  await ctx.tx.operationAudit.create({data:{actorId:ctx.actor.id,action:canonicalIdentitiesReviewedAction,objectId:plan.snapshot.id,requestId:ctx.envelope.requestId,
   createdAt:reviewedAt,details:json({schemaVersion:1,snapshotId:plan.snapshot.id,captureId:plan.capture.captureId,manifestHash:plan.capture.manifestHash,
    projectionHash:plan.definition.projectionHash,destinationIdentity:plan.definition.destinationIdentity,identityCount:plan.identities.length,
    expectedIdentityCount:plan.records.length,evidenceReference:input.evidenceReference.trim()})}});
  return {snapshotId:plan.snapshot.id,captureId:plan.capture.captureId,projectionHash:plan.definition.projectionHash,
   identitiesReviewed:plan.identities.length,status:"reviewed",operationalEffects:false};
 }});

/** Complete source-linked evidence gate. Missing publication/open-object/opening proof stays a hard blocker. */
type AppSheetReplacementProof={
 capture:{captureId:string;manifestHash:string;dataHash:string;definitionHash:string|null;firstReadAt:Date;verificationStartedAt:Date;
  verificationCompletedAt:Date;cutoffAt:Date;stability:unknown};
 appliedDefinitionHash:string;
 master:{id:string;fileHash:string;sourceRecords:number;projectionHash:string;destinationIdentity:string;commitSha:string;technicalReviewHash:string;backupManifestHash:string};
 skuActivationPlan:CanonicalSkuActivationPlan[];
 history:{id:string;fileHash:string;sourceRecords:number;facts:number;publicationFingerprint:string;projectionHash:string;commitSha:string;technicalReviewHash:string};
};
export type CanonicalSkuSnapshot={id:string;code:string;name:string;variety:string;category:string;unit:string;active:boolean;sourceSystem:string|null;sourceId:string|null;appSheet:unknown};
export type CanonicalSkuActivationPlan={skuId:string;sourceKey:string;baselineHash:string;baselineVersion:number;activatedHash:string;activatedVersion:number;snapshot:CanonicalSkuSnapshot};
export type CanonicalSkuActivationContext={capture:{captureId:string};master:{id:string;projectionHash:string;destinationIdentity:string};skuActivationPlan:CanonicalSkuActivationPlan[]};
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
 const identities=[] as Array<{id:string;sourceTable:string;sourceKey:string;destinationType:string;destinationId:string;approvedBy:string|null}>;
 for(const [sourceTable,rows] of recordsByTable){
  const sourceKeys=[...new Set(rows.map(record=>record.sourceKey))];
  for(let start=0;start<sourceKeys.length;start+=500){
   identities.push(...await ctx.tx.legacyIdentity.findMany({where:{sourceSystem:APPSHEET_CANONICAL_SOURCE_SYSTEM,sourceTable,sourceKey:{in:sourceKeys.slice(start,start+500)}},
    select:{id:true,sourceTable:true,sourceKey:true,destinationType:true,destinationId:true,approvedBy:true}}));
  }
 }
 const identityByKey=new Map(identities.map(identity=>[canonicalJson([identity.sourceTable,identity.sourceKey,identity.destinationType]),identity]));
 const expectedIdentityCount=masterRecords.length;
 if(identities.length!==expectedIdentityCount||identityByKey.size!==identities.length||identities.some(identity=>identity.approvedBy===null))
  throw appSheetReadinessError("canonical_master_identity_review_pending");
 const masterProjection=asJsonObject(asJsonObject(master.controls)?.appSheetCanonical);
 const rawFingerprints=masterProjection&&Array.isArray(masterProjection.destinationFingerprints)?masterProjection.destinationFingerprints.map(asJsonObject):null;
 if(!masterProjection||!rawFingerprints||rawFingerprints.length!==masterRecords.length||rawFingerprints.some(item=>!item))
  throw appSheetReadinessError("canonical_master_identity_review_fingerprints_missing");
 const fingerprintByKey=new Map<string,CanonicalIdentityAuditFingerprint>();
 for(const raw of rawFingerprints){
  const fingerprint=raw!;
  if(typeof fingerprint.sourceTable!=="string"||typeof fingerprint.sourceKey!=="string"||typeof fingerprint.destinationType!=="string"||
     typeof fingerprint.destinationId!=="string"||typeof fingerprint.dataHash!=="string"||!hashPattern.test(fingerprint.dataHash)||
     typeof fingerprint.operationVersion!=="number"||!Number.isSafeInteger(fingerprint.operationVersion)||fingerprint.operationVersion<0)
   throw appSheetReadinessError("canonical_master_identity_review_fingerprint_invalid");
  const key=canonicalJson([fingerprint.sourceTable,fingerprint.sourceKey]);
  if(fingerprintByKey.has(key))throw appSheetReadinessError("canonical_master_identity_review_fingerprint_ambiguous");
  fingerprintByKey.set(key,{sourceTable:fingerprint.sourceTable,sourceKey:fingerprint.sourceKey,destinationType:fingerprint.destinationType,
   destinationId:fingerprint.destinationId,dataHash:fingerprint.dataHash,operationVersion:fingerprint.operationVersion});
 }
 const recordsByKey=new Map(masterRecords.map(record=>[canonicalJson([record.sourceTable,record.sourceKey]),{id:record.id,contentHash:record.contentHash}]));
 if(recordsByKey.size!==masterRecords.length||fingerprintByKey.size!==masterRecords.length||!master.reviewedAt||
   !await hasCanonicalIdentityReviewAudits(ctx.tx,{snapshotId:master.id,reviewerId:master.reviewedBy!,reviewedAt:master.reviewedAt,
    captureId:capture.captureId,manifestHash:capture.manifestHash,projectionHash:definition.projectionHash,destinationIdentity:definition.destinationIdentity,
    expectedIdentityCount,identities,recordsByKey,fingerprintsByKey:fingerprintByKey}))
  throw appSheetReadinessError("canonical_master_identity_review_audit_missing_or_unbound");
const membersById=new Map<string,{id:string;legacyCustomerId:string|null;sourceSystem:string|null;sourceId:string|null;name:string;email:string;phone:string;address:unknown;preferences:unknown}>();
 const skusById=new Map<string,CanonicalSkuSnapshot>();
 const objectsById=new Map<string,{id:string;kind:string;version:number}>();
 const skuActivationPlan:CanonicalSkuActivationPlan[]=[];
 const allDestinationIds=[...new Set(identities.map(identity=>identity.destinationId))];
 for(let start=0;start<allDestinationIds.length;start+=500){
  const ids=allDestinationIds.slice(start,start+500);
  const [members,skus,objects]=await Promise.all([
   ctx.tx.operationMember.findMany({where:{id:{in:ids}},select:{id:true,legacyCustomerId:true,sourceSystem:true,sourceId:true,name:true,email:true,phone:true,address:true,preferences:true}}),
   ctx.tx.catalogSku.findMany({where:{id:{in:ids}},select:{id:true,code:true,name:true,variety:true,category:true,unit:true,active:true,sourceSystem:true,sourceId:true,appSheet:true}}),
   ctx.tx.operationObject.findMany({where:{id:{in:ids}},select:{id:true,kind:true,version:true}}),
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
     sku.sourceId===record.sourceKey);})();
  const object=objectsById.get(identity.destinationId);
  if(!destinationMatches||!object||object.kind!==destinationType)throw appSheetReadinessError("canonical_master_destination_missing");
  const fingerprint=fingerprintByKey.get(canonicalJson([record.sourceTable,record.sourceKey]));
  const current=destinationType==="member"?membersById.get(identity.destinationId):skusById.get(identity.destinationId);
  if(!fingerprint||fingerprint.destinationId!==identity.destinationId||fingerprint.operationVersion===undefined||
     object.version!==fingerprint.operationVersion||!current||
     appSheetCanonicalCurrentDestinationHash(current,destinationType as "member"|"sku")!==fingerprint.dataHash)
   throw appSheetReadinessError("canonical_master_destination_changed_after_identity_review",{destinationType,sourceKey:record.sourceKey});
  if(destinationType==="sku"){
   const sku=skusById.get(identity.destinationId)!;
   if(sku.active)throw appSheetReadinessError("canonical_sku_must_remain_inactive_until_authority_activation",{skuId:sku.id});
   const activatedSnapshot={...sku,active:true};
   const activatedVersion=fingerprint.operationVersion+1;
   if(!Number.isSafeInteger(activatedVersion)||activatedVersion>2147483646)
    throw appSheetReadinessError("canonical_sku_operation_version_exhausted",{skuId:sku.id});
   skuActivationPlan.push({skuId:sku.id,sourceKey:record.sourceKey,baselineHash:fingerprint.dataHash,baselineVersion:fingerprint.operationVersion,
    activatedHash:appSheetCanonicalCurrentDestinationHash(activatedSnapshot,"sku"),activatedVersion,snapshot:activatedSnapshot});
  }
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
 const historyDestination=stage&&asJsonObject(stage.destination);
 const historyTechnicalReview=stage&&asJsonObject(stage.technicalReview);
 const historyRuntimeDestinationIdentity=productionAppSheetDestinationIdentity();
 const coverage=asJsonObject(history.coverage),historyDefinition=coverage&&asJsonObject(coverage.definition);
 const historyEffects=stage&&asJsonObject(stage.effects);
 const historyInventoryResult=appSheetDefinitionInventorySchema.safeParse(historyDefinition?.inventory);
 const historyInventory=historyInventoryResult.success?historyInventoryResult.data:null;
 const historyAppliedHash=historyInventory?appSheetAppliedDefinitionHash(historyInventory):null;
 if(!stage||!coverage||!historyDefinition||!historyInventory||!historyRuntimeDestinationIdentity||
    !appSheetHistoryStageHasBoundTechnicalReview(stage,{target:"production",destinationIdentity:historyRuntimeDestinationIdentity})||!historyDestination||
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
 if(!historyTechnicalReview||historyTechnicalReview.reviewKind!=="independent-technical"||historyTechnicalReview.approved!==true||
    sameHumanIdentity(historyTechnicalReview.reviewer,history.createdBy)||typeof historyTechnicalReview.reviewer!=="string"||!historyTechnicalReview.reviewer.trim()||
    typeof historyTechnicalReview.reviewedAt!=="string"||!Number.isFinite(Date.parse(historyTechnicalReview.reviewedAt))||Date.parse(historyTechnicalReview.reviewedAt)>Date.now()+60_000||
    historyTechnicalReview.findingsCount!==0||!hashPattern.test(String(historyTechnicalReview.findingsHash))||
    historyTechnicalReview.commitSha!==masterAuditDetails.commitSha||
    !hashPattern.test(String(stage.projectionHash))||historyTechnicalReview.commitSha!==definition.commitSha)
  throw appSheetReadinessError("historical_technical_review_unbound");
 const historyReviewHash=hashJson({schemaVersion:historyTechnicalReview.schemaVersion,reviewKind:historyTechnicalReview.reviewKind,approved:historyTechnicalReview.approved,
  bindingSource:historyTechnicalReview.bindingSource,projectionHash:stage.projectionHash,target:historyDestination.target,destinationIdentity:historyDestination.identity,
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
    historyAuditDetails.destinationIdentity!==historyDestination.identity||historyAuditDetails.authorizationContext!=="user-authorized-plan"||
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
  master:{id:master.id,fileHash:master.fileHash,sourceRecords:masterRecords.length,projectionHash:definition.projectionHash,
   destinationIdentity:definition.destinationIdentity,commitSha:definition.commitSha,
   technicalReviewHash:definition.reviewHash,backupManifestHash:definition.backupManifestHash},
  skuActivationPlan:skuActivationPlan.sort((left,right)=>left.skuId.localeCompare(right.skuId)),
  history:{id:history.id,fileHash:history.fileHash,sourceRecords:historyRecords.length,facts:historyFacts.length,publicationFingerprint:publication.fingerprint,
   projectionHash:String(stage.projectionHash),commitSha:String(historyTechnicalReview.commitSha),technicalReviewHash:historyReviewHash},
 };
}

/** Bind a stock opening to a SKU included in the exact reviewed canonical capture. */
export async function requireReviewedCanonicalSkuForAppSheetOpening(ctx:CommandContext,skuId:string,sourceBindingCaptureId:string){
 const authority=await ctx.tx.operationAuthority.findUnique({where:{id:"operations"},select:{mode:true,cutoverProfile:true,captureManifestId:true}});
 if(authority?.mode==="active"){
  if(authority.cutoverProfile!=="appsheet-replacement")
   throw appSheetReadinessError("canonical_opening_requires_active_replacement_authority",{skuId,captureId:sourceBindingCaptureId});
  if(!authority.captureManifestId||authority.captureManifestId!==sourceBindingCaptureId)
   throw appSheetReadinessError("canonical_opening_capture_not_active_authority",{skuId,captureId:sourceBindingCaptureId});
  const sku=await ctx.tx.catalogSku.findUnique({where:{id:skuId},select:{id:true,active:true,sourceSystem:true,sourceId:true}});
  if(!sku||!sku.active||sku.sourceSystem!==APPSHEET_CANONICAL_SOURCE_SYSTEM||!sku.sourceId)
   throw appSheetReadinessError("canonical_opening_sku_not_active_or_canonical",{skuId,captureId:sourceBindingCaptureId});
  const eligible=await eligibleAppSheetCanonicalSkuIds(ctx.tx,authority.captureManifestId,[skuId]);
  if(!eligible.has(skuId))
   throw appSheetReadinessError("canonical_opening_sku_not_in_active_reviewed_capture",{skuId,captureId:sourceBindingCaptureId});
  return {captureId:authority.captureManifestId,skuId};
 }
 const proof=await requireVerifiedAppSheetReplacement(ctx,sourceBindingCaptureId,{allowPendingObjects:true});
 if(!proof.skuActivationPlan.some(plan=>plan.skuId===skuId))
  throw appSheetReadinessError("canonical_opening_sku_not_in_reviewed_capture",{skuId,captureId:proof.capture.captureId});
 return {captureId:proof.capture.captureId,skuId};
}

const canonicalSkuActivationAuditAction="appsheet.canonical_sku_activated";
type CanonicalSkuActivationReceiptEntry=Omit<CanonicalSkuActivationPlan,"snapshot">;
function canonicalSkuActivationReceiptManifest(proof:AppSheetReplacementProof,entries:CanonicalSkuActivationReceiptEntry[]){
 return {schemaVersion:1,captureId:proof.capture.captureId,snapshotId:proof.master.id,projectionHash:proof.master.projectionHash,
  destinationIdentity:proof.master.destinationIdentity,entries};
}
/** Make the reviewed, inactive SKU projection available only in the AuthorityActivated transaction. */
async function activateReviewedCanonicalSkus(ctx:CommandContext,proof:AppSheetReplacementProof){
 const plans=proof.skuActivationPlan;
 const ids=plans.map(plan=>plan.skuId);
 const [skus,objects]=await Promise.all([
  ids.length?ctx.tx.catalogSku.findMany({where:{id:{in:ids}}}):Promise.resolve([]),
  ids.length?ctx.tx.operationObject.findMany({where:{id:{in:ids}}}):Promise.resolve([]),
 ]);
 const skuById=new Map(skus.map(sku=>[sku.id,sku])),objectById=new Map(objects.map(object=>[object.id,object]));
 for(const plan of plans){
  const sku=skuById.get(plan.skuId),object=objectById.get(plan.skuId);
  if(!sku||!object||object.kind!=="sku"||object.version!==plan.baselineVersion||
     appSheetCanonicalCurrentDestinationHash(sku,"sku")!==plan.baselineHash||sku.sourceSystem!==APPSHEET_CANONICAL_SOURCE_SYSTEM||sku.sourceId!==plan.sourceKey)
   throw appSheetReadinessError("canonical_sku_changed_before_activation",{skuId:plan.skuId});
 }
 const entries:CanonicalSkuActivationReceiptEntry[]=[];
 for(const plan of plans){
  const current=skuById.get(plan.skuId)!;
  let activated=current;
  let activatedVersion=plan.baselineVersion;
  if(!current.active){
   activated=await ctx.tx.catalogSku.update({where:{id:plan.skuId},data:{active:true}});
   const changed=await ctx.tx.operationObject.updateMany({where:{id:plan.skuId,kind:"sku",version:plan.baselineVersion},data:{version:{increment:1}}});
   if(changed.count!==1)throw appSheetReadinessError("canonical_sku_version_changed_during_activation",{skuId:plan.skuId});
   activatedVersion=plan.baselineVersion+1;
  }
  const activatedSnapshot:CanonicalSkuSnapshot={id:activated.id,code:activated.code,name:activated.name,variety:activated.variety,category:activated.category,
   unit:activated.unit,active:activated.active,sourceSystem:activated.sourceSystem,sourceId:activated.sourceId,appSheet:activated.appSheet};
  const activatedHash=appSheetCanonicalCurrentDestinationHash(activatedSnapshot,"sku");
  if(activatedHash!==plan.activatedHash||activatedVersion!==plan.activatedVersion)
   throw appSheetReadinessError("canonical_sku_activation_result_mismatch",{skuId:plan.skuId});
  const entry={skuId:plan.skuId,sourceKey:plan.sourceKey,baselineHash:plan.baselineHash,baselineVersion:plan.baselineVersion,
   activatedHash,activatedVersion};
  entries.push(entry);
  await ctx.tx.operationAudit.create({data:{actorId:ctx.actor.id,action:canonicalSkuActivationAuditAction,objectId:plan.skuId,requestId:ctx.envelope.requestId,
   details:json({schemaVersion:1,captureId:proof.capture.captureId,snapshotId:proof.master.id,projectionHash:proof.master.projectionHash,
    destinationIdentity:proof.master.destinationIdentity,...entry,snapshot:activatedSnapshot})}});
 }
 return canonicalSkuActivationReceiptManifest(proof,entries);
}

const canonicalSkuMutationAuditAction="appsheet.canonical_sku_mutation";
const canonicalSkuMutationCommands=["CatalogSkuUpdated","CatalogueSheetSaved"] as const;
function canonicalSkuSnapshot(value:unknown):CanonicalSkuSnapshot|null{
 const row=asJsonObject(value);
 if(!row||typeof row.id!=="string"||typeof row.code!=="string"||typeof row.name!=="string"||typeof row.variety!=="string"||
   typeof row.category!=="string"||typeof row.unit!=="string"||typeof row.active!=="boolean"||
   !(row.sourceSystem===null||typeof row.sourceSystem==="string")||!(row.sourceId===null||typeof row.sourceId==="string")||
   !Object.hasOwn(row,"appSheet"))return null;
 return {id:row.id,code:row.code,name:row.name,variety:row.variety,category:row.category,unit:row.unit,active:row.active,
  sourceSystem:row.sourceSystem,sourceId:row.sourceId,appSheet:row.appSheet};
}

/** Preserve a full hash-chain edge for SKU commands whose API result may be partial. */
export async function recordAppSheetCanonicalSkuMutation(ctx:CommandContext,beforeValue:unknown,afterValue:unknown,responseAppSheet?:unknown){
 const before=canonicalSkuSnapshot(beforeValue),after=canonicalSkuSnapshot(afterValue);
 if(!before||!after||after.sourceSystem!==APPSHEET_CANONICAL_SOURCE_SYSTEM)return;
 if(ctx.envelope.command!=="CatalogSkuUpdated"&&ctx.envelope.command!=="CatalogueSheetSaved")return;
 const resultingVersion=ctx.envelope.expectedVersion+1;
 const beforeHash=appSheetCanonicalCurrentDestinationHash(before,"sku"),afterHash=appSheetCanonicalCurrentDestinationHash(after,"sku");
 await ctx.tx.operationAudit.create({data:{actorId:ctx.actor.id,action:canonicalSkuMutationAuditAction,objectId:after.id,requestId:ctx.envelope.requestId,
  details:json({schemaVersion:1,command:ctx.envelope.command,skuId:after.id,sourceId:after.sourceId,sourceSystem:after.sourceSystem,
   baselineVersion:ctx.envelope.expectedVersion,resultingVersion,beforeHash,afterHash,snapshot:after,
   ...(ctx.envelope.command==="CatalogueSheetSaved"?{responseAppSheet:responseAppSheet??null}:{})})}});
}

type CanonicalSkuMutationCandidate={sku:CanonicalSkuSnapshot;sourceKey:string;activatedVersion:number;currentVersion:number;activatedHash:string;currentHash:string};
/** Accept only the AuthorityActivated receipt plus contiguous, server-recorded mutations after SKU activation. */
async function canonicalSkuMutationChainIds(tx:Tx,candidates:CanonicalSkuMutationCandidate[]):Promise<Set<string>>{
 const eligible=new Set<string>(),valid=candidates.filter(candidate=>Number.isSafeInteger(candidate.activatedVersion)&&candidate.activatedVersion>=0&&
  Number.isSafeInteger(candidate.currentVersion)&&candidate.currentVersion>=candidate.activatedVersion);
 if(!valid.length)return eligible;
 const receipts=await tx.commandReceipt.findMany({where:{OR:valid.map(candidate=>({targetId:candidate.sku.id,resultingVersion:{gt:candidate.activatedVersion}}))},
  orderBy:[{targetId:"asc"},{resultingVersion:"asc"}],select:{requestId:true,actorId:true,targetId:true,command:true,response:true,resultingVersion:true,committedAt:true}});
 const mutationReceipts=receipts.filter(receipt=>canonicalSkuMutationCommands.includes(receipt.command as typeof canonicalSkuMutationCommands[number]));
 const requestIds=mutationReceipts.map(receipt=>receipt.requestId),targetIds=[...new Set(mutationReceipts.map(receipt=>receipt.targetId))];
 const [commandAudits,mutationAudits]=requestIds.length?await Promise.all([
  tx.operationAudit.findMany({where:{objectId:{in:targetIds},action:{in:[...canonicalSkuMutationCommands]},requestId:{in:requestIds}},
   select:{actorId:true,action:true,objectId:true,requestId:true,details:true,createdAt:true}}),
  tx.operationAudit.findMany({where:{objectId:{in:targetIds},action:canonicalSkuMutationAuditAction,requestId:{in:requestIds}},
   select:{actorId:true,action:true,objectId:true,requestId:true,details:true,createdAt:true}}),
 ]):[[],[]];
 const receiptsBySku=new Map<string,typeof receipts>(),commandAuditsByRequest=new Map<string,typeof commandAudits>(),mutationAuditsByRequest=new Map<string,typeof mutationAudits>();
 for(const receipt of receipts){const rows=receiptsBySku.get(receipt.targetId)??[];rows.push(receipt);receiptsBySku.set(receipt.targetId,rows);}
 for(const row of commandAudits){const key=`${row.objectId}\0${row.requestId??""}\0${row.action}`,rows=commandAuditsByRequest.get(key)??[];rows.push(row);commandAuditsByRequest.set(key,rows);}
 for(const row of mutationAudits){const key=`${row.objectId}\0${row.requestId??""}`,rows=mutationAuditsByRequest.get(key)??[];rows.push(row);mutationAuditsByRequest.set(key,rows);}
 for(const candidate of valid){
  const {sku,sourceKey,activatedVersion,currentVersion,activatedHash,currentHash}=candidate;
  const rows=receiptsBySku.get(sku.id)??[];
  if(rows.length!==currentVersion-activatedVersion||rows.some(receipt=>!canonicalSkuMutationCommands.includes(receipt.command as typeof canonicalSkuMutationCommands[number])))continue;
  if(!rows.length){if(currentHash===activatedHash)eligible.add(sku.id);continue;}
  let expectedVersion=activatedVersion+1,latestHash=activatedHash,ok=true;
  for(const receipt of rows){
   if(receipt.resultingVersion!==expectedVersion++||receipt.resultingVersion>currentVersion||receipt.targetId!==sku.id||
      !canonicalSkuMutationCommands.includes(receipt.command as typeof canonicalSkuMutationCommands[number])||
      !(receipt.committedAt instanceof Date)||!Number.isFinite(receipt.committedAt.getTime())){ok=false;break;}
   const commandAuditRows=commandAuditsByRequest.get(`${sku.id}\0${receipt.requestId}\0${receipt.command}`)??[];
   // Handlers may add a business audit under the same action. The core receipt
   // evidence is its version-only audit, which must still be unique.
   const genericRows=commandAuditRows.filter(row=>{
    const auditDetails=asJsonObject(row.details);
    return auditDetails!==null&&Object.keys(auditDetails).length===1&&auditDetails.version===receipt.resultingVersion;
   });
   const mutationRows=mutationAuditsByRequest.get(`${sku.id}\0${receipt.requestId}`)??[];
   if(genericRows.length!==1||mutationRows.length!==1){ok=false;break;}
   const generic=genericRows[0]!,mutation=mutationRows[0]!,genericDetails=asJsonObject(generic.details),details=asJsonObject(mutation.details);
   const response=asJsonObject(receipt.response),result=response&&asJsonObject(response.result),snapshot=details&&canonicalSkuSnapshot(details.snapshot);
   if(generic.actorId!==receipt.actorId||generic.requestId!==receipt.requestId||generic.objectId!==sku.id||
      !(generic.createdAt instanceof Date)||!Number.isFinite(generic.createdAt.getTime())||genericDetails?.version!==receipt.resultingVersion||
      mutation.actorId!==receipt.actorId||mutation.requestId!==receipt.requestId||mutation.objectId!==sku.id||
      !(mutation.createdAt instanceof Date)||!Number.isFinite(mutation.createdAt.getTime())||!details||details.schemaVersion!==1||
      details.command!==receipt.command||details.skuId!==sku.id||details.sourceSystem!==APPSHEET_CANONICAL_SOURCE_SYSTEM||details.sourceId!==sourceKey||
      details.baselineVersion!==receipt.resultingVersion-1||details.resultingVersion!==receipt.resultingVersion||details.beforeHash!==latestHash||
      !snapshot||snapshot.id!==sku.id||snapshot.sourceSystem!==APPSHEET_CANONICAL_SOURCE_SYSTEM||snapshot.sourceId!==sourceKey||
      appSheetCanonicalCurrentDestinationHash(snapshot,"sku")!==details.afterHash||!response||response.requestId!==receipt.requestId||
      response.targetId!==sku.id||response.version!==receipt.resultingVersion||!result){ok=false;break;}
   if(receipt.command==="CatalogSkuUpdated"){
    const responseSku=result.sku&&canonicalSkuSnapshot(result.sku);
    if(!responseSku||appSheetCanonicalCurrentDestinationHash(responseSku,"sku")!==details.afterHash){ok=false;break;}
   }else if(result.skuId!==sku.id||canonicalJson(result.appSheet)!==canonicalJson(details.responseAppSheet)){ok=false;break;}
   latestHash=String(details.afterHash);
  }
  if(ok&&expectedVersion===currentVersion+1&&latestHash===currentHash)eligible.add(sku.id);
 }
 return eligible;
}

/** Return SKU identities that were reviewed and activated by the active capture, then stayed on an auditable mutation chain. */
export async function eligibleAppSheetCanonicalSkuIds(tx:Tx,captureId:string|null,onlySkuIds?:string[]):Promise<Set<string>>{
 if(!captureId||onlySkuIds?.length===0)return new Set();
 let capture:Awaited<ReturnType<typeof requireStableAppSheetCapture>>;
 try{capture=await requireStableAppSheetCapture(tx,captureId);}catch(error){
  if(error instanceof OperationError&&error.code==="APPSHEET_REPLACEMENT_NOT_READY")return new Set();
  throw error;
 }
 const destinationIdentity=productionAppSheetDestinationIdentity();
 if(!destinationIdentity)return new Set();
 const authority=await tx.operationAuthority.findUnique({where:{id:"operations"},select:{mode:true,cutoverProfile:true,captureManifestId:true,epoch:true,approvedBy:true}});
 if(authority?.mode!=="active"||authority.cutoverProfile!=="appsheet-replacement"||authority.captureManifestId!==capture.captureId||!authority.approvedBy||
    !Number.isSafeInteger(authority.epoch))return new Set();
 const snapshots=await tx.legacyImportSnapshot.findMany({where:{sourceSystem:APPSHEET_CANONICAL_SOURCE_SYSTEM,captureManifestId:capture.captureId,
  fileHash:capture.manifestHash,importerVersion:APPSHEET_CANONICAL_IMPORTER_VERSION},select:{id:true,status:true,createdBy:true,reviewedBy:true,reviewedAt:true,
  controls:true,coverage:true,fileHash:true,sourceSystem:true,importerVersion:true}});
 if(snapshots.length!==1)return new Set();
 const snapshot=snapshots[0]!,controls=asJsonObject(snapshot.controls),projection=controls&&asJsonObject(controls.appSheetCanonical);
 const stageContext=projection&&asJsonObject(projection.stageContext),projectionHash=typeof projection?.projectionHash==="string"?projection.projectionHash:"";
 if(snapshot.status!=="reviewed"||!snapshot.reviewedBy||snapshot.reviewedBy===snapshot.createdBy||!snapshot.reviewedAt||snapshot.fileHash!==capture.manifestHash||
  snapshot.sourceSystem!==APPSHEET_CANONICAL_SOURCE_SYSTEM||snapshot.importerVersion!==APPSHEET_CANONICAL_IMPORTER_VERSION||!stageContext||stageContext.target!=="production"||
  stageContext.destinationIdentity!==destinationIdentity||!hashPattern.test(projectionHash))return new Set();
 const reviewer=await tx.user.findUnique({where:{id:snapshot.reviewedBy},select:{active:true}});
 if(!reviewer?.active)return new Set();
 const [records,allReceipts]=await Promise.all([
  tx.legacySourceRecord.findMany({where:{snapshotId:snapshot.id},select:{id:true,sourceTable:true,sourceKey:true,contentHash:true,fileHash:true,importerVersion:true,treatment:true}}),
  tx.commandReceipt.findMany({where:{targetId:"operations",command:"AuthorityActivated"},orderBy:{resultingVersion:"desc"},
   select:{requestId:true,actorId:true,targetId:true,command:true,response:true,resultingVersion:true,authorityEpoch:true,committedAt:true}}),
 ]);
 const skuRecords=records.filter(record=>record.sourceTable==="D_Catalogo_Mercaderia"),
  fingerprints=Array.isArray(projection.destinationFingerprints)?projection.destinationFingerprints.map(asJsonObject):[];
 const identityCount=records.length;
 if(!skuRecords.length||records.some(record=>!record.sourceKey||record.fileHash!==snapshot.fileHash||record.importerVersion!==snapshot.importerVersion||record.treatment!=="fact_candidate"))return new Set();
 const tableCoverageRaw=asJsonObject(snapshot.coverage),tableProjection=tableCoverageRaw&&asJsonObject(tableCoverageRaw.appSheetCanonical),tables=Array.isArray(tableProjection?.tables)?tableProjection.tables.map(asJsonObject):null;
 if(!tables||tables.some(table=>!table))return new Set();
 for(const tableName of ["C_Cliente","D_Catalogo_Mercaderia"]){
  const actual=records.filter(record=>record.sourceTable===tableName).length,declared=tables.find(table=>table!.sourceTable===tableName);
  if(!declared||declared!.sourceRecordCount!==actual||declared!.canonicalTargetCount!==actual||declared!.blockingExceptionCount!==0||declared!.reviewExceptionCount!==0)return new Set();
 }
 if(fingerprints.length!==identityCount||fingerprints.some(row=>!row))return new Set();
 const sourceKeys=skuRecords.map(record=>record.sourceKey),[identities,snapshotReviews]=await Promise.all([
  tx.legacyIdentity.findMany({where:{sourceSystem:APPSHEET_CANONICAL_SOURCE_SYSTEM,sourceTable:"D_Catalogo_Mercaderia",sourceKey:{in:sourceKeys}},
   select:{id:true,sourceSystem:true,sourceTable:true,sourceKey:true,destinationType:true,destinationId:true,approvedBy:true}}),
  tx.operationAudit.findMany({where:{objectId:snapshot.id,action:canonicalIdentitiesReviewedAction},select:{actorId:true,requestId:true,details:true,createdAt:true},take:2}),
 ]);
 if(identities.length!==skuRecords.length||new Set(identities.map(identity=>identity.sourceKey)).size!==skuRecords.length||identities.some(identity=>identity.destinationType!=="sku"||identity.approvedBy===null))return new Set();
 const snapshotReview=snapshotReviews[0]&&asJsonObject(snapshotReviews[0].details);
 if(snapshotReviews.length!==1||snapshotReviews[0]!.actorId!==snapshot.reviewedBy||!snapshotReviews[0]!.requestId||
  !(snapshotReviews[0]!.createdAt instanceof Date)||snapshotReviews[0]!.createdAt<snapshot.reviewedAt||!snapshotReview||snapshotReview.schemaVersion!==1||
  snapshotReview.snapshotId!==snapshot.id||snapshotReview.captureId!==capture.captureId||snapshotReview.manifestHash!==capture.manifestHash||
  snapshotReview.projectionHash!==projectionHash||snapshotReview.destinationIdentity!==destinationIdentity||snapshotReview.identityCount!==identityCount||
  snapshotReview.expectedIdentityCount!==identityCount)return new Set();
 const identityAudits=await tx.operationAudit.findMany({where:{objectId:{in:identities.map(identity=>identity.id)},action:canonicalIdentityReviewedAction},
  select:{actorId:true,objectId:true,requestId:true,details:true,createdAt:true}});
 const auditsByIdentity=new Map<string,typeof identityAudits>();
 for(const auditRow of identityAudits){const rows=auditsByIdentity.get(auditRow.objectId)??[];rows.push(auditRow);auditsByIdentity.set(auditRow.objectId,rows);}
 const recordByKey=new Map(skuRecords.map(record=>[record.sourceKey,record])),identityByKey=new Map(identities.map(identity=>[identity.sourceKey,identity]));
 const fingerprintByKey=new Map<string,Record<string,unknown>>();
 for(const raw of fingerprints){const row=raw!;if(row.sourceTable!=="D_Catalogo_Mercaderia")continue;
  if(typeof row.sourceKey!=="string"||fingerprintByKey.has(row.sourceKey))return new Set();fingerprintByKey.set(row.sourceKey,row);}
 if(fingerprintByKey.size!==skuRecords.length)return new Set();
 const expectedAuthorityReceipts=allReceipts.filter(receipt=>{
  const response=asJsonObject(receipt.response),result=response&&asJsonObject(response.result),activatedAuthority=result&&asJsonObject(result.authority);
  return activatedAuthority?.mode==="active"&&activatedAuthority.cutoverProfile==="appsheet-replacement"&&activatedAuthority.captureManifestId===capture.captureId&&
   activatedAuthority.epoch===authority.epoch&&activatedAuthority.approvedBy===authority.approvedBy;
 });
 if(expectedAuthorityReceipts.length!==1)return new Set();
 const authorityReceipt=expectedAuthorityReceipts[0]!,authorityResponse=asJsonObject(authorityReceipt.response),authorityResult=authorityResponse&&asJsonObject(authorityResponse.result),
  activatedAuthority=authorityResult&&asJsonObject(authorityResult.authority),activationManifest=authorityResult&&asJsonObject(authorityResult.appSheetSkuActivation),
  manifestEntries=Array.isArray(activationManifest?.entries)?activationManifest.entries.map(asJsonObject):null;
 if(!authorityResponse||authorityResponse.requestId!==authorityReceipt.requestId||authorityResponse.targetId!=="operations"||
  authorityResponse.version!==authorityReceipt.resultingVersion||authorityReceipt.targetId!=="operations"||authorityReceipt.command!=="AuthorityActivated"||
  authorityReceipt.actorId!==authority.approvedBy||authorityReceipt.authorityEpoch+1!==authority.epoch||
  !(authorityReceipt.committedAt instanceof Date)||!Number.isFinite(authorityReceipt.committedAt.getTime())||!activatedAuthority||
  !activationManifest||activationManifest.schemaVersion!==1||activationManifest.captureId!==capture.captureId||activationManifest.snapshotId!==snapshot.id||
  activationManifest.projectionHash!==projectionHash||activationManifest.destinationIdentity!==destinationIdentity||!manifestEntries||
  manifestEntries.length!==skuRecords.length||manifestEntries.some(entry=>!entry))return new Set();
 const authorityAudits=await tx.operationAudit.findMany({where:{objectId:"operations",action:"AuthorityActivated",requestId:authorityReceipt.requestId},
  select:{actorId:true,requestId:true,details:true,createdAt:true}});
 if(authorityAudits.length!==1||authorityAudits[0]!.actorId!==authorityReceipt.actorId||authorityAudits[0]!.requestId!==authorityReceipt.requestId||
  !(authorityAudits[0]!.createdAt instanceof Date)||!Number.isFinite(authorityAudits[0]!.createdAt.getTime())||
  asJsonObject(authorityAudits[0]!.details)?.version!==authorityReceipt.resultingVersion)return new Set();
 const entriesBySku=new Map<string,Record<string,unknown>>();
 for(const entry of manifestEntries){const skuId=String(entry!.skuId);if(!skuId||entriesBySku.has(skuId))return new Set();entriesBySku.set(skuId,entry!);}
 if(entriesBySku.size!==skuRecords.length)return new Set();
 const skuIds=identities.map(identity=>identity.destinationId),[skus,objects,activationAudits]=await Promise.all([
  tx.catalogSku.findMany({where:{id:{in:skuIds}},select:{id:true,code:true,name:true,variety:true,category:true,unit:true,active:true,sourceSystem:true,sourceId:true,appSheet:true}}),
  tx.operationObject.findMany({where:{id:{in:skuIds}},select:{id:true,kind:true,version:true}}),
  tx.operationAudit.findMany({where:{objectId:{in:skuIds},action:canonicalSkuActivationAuditAction,requestId:authorityReceipt.requestId},
   select:{actorId:true,action:true,objectId:true,requestId:true,details:true,createdAt:true}}),
 ]);
 const skuById=new Map(skus.map(sku=>[sku.id,sku])),objectById=new Map(objects.map(object=>[object.id,object])),
  activationAuditsBySku=new Map(activationAudits.map(row=>[row.objectId,row]));
 if(activationAudits.length!==skuRecords.length)return new Set();
 const candidates:CanonicalSkuMutationCandidate[]=[];
 for(const identity of identities){
  const record=recordByKey.get(identity.sourceKey),fingerprint=fingerprintByKey.get(identity.sourceKey),entry=entriesBySku.get(identity.destinationId),
   sku=skuById.get(identity.destinationId),object=objectById.get(identity.destinationId),auditRow=activationAuditsBySku.get(identity.destinationId),
   reviewRows=auditsByIdentity.get(identity.id)??[],reviewDetails=reviewRows.length===1?asJsonObject(reviewRows[0]!.details):null,
   activationDetails=auditRow&&asJsonObject(auditRow.details),activatedSnapshot=activationDetails&&canonicalSkuSnapshot(activationDetails.snapshot);
  if(!record||!fingerprint||!entry||!sku||!object||object.kind!=="sku"||!auditRow||auditRow.actorId!==authorityReceipt.actorId||
   auditRow.requestId!==authorityReceipt.requestId||!(auditRow.createdAt instanceof Date)||!Number.isFinite(auditRow.createdAt.getTime())||!activationDetails||
   reviewRows.length!==1||reviewRows[0]!.actorId!==snapshot.reviewedBy||reviewRows[0]!.requestId!==snapshotReviews[0]!.requestId||
   !(reviewRows[0]!.createdAt instanceof Date)||reviewRows[0]!.createdAt<snapshot.reviewedAt||!reviewDetails||reviewDetails.schemaVersion!==1||
   reviewDetails.identityId!==identity.id||reviewDetails.snapshotId!==snapshot.id||reviewDetails.captureId!==capture.captureId||reviewDetails.manifestHash!==capture.manifestHash||
   reviewDetails.projectionHash!==projectionHash||reviewDetails.destinationIdentity!==destinationIdentity||reviewDetails.sourceRecordId!==record.id||
   reviewDetails.sourceTable!==identity.sourceTable||reviewDetails.sourceKey!==identity.sourceKey||reviewDetails.sourceContentHash!==record.contentHash||
   reviewDetails.destinationType!=="sku"||reviewDetails.destinationId!==identity.destinationId||reviewDetails.approvedBy!==snapshot.reviewedBy||
   typeof fingerprint.destinationId!=="string"||fingerprint.destinationId!==identity.destinationId||fingerprint.destinationType!=="sku"||
   typeof fingerprint.dataHash!=="string"||!hashPattern.test(fingerprint.dataHash)||typeof fingerprint.operationVersion!=="number"||
   !Number.isSafeInteger(fingerprint.operationVersion)||fingerprint.operationVersion<0||reviewDetails.destinationDataHash!==fingerprint.dataHash||
   entry.skuId!==identity.destinationId||entry.sourceKey!==record.sourceKey||entry.baselineHash!==fingerprint.dataHash||
   entry.baselineVersion!==fingerprint.operationVersion||entry.activatedVersion!==fingerprint.operationVersion+1||
   activationDetails.schemaVersion!==1||activationDetails.captureId!==capture.captureId||activationDetails.snapshotId!==snapshot.id||
   activationDetails.projectionHash!==projectionHash||activationDetails.destinationIdentity!==destinationIdentity||activationDetails.skuId!==identity.destinationId||
   activationDetails.sourceKey!==record.sourceKey||activationDetails.baselineHash!==entry.baselineHash||activationDetails.baselineVersion!==entry.baselineVersion||
   activationDetails.activatedHash!==entry.activatedHash||activationDetails.activatedVersion!==entry.activatedVersion||!activatedSnapshot||
   !activatedSnapshot.active||activatedSnapshot.id!==identity.destinationId||activatedSnapshot.sourceSystem!==APPSHEET_CANONICAL_SOURCE_SYSTEM||
   activatedSnapshot.sourceId!==record.sourceKey||appSheetCanonicalCurrentDestinationHash(activatedSnapshot,"sku")!==entry.activatedHash||
   object.version<entry.activatedVersion||sku.sourceSystem!==APPSHEET_CANONICAL_SOURCE_SYSTEM||sku.sourceId!==record.sourceKey)continue;
  const entryWithoutExtras={skuId:entry.skuId,sourceKey:entry.sourceKey,baselineHash:entry.baselineHash,baselineVersion:entry.baselineVersion,
   activatedHash:entry.activatedHash,activatedVersion:entry.activatedVersion};
  const auditedEntry={skuId:activationDetails.skuId,sourceKey:activationDetails.sourceKey,baselineHash:activationDetails.baselineHash,
   baselineVersion:activationDetails.baselineVersion,activatedHash:activationDetails.activatedHash,activatedVersion:activationDetails.activatedVersion};
  if(canonicalJson(entryWithoutExtras)!==canonicalJson(auditedEntry))continue;
  candidates.push({sku:activatedSnapshot,sourceKey:record.sourceKey,activatedVersion:entry.activatedVersion as number,currentVersion:object.version,
   activatedHash:entry.activatedHash as string,currentHash:appSheetCanonicalCurrentDestinationHash(sku,"sku")});
 }
 const chainEligible=await canonicalSkuMutationChainIds(tx,candidates),selectedIds=new Set(onlySkuIds??[]);
 return new Set([...chainEligible].filter(id=>!selectedIds.size||selectedIds.has(id)));
}

/** Keep native catalog rows intact; canonical rows must be reviewed and activated by the selected capture. */
export async function requireEligibleAppSheetReplacementSkus(tx:Tx,skuIds:string[]):Promise<void>{
 if(!skuIds.length)return;
 const authority=await tx.operationAuthority.findUnique({where:{id:"operations"},select:{mode:true,cutoverProfile:true,captureManifestId:true}});
 if(authority?.mode!=="active"||authority.cutoverProfile!=="appsheet-replacement")return;
 const skus=await tx.catalogSku.findMany({where:{id:{in:[...new Set(skuIds)]}},select:{id:true,sourceSystem:true,sourceId:true}});
 const imported=skus.filter(sku=>sku.sourceSystem!==null||sku.sourceId!==null),canonical=imported.filter(sku=>sku.sourceSystem===APPSHEET_CANONICAL_SOURCE_SYSTEM);
 if(imported.length!==canonical.length)throw new OperationError(423,"APPSHEET_SKU_NOT_ELIGIBLE","El producto importado no pertenece a la captura AppSheet revisada por la autoridad activa.");
 if(!canonical.length)return;
 const eligible=await eligibleAppSheetCanonicalSkuIds(tx,authority.captureManifestId,canonical.map(sku=>sku.id));
 const denied=canonical.find(sku=>!eligible.has(sku.id));
 if(denied)throw new OperationError(423,"APPSHEET_SKU_NOT_ELIGIBLE","El producto AppSheet no pertenece a la captura activa revisada o perdió su cadena de aprobación.",{skuId:denied.id});
}

export async function requireEligibleAppSheetReplacementOrderSkus(tx:Tx,orderId:string){
 const lines=await tx.operationOrderLine.findMany({where:{orderId},select:{skuId:true}});
 await requireEligibleAppSheetReplacementSkus(tx,[...new Set(lines.map(line=>line.skuId))]);
}

type OpeningSourceKind="cash"|"stock";
type OpeningSourceExpectation={kind:OpeningSourceKind;amountMinor?:bigint;currency?:string;quantity?:string;unit?:string;skuSourceId?:string;allowAlreadyLinked?:boolean};
/** Bind opening effects to a reviewed fact under the exact AppSheet capture; a caller-supplied ID alone proves nothing. */
export async function requireAppSheetOpeningSourceRecord(ctx:CommandContext,sourceRecordId:string|undefined,expected:OpeningSourceExpectation){
 const canonicalCapture=await requireCanonicalAppSheetReplacementProfile(ctx.tx);
 const authority=await ctx.tx.operationAuthority.findUnique({where:{id:"operations"},select:{mode:true,cutoverProfile:true,captureManifestId:true}});
 const boundGates=await ctx.tx.cutoverGate.findMany({where:{captureManifestId:{not:null}},select:{captureManifestId:true}});
 const boundCaptureIds=[...new Set(boundGates.flatMap(row=>row.captureManifestId?[row.captureManifestId]:[]))];
 let captureId=authority?.mode==="active"&&authority.cutoverProfile==="appsheet-replacement"?authority.captureManifestId:null;
 if(boundCaptureIds.length>1)throw appSheetReadinessError("opening_cutover_capture_ambiguous");
 if(boundCaptureIds.length===1){if(captureId&&captureId!==boundCaptureIds[0])throw appSheetReadinessError("opening_cutover_capture_mismatch");captureId??=boundCaptureIds[0]!;}
 if(!sourceRecordId){
  if(captureId||canonicalCapture)throw appSheetReadinessError("opening_source_record_required",{
   ...((captureId??canonicalCapture?.captureId)?{captureId:captureId??canonicalCapture?.captureId}:{}),
   ...(canonicalCapture?.snapshotId?{snapshotId:canonicalCapture.snapshotId}:{}),
  });
  return null;
 }
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
 const countLinkedOpeningEffects=()=>expected.kind==="cash"
  ?ctx.tx.ledgerEvent.count({where:{kind:"opening",sourceRecordId:source.id}})
  :ctx.tx.stockFact.count({where:{kind:"opening",sourceRecordId:source.id}});
 if(!publication||publication.snapshotId!==source.snapshotId||publication.fileHash!==capture.manifestHash||publication.mappingId!==APPSHEET_HISTORY_MAPPING_ID||fact?.sourceHash!==source.contentHash||openExceptions!==0)
  throw appSheetReadinessError("opening_source_history_publication_or_hash_missing");
 if(expected.kind==="cash"){
  if(["Movimiento","Movimiento_Nueva"].includes(source.sourceTable))throw appSheetReadinessError("cash_opening_source_is_cashflow");
  throw appSheetReadinessError("cash_opening_balance_checkpoint_unavailable");
 }else{
  if(source.sourceTable==="Mov_Stock1")throw appSheetReadinessError("stock_opening_source_is_ledger_movement");
  if(fact.quantityState!=="known"||fact.unitState!=="known"||!fact.quantity?.equals(expected.quantity??"")||fact.unit!==expected.unit)
   throw appSheetReadinessError("stock_opening_source_quantity_or_unit_mismatch");
  const attributes=asJsonObject(fact.attributes),relationships=attributes&&Array.isArray(attributes.relationships)?attributes.relationships.map(asJsonObject):[];
  const skuRelationship=relationships.find(item=>item?.targetTable==="D_Catalogo_Mercaderia"&&item.status==="unique"&&item.targetSourceKey===expected.skuSourceId);
  if(!expected.skuSourceId||!skuRelationship)throw appSheetReadinessError("stock_opening_source_sku_relationship_unverified");
 }
 if(!expected.allowAlreadyLinked){
  const linked=await countLinkedOpeningEffects();
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
 execute:async ctx=>{
  await requireEligibleAppSheetReplacementMember(ctx.tx,ctx.envelope.targetId);
  return {member:await ctx.tx.operationMember.update({where:{id:ctx.envelope.targetId},data:{...ctx.envelope.data as {name:string;email:string;phone:string},address:json(ctx.envelope.data.address),preferences:json(ctx.envelope.data.preferences)}})};
 }});
registerCommand("PermissionVerified",{kind:"member",capability:"permissions.verify",
 schema:z.strictObject({kind:z.string().min(1).max(80),validFrom:civilDate,validUntil:civilDate,evidenceDocumentId:z.uuid()}),
 execute:async ctx=>{
  await requireEligibleAppSheetReplacementMember(ctx.tx,ctx.envelope.targetId);
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
  await requireEligibleAppSheetReplacementMember(ctx.tx,ctx.envelope.targetId);
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
 await requireCanonicalAppSheetReplacementProfile(ctx.tx,v.cutoverProfile);
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
 let gateProof:Record<string,unknown>|null=null;
 if(v.gateId==="open-objects-approved"){
  try{gateProof=await requireReviewedAppSheetPendingImport(ctx.tx,v.captureId!);}
  catch(error){throw appSheetReadinessError(error instanceof Error?error.message:"pending_import_review_incomplete");}
 }
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
  const openObjectsGate=gatesById.get("open-objects-approved"),openObjectsEnvelope=openObjectsGate&&asJsonObject(openObjectsGate.evidence),
   openObjectsBinding=openObjectsEnvelope&&asJsonObject(openObjectsEnvelope.appSheetReplacement),
   sealedPendingImportProof=openObjectsBinding&&asJsonObject(openObjectsBinding.gateProof);
  if(!captureId||!sealedPendingImportProof)throw appSheetReadinessError("open_objects_pending_import_gate_proof_missing",{captureId});
  let currentPendingImportProof:Awaited<ReturnType<typeof requireReviewedAppSheetPendingImport>>;
  try{currentPendingImportProof=await requireReviewedAppSheetPendingImport(ctx.tx,captureId);}
  catch(error){throw appSheetReadinessError(error instanceof Error?error.message:"pending_import_review_incomplete",{captureId});}
  if(hashJson(sealedPendingImportProof)!==hashJson(currentPendingImportProof))
   throw appSheetReadinessError("open_objects_pending_import_gate_stale",{captureId});
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
async function requireCurrentOperationsOwnerAuthority(ctx:CommandContext){
 if(ctx.envelope.targetId!=="operations")throw new OperationError(400,"AUTHORITY_ID","Circuito inválido");
 const actor=await ctx.tx.user.findUnique({where:{id:ctx.actor.id},select:{active:true,role:true}});
 if(!actor?.active||actor.role!=="owner")throw new OperationError(403,"OWNER_REQUIRED","Sólo el propietario activo puede suspender la autoridad operativa");
 return ctx.tx.operationAuthority.findUnique({where:{id:"operations"}});
}
async function hasOwnCommandReceipt(ctx:CommandContext){
 const receipt=await ctx.tx.commandReceipt.findUnique({where:{requestId:ctx.envelope.requestId},select:{actorId:true,targetId:true,command:true}});
 return receipt?.actorId===ctx.actor.id&&receipt.targetId===ctx.envelope.targetId&&receipt.command===ctx.envelope.command;
}
async function requireActiveOperationsAuthority(ctx:CommandContext,allowOwnSuspensionReplay=false){
 const authority=await requireCurrentOperationsOwnerAuthority(ctx);
 if(allowOwnSuspensionReplay&&authority?.mode==="shadow"&&await hasOwnCommandReceipt(ctx))return authority;
 if(authority?.mode!=="active")throw new OperationError(409,"AUTHORITY_NOT_ACTIVE","La autoridad operativa no está activa");
 return authority;
}
registerCommand("AuthoritySuspended",{kind:"authority",capability:"cutover.approve",create:true,administrative:true,
 schema:authoritySuspensionSchema,
 authorize:async ctx=>{await requireActiveOperationsAuthority(ctx,true);},
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
  await requireCanonicalAppSheetReplacementProfile(ctx.tx,input.cutoverProfile);
  if(process.env.CLUB_OPERATIONS_APPROVED!=="true")throw new OperationError(423,"CLUB_OPERATIONS_APPROVAL_REQUIRED","La habilitación operativa requiere aprobación documentada");
  // Keep current target, capability, configuration, and profile checks above.
  // Revalidate first-activation evidence only for new requests: exact own receipts
  // are returned by core after it verifies actor and bodyHash below.
  if(await hasOwnCommandReceipt(ctx))return;
  if(input.cutoverProfile==="appsheet-replacement"){
   const proof=await requireVerifiedAppSheetReplacement(ctx,input.captureId!);
   await requireApprovedCutoverGates(ctx,input.cutoverProfile,input.captureId,proof);
   await requireReplacementOpeningGateEvidence(ctx,proof);
  }else await requireApprovedCutoverGates(ctx,input.cutoverProfile,input.captureId);
 },
 execute:async ctx=>{
  if(ctx.envelope.targetId!=="operations")throw new OperationError(400,"AUTHORITY_ID","Circuito inválido");
  const input=authorityActivationSchema.parse(ctx.envelope.data);
  await requireCanonicalAppSheetReplacementProfile(ctx.tx,input.cutoverProfile);
  let skuActivationManifest:ReturnType<typeof canonicalSkuActivationReceiptManifest>|undefined;
  if(input.cutoverProfile==="appsheet-replacement"){
   const proof=await requireVerifiedAppSheetReplacement(ctx,input.captureId!);
   await requireApprovedCutoverGates(ctx,input.cutoverProfile,input.captureId,proof);
   await requireReplacementOpeningGateEvidence(ctx,proof);
   // The SKU activation, its per-SKU seals, and the authority transition share
   // this serializable transaction. Any failed gate or write rolls all of them back.
   skuActivationManifest=await activateReviewedCanonicalSkus(ctx,proof);
  }else await requireApprovedCutoverGates(ctx,input.cutoverProfile,input.captureId);
  const old=await ctx.tx.operationAuthority.findUnique({where:{id:"operations"}});
  if(old?.mode==="active")throw new OperationError(409,"AUTHORITY_ALREADY_ACTIVE","El circuito ya está activo");
  const authority=await ctx.tx.operationAuthority.upsert({where:{id:"operations"},create:{id:"operations",mode:"active",cutoverProfile:input.cutoverProfile,captureManifestId:input.cutoverProfile==="appsheet-replacement"?input.captureId:null,epoch:2,approvedBy:ctx.actor.id,evidence:json(input.evidence)},update:{mode:"active",cutoverProfile:input.cutoverProfile,captureManifestId:input.cutoverProfile==="appsheet-replacement"?input.captureId:null,epoch:{increment:1},approvedBy:ctx.actor.id,evidence:json(input.evidence)}});
  return {authority,...(skuActivationManifest?{appSheetSkuActivation:skuActivationManifest}:{})};
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
