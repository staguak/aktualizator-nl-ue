import {isDeepStrictEqual} from 'node:util';
import {hash,encode} from './release-store.js';
import {validateContext} from './release-engine.js';
import {expandMetadata} from './eu-normalize.js';
import type {RunContext} from './release-engine.js';
import type {ValidationResult} from './validation-result.js';
import {compareSourceReportEvidence} from './source-report-evidence.js';
import {operationMetrics} from './operation-metrics.js';
import {sourceAuditMode,sourceAuditIdentity} from './source-audit.js';
import {sourceFindingCounts} from './source-availability.js';
import {errorRegistryReference} from './operation-errors.js';

interface DocumentState {text:string;metadata:unknown}
// These are document/selected-article comparisons. They never infer repeal,
// continuity of anonymous subunits, commencement or applicability.
function documents(manifest:any):Map<string,DocumentState>{
  const result=new Map<string,DocumentState>();
  for(const act of manifest.acts){
    const add=(id:string,value:DocumentState)=>{
      if(result.has(id))throw new Error('Duplicate report document identity.');
      result.set(id,value);
    };
    if(manifest.jurisdiction==='NL')for(const state of act.sourceStates??[]){
      const text=(act.articles??[]).flatMap((article:any)=>(article.versions??[])
        .filter((v:any)=>v.sourceStates.includes(state.index)).map((v:any)=>[article.articleId,v.contentHash]));
      add(JSON.stringify([act.bwbId,state.key]),{text:hash(encode(text)),metadata:{...state,index:undefined}});
    }else for(const doc of act.documents??[]){
      add(JSON.stringify([act.celex,doc.celex]),{text:doc.inputBodyHash??doc.sourceHash,
        metadata:{metadata:expandMetadata(doc.metadata,doc.celex,manifest.normalization),
          sourceUrl:doc.sourceUrl,language:doc.language??manifest.language}});
    }
  }
  return result;
}
function selectedUnits(manifest:any):Map<string,string>{
  const units=new Map<string,string>();
  if(manifest.jurisdiction==='NL')for(const act of manifest.acts)for(const article of act.articles??[])
    units.set(JSON.stringify([act.bwbId,article.articleId]),hash(encode(article.versions.map((v:any)=>v.contentHash))));
  return units;
}

export function buildReport(manifest:any,previous:any,validation:ValidationResult,env:NodeJS.ProcessEnv=process.env){
  let context:RunContext|undefined;
  if(env.LAW_RELEASE_CONTEXT){
    const value:unknown=JSON.parse(env.LAW_RELEASE_CONTEXT);validateContext(value);context=value;
    if(context.sourceAudit!==undefined&&context.sourceAudit!==sourceAuditMode(env))throw new Error('Report/source audit context mismatch.');
    if(context.rangeFrom!==manifest.rangeFrom||manifest.rangeTo!==(env.LAW_RELEASE_PHASE==='base'?context.rangeFrom:context.rangeTo)||
      manifest.officialSources?.observedOn!==context.observedOn)throw new Error('Report/frozen context mismatch.');
  }
  if(previous&&previous.jurisdiction!==manifest.jurisdiction)throw new Error('Report predecessor jurisdiction mismatch.');
  const current=documents(manifest),prior=previous?documents(previous):null;
  const units=selectedUnits(manifest),oldUnits=previous?selectedUnits(previous):null;
  const archives=manifest.acts.flatMap((a:any)=>a.sourceArchive?[a.sourceArchive]:[]);
  const changes=prior?{
    newDocuments:[...current.keys()].filter(k=>!prior.has(k)).length,
    changedTextDocuments:[...current].filter(([k,v])=>prior.has(k)&&prior.get(k)!.text!==v.text).length,
    metadataOnlyDocuments:[...current].filter(([k,v])=>prior.has(k)&&prior.get(k)!.text===v.text&&!isDeepStrictEqual(prior.get(k)!.metadata,v.metadata)).length,
    absentDocuments:[...prior.keys()].filter(k=>!current.has(k)).length,
    unchangedDocuments:[...current].filter(([k,v])=>isDeepStrictEqual(v,prior.get(k))).length,
  }:null;
  const warnings=archives.flatMap((a:any)=>a.warnings??[]);
  const measured=operationMetrics.snapshot().counters;
  const unitComparisons=manifest.acts.map((act:any)=>{
    const id=manifest.jurisdiction==='NL'?act.bwbId:act.celex;
    const old=previous?.acts.find((a:any)=>(manifest.jurisdiction==='NL'?a.bwbId:a.celex)===id);
    const currentEvidence=act.sourceArchive?.reportEvidence,priorEvidence=old?.sourceArchive?.reportEvidence;
    return {act:id,status:currentEvidence&&priorEvidence?'COMPARED':'NO_COMPARABLE_PREDECESSOR_EVIDENCE',
      delta:currentEvidence&&priorEvidence?compareSourceReportEvidence(currentEvidence,priorEvidence):null};
  });
  return {
    profile:'module-build-report-v1',jurisdiction:manifest.jurisdiction,
    identity:{releaseId:context?.releaseId??null,parentReleaseId:context?.parentReleaseId??null,baseId:context?.baseId??null,
      codeRevision:context?.codeRevision??env.LAW_UPDATER_REVISION??null,
      configSha256:context?.configSha256??null,scopeConfigSha256:manifest.configSha256??null,
      identityKind:'TECHNICAL_RUN_IDENTIFIERS',context:context?'PAIRED_FROZEN_CONTEXT':'STANDALONE_BUILD_NO_RELEASE_ID'},
    range:{from:manifest.rangeFrom,to:manifest.rangeTo,observedOn:manifest.officialSources?.observedOn??null},
    counts:{acts:manifest.acts.length,selectedTextDocuments:current.size,
      selectedNlArticles:manifest.jurisdiction==='NL'?units.size:null,
      selectedTextVersions:manifest.jurisdiction==='NL'?manifest.acts.reduce((n:number,a:any)=>n+(a.articles??[]).reduce((s:number,u:any)=>s+u.versions.length,0),0):current.size,
      archivedSourceEntries:archives.reduce((n:number,a:any)=>n+a.entryCount,0),
      sourceStructure:validation.sourceStructure??null},
    comparison:{baseline:prior?(context&&previous?.sourceReportComparison?.generationKind==='base'?'IMMUTABLE_BASE_AT_RANGE_START':
      context?.parentReleaseId?'LAST_PREFLIGHTED_RELEASE':'PREVIOUS_LOCAL_MANIFEST'):'NO_PREDECESSOR',
      predecessorEvidence:previous?.sourceReportComparison??null,
      documents:changes,
      selectedNlArticles:oldUnits&&manifest.jurisdiction==='NL'?{
        added:[...units.keys()].filter(k=>!oldUnits.has(k)).length,
        changedTextVersionSequences:[...units].filter(([k,v])=>oldUnits.has(k)&&oldUnits.get(k)!==v).length,
        absent:[...oldUnits.keys()].filter(k=>!units.has(k)).length}:null,
      sourceUnits:unitComparisons,
      nestedUnitDelta:'Only proven official identity scopes are compared; unresolved/ambiguous/unstructured observations remain explicit, never inferred from numbering or hashes',
      historicalCorrections:'Own source correction facts and CORR snapshots are compared separately; legal effects/dates remain UNRESOLVED'},
    warnings:{count:warnings.length,messages:warnings},
    sourceReview:{mode:sourceAuditMode(env),technicalAuditId:sourceAuditIdentity(env),status:validation.status==='PASS'?'COMPLETED':'NOT_COMPLETED',
      scope:'Complete configured catalog/history review in both modes; unconditional bypasses HTTP validators and parser cache. Not a claim of complete legal history.'},
    sourceAvailability:validation.sourceAvailability?.map(a=>({...a,
      content:validation.status!=='PASS'?'NOT_VALIDATED':a.profile==='LEGACY_UNCLASSIFIED'?'VALIDATED_CONTENT_ONLY':a.hasOfficialTextFallback?'COMPLETE_FALLBACK':
        a.issues.some(i=>i.classification==='SOURCE_UNAVAILABLE'&&i.representation==='Formex')?'VALIDATED_CONTENT_ONLY':'COMPLETE',
      scope:'Required selected text validation; issue classes describe their own representation/metadata scope, not complete legal history.'}))??null,
    criticalErrors:validation.status==='PASS'?0:validation.status==='FAIL'?1:null,
    errorRegistry:{scope:'Observed final validation failure; not a count of unknown documents or unobserved sources.',
      observed:validation.status==='FAIL'?[{stage:'FINAL_VALIDATION',message:validation.error??'Validation rejected the output'}]:[],
      complete:validation.status!=='PENDING',lifecycle:errorRegistryReference(),
      lifecycleScope:'Separate process receipts cover observed failures before and after build. A missing terminal receipt is incomplete evidence, never zero errors.'},
    searchFindings:{...sourceFindingCounts(validation.sourceAvailability),
      unknownDocuments:'NOT_COUNTABLE; no inference from a successful empty search'},
    discoverySemantics:{notFound:'No matching data observed in the successfully searched official catalog; no assertion that an unknown document exists.',
      failure:'Transport, pagination, identity or parsing failure is an incomplete search, never an empty result.',
      required:'Explicit configured identities and references observed in official records remain verifiable requirements.'},
    validation:{status:validation.status,checks:validation.checks,error:validation.error??null},
    publication:{status:'NOT_COMMITTED_BY_BUILD',
      commitEvidence:context?`checks/commits/${context.runId}.json`:null,
      completionEvidence:context?`checks/runs/${context.runId}.json`:null,
      sourceCheckEvidence:context?`checks/sources/${context.runId}.json`:null},
    backup:{status:'NOT_CONFIRMED_BY_BUILD',policy:'active + two previous generations; immutable base and resume data protected; reader grace72h'},
    reuse:{status:'MEASURED_BUILD_PHASE',
      sourceRevalidatedWithoutBody:measured.sourceNotModified,verifiedSourceCacheBytes:measured.sourceCacheReusedBytes,
      parserComputed:measured.parserComputed,verifiedParserCacheHits:measured.parserCacheHits,
      actsBuilt:measured.actsBuilt,verifiedCheckpointActs:measured.actsCheckpointReused,
      physicalGenerationSharing:'NONE; schema1 writes separately owned files under each generation',
      scope:'One module process through report construction; excludes parent/sibling processes, later uploads and cleanup. Counts are measured reuse, not evidence of a complete source review.'},
    scope:'Observed source structure and technical content differences; no inferred legal status, repeal or effective dates.',
  };
}

export function renderBuildReport(manifest:any,previous:any,validation:ValidationResult):string{
  // Escape fence characters in JSON strings so source warnings cannot close
  // the machine-readable block. JSON decoding preserves the original value.
  const json=JSON.stringify(buildReport(manifest,previous,validation),null,2).replace(/`/g,'\\u0060');
  return ['','## Dane wydania i porównanie źródeł','', '```json',json,'```',''].join('\n');
}
