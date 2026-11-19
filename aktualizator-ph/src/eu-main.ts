import {standaloneSourceFiles} from './public-incremental.js';
import {EU_COUNTRY_MODULES,euLanguageOrder,publicEuModules,unsupportedEuLanguages} from './eu-language.js';
import {assessPublicEuDocument} from './eu-applicability.js';
import {baselineEuAct} from './base-plan.js';
import {writeCorpusManifest} from './legal-manifest-files.js';
import type {EuLanguage} from './eu-language.js';
import * as fs from 'node:fs';
import {operationMetrics,registerProcessMetrics} from './operation-metrics.js';
import * as path from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { finalizeEu, euIndex, euReport } from './eu-output.js';
import { readPreviousManifest } from './output.js';
import { writeControlFile } from './final-file.js';
import { OfficialSources, sourceArchiveName } from './official-sources.js';
import type { SourceArchive } from './official-sources.js';
import { resolveRange, configFile } from './run-config.js';
import { persistCompletedAct, recordCheckpointResume } from './durable-checkpoint.js';
import {safeFailureMessage} from './drive-retry.js';
import { assertEuIntegrity } from './content-integrity.js';
import type { EuIntegrity } from './content-integrity.js';
import type { EuNavigation } from './eu-navigation.js';
import { discoverEuDocuments, discoverEuCaseDocuments, selectEuDocuments, createEuSourceLoader } from './eu-provider.js';
import {assertEuCaseCoverage} from './eu-case-scope.js';
import type {EuCaseCatalog} from './eu-case-scope.js';
import { runPool } from './concurrency.js';
import type { EuAct, EuDocument } from './eu-provider.js';
import { completeBuiltOutput } from './publication-validation.js';
import {ensureXmlValidation,closeXmlValidation,xmlValidationSummary,XmlValidationInfrastructureError} from './xml-validation.js';
import {validateCheckpointArchive} from './xml-archive-validation.js';
import {readEuCheckpointFiles,reusableEuCheckpointActs} from './eu-checkpoint.js';
import {parsedCacheStats} from './parsed-source-cache.js';
import {executionRevision} from './execution-revision.js';
import {sourceAuditCheckpointTag} from './source-audit.js';
import {assertWorkDirectory} from './work-directory.js';
import {withOperationErrors,setErrorPhase,inErrorPhase} from './operation-errors.js';
import {registerIncrementalPlan} from './incremental-plan.js';
import {legalPartName} from './legal-structure.js';
import type {LegalDraft} from './legal-structure.js';
import {EuDocumentUnavailable,EU_DISCOVERY_FALLBACK_ROLE} from './eu-provider.js';
import type {MissingEuDocument} from './eu-unavailable.js';
import {euDocumentHeader} from './eu-document-header.js';
import type {EuDocumentHeader} from './eu-document-header.js';

// The standalone module has no active country module. Paired Drive runs
// supply their own preexisting language policy via the release context.
if(process.env.LAW_PUBLIC_EU_MODULES===undefined&&!process.env.LAW_RELEASE_PHASE&&!process.env.LAW_RELEASE_CONTEXT)
  process.env.LAW_PUBLIC_EU_MODULES='';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
standaloneSourceFiles(ROOT);
const OUTPUT = path.join(process.env.LAW_PUBLIC_WORK_ROOT??ROOT, 'output-ue');
const CHECKPOINT = path.join(process.env.LAW_PUBLIC_CHECKPOINT_ROOT??ROOT, '.checkpoint-ue');
const digest = (s: string, algo = 'sha256') => createHash(algo).update(s).digest('hex');
interface SourceFile { name: string; md5: string; celex: string; part: number }
interface CompletedAct {
  discoveryIncomplete?:boolean;
  missingDocuments?:MissingEuDocument[];
  retrievalScope?:'full-act-and-case';caseCatalog?:EuCaseCatalog;
  sourceArchive?: SourceArchive;
  order: number; title: string; celex: string; documents: (EuDocument & {
    header?:EuDocumentHeader;
    language:EuLanguage;
    sourceUrl: string; sourceSha256: string; articleCount: number; textLength: number;
    integrity: EuIntegrity; navigation: EuNavigation; oversizedParts: number[];
    legalDraft?:LegalDraft;
  })[]; files: SourceFile[];
  excludedDocuments: import('./eu-language.js').EuLanguageExclusion[];
}

async function main(): Promise<void> {
  if(process.env.LAW_PUBLIC_INCREMENTAL==='1')process.env.LAW_PUBLIC_OPERATION_ID??=randomUUID();
  for(const directory of [OUTPUT,CHECKPOINT])assertWorkDirectory(directory);
  await ensureXmlValidation();
  const raw = process.env.LAW_RELEASE_PHASE==='base'&&process.env.LAW_SCOPE_EU_JSON
    ?process.env.LAW_SCOPE_EU_JSON:fs.readFileSync(configFile(ROOT, 'zakres-ue.json'), 'utf8');
  const config = JSON.parse(raw) as { schemaVersion: number; rangeFrom: string; language: string;
    source: unknown; policy: unknown; acts: EuAct[] };
  if (config.schemaVersion !== 1 || config.language !== 'EN' || !config.acts.length ||
    new Set(config.acts.map((a) => a.celex)).size !== config.acts.length ||
    config.acts.some((a, i) => a.order !== i + 1 || a.include !== 'full-document'||
      a.retrievalScope!==undefined&&a.retrievalScope!=='full-act-and-case')) {
    throw new Error('Invalid EU scope configuration.');
  }
  const {rangeFrom,rangeTo,observedOn}=resolveRange(ROOT);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rangeFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(rangeTo) || rangeFrom > rangeTo) {
    throw new Error('Invalid EU date range.');
  }
  const baseline=new Map<string,{archive:OfficialSources;documents:EuDocument[]}>();
  if(process.env.LAW_PUBLIC_PHASE==='BASE'){
    const planned:EuAct[]=[];
    await runPool(config.acts,4,async act=>{
      const archive=new OfficialSources('EU',act.celex,{from:rangeFrom,to:rangeTo,observedOn});
      const documents=await discoverEuDocuments(act,archive);
      if(documents.some(d=>d.role===EU_DISCOVERY_FALLBACK_ROLE))throw new Error('Baseline requires verified EU discovery.');
      const selection=baselineEuAct(act,documents,rangeTo);
      if(selection.act){planned.push(selection.act);baseline.set(act.celex,{archive,documents});}
    });
    if(!planned.length)throw new Error('No confirmed EU baseline acts.');
    config.acts=planned.sort((a,b)=>a.order-b.order);
    fs.writeFileSync(path.join(process.env.LAW_PUBLIC_WORK_ROOT!,'eu-base-scope.json'),JSON.stringify({acts:config.acts}));
  }
  const key = digest('official-sources-wemi-v3' + raw + rangeFrom + rangeTo + observedOn + executionRevision(ROOT)+':source-audit:'+sourceAuditCheckpointTag()+
    (process.env.LAW_PUBLIC_INCREMENTAL==='1'?':operation:'+process.env.LAW_PUBLIC_OPERATION_ID:''));
  setErrorPhase('CHECKPOINT');
  fs.mkdirSync(CHECKPOINT, { recursive: true });
  const statePath = path.join(CHECKPOINT, 'state.json');
  let completed: CompletedAct[] = [];
  if (fs.existsSync(statePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (state.key === key && Array.isArray(state.acts)){
        if(new Set(state.acts.map((a:CompletedAct)=>a.celex)).size!==state.acts.length)throw new Error('Duplicate checkpoint act.');
        // Validate the complete candidate before accepting any act or writing
        // a reuse receipt; this also catches collisions between two acts.
        readEuCheckpointFiles(CHECKPOINT,state.acts,config.acts);
        completed=reusableEuCheckpointActs(state.acts);
      }
    } catch { console.warn('EU checkpoint could not be read; rebuilding affected sources.'); }
  }
  const verified:CompletedAct[]=[];
  for(const act of completed){
    try{const files=readEuCheckpointFiles(CHECKPOINT,[act],config.acts);
      await validateCheckpointArchive(files.get(act.sourceArchive!.name)!,act.sourceArchive!,'EU',act.celex);verified.push(act);}
    catch(error){if(error instanceof XmlValidationInfrastructureError)throw error;console.warn(`EU XML checkpoint rejected for ${act.celex}; rebuilding from official sources.`);}
  }
  completed=verified;
  await recordCheckpointResume('EU',completed.map(a=>a.celex),key);
  operationMetrics.add('actsCheckpointReused',completed.length);
  if(completed.length)console.log(`EU resuming checkpoint with ${completed.length} completed act(s).`);
  const save = () => {
    fs.writeFileSync(statePath + '.tmp', JSON.stringify({ key, acts: completed }, null, 2) + '\n');
    fs.renameSync(statePath + '.tmp', statePath);
  };
  // A source is fetched/revalidated and parsed once per CELEX/include in this
  // process, including simultaneous requests from different scope entries.
  const loadSource=createEuSourceLoader(),modules=publicEuModules(),languages=euLanguageOrder();
  async function build(act: EuAct): Promise<CompletedAct> {
    setErrorPhase('SOURCE_DISCOVERY');
    let stage='CELLAR discovery';
    const planned=baseline.get(act.celex);
    const archive=planned?.archive??new OfficialSources('EU',act.celex,{from:rangeFrom,to:rangeTo,observedOn});
    try {
    const discovered = planned?.documents??await discoverEuDocuments(act,archive);
    let discoveryIncomplete=discovered.some(d=>d.role===EU_DISCOVERY_FALLBACK_ROLE);
    stage='document selection';
    const selected = selectEuDocuments(discovered, act, rangeFrom, rangeTo,'preferred');
    stage='formal case discovery';
    const expanded=act.retrievalScope==='full-act-and-case'&&!discoveryIncomplete?await discoverEuCaseDocuments(selected,rangeTo,archive):undefined;
    if(act.retrievalScope==='full-act-and-case'&&selected.some(d=>d.celex.startsWith('6'))&&!expanded)discoveryIncomplete=true;
    const documents=(expanded?.documents??selected).map(doc=>({...doc,...act.outputProfile?{outputProfile:act.outputProfile}:{}}));
    const result: CompletedAct = { order: act.order, title: act.title, celex: act.celex, documents: [], files: [],
      ...discoveryIncomplete?{discoveryIncomplete:true}:{},
      ...(act.retrievalScope?{retrievalScope:act.retrievalScope}:{}),...(expanded?{caseCatalog:expanded.catalog}:{}),
      excludedDocuments: discovered.filter((d) => !documents.some((selected) => selected.celex === d.celex)).map((d) => ({
        celex: d.celex, reason: d.metadata.available_language?.length &&
          !d.metadata.available_language.some((lang) => /\/(?:ENG|POL|NLD|FRA)$/.test(lang)) ?
          'No expression in supported language order EN, PL, NL, FR in official metadata.' :
          'Outside documentary date interval and not the required baseline version.',
      })) };
    for(const member of expanded?.catalog.members??[]){
      if(member.status==='NO_CELEX')throw new Error('A formal case member has no supported document identifier; case catalog retained for diagnosis.');
      if(member.status!=='INCLUDED'){
        const reason=member.status==='AFTER_RANGE'?'Case document lies after the run date.':'No case expression in EN, PL, NL, FR.';
        if(!result.excludedDocuments.some(d=>d.celex===member.celex))result.excludedDocuments.push({celex:member.celex!,reason});
        if(member.status==='NO_SUPPORTED_LANGUAGE')archive.warning(`Case document ${member.celex}: ${reason}`,{
          classification:'HISTORY_INCOMPLETE',code:'CASE_DOCUMENT_LANGUAGE_UNAVAILABLE',documentId:act.celex});
      }
    }
    for (const doc of documents) {
      if(modules&&unsupportedEuLanguages(doc.metadata.available_language??[],languages)){
        result.excludedDocuments.push({celex:doc.celex,reason:'SKIPPED_UNSUPPORTED_LANGUAGE',
          availableLanguages:doc.metadata.available_language,checkedLanguages:[...languages]});
        continue;
      }
      if(modules)doc.applicability=assessPublicEuDocument(doc.celex,modules.map(id=>EU_COUNTRY_MODULES[id].countryISO),doc.territorialObservations);
      setErrorPhase('SOURCE_BUILD');
      stage=`source ${doc.celex}`;
      let source;
      try{source=await loadSource(doc);}catch(error){
        if(!(error instanceof EuDocumentUnavailable))throw error;
        const missing:MissingEuDocument={profile:'eu-document-unavailable-v1',celex:doc.celex,document:doc,attempts:error.attempts};
        (result.missingDocuments??=[]).push(missing);
        const data=Buffer.from(JSON.stringify(missing));
        const url='https://publications.europa.eu/resource/celex/'+encodeURIComponent(doc.celex);
        archive.add('unavailable/'+doc.celex.replace(/[^A-Za-z0-9.-]/g,'_')+'.json',{bytes:data,url,contentType:'application/json'},url,'CELLAR-document-unavailable',{celex:doc.celex});
        archive.warning(`Document ${doc.celex} unavailable in ${languages.join(', ')}; remaining documents continue.`,{code:'DOCUMENT_UNAVAILABLE',classification:'SOURCE_UNAVAILABLE',documentId:doc.celex});
        console.warn(`DOCUMENT_UNAVAILABLE ${doc.celex}: ${languages.join(' -> ')}; processing continues.`);continue;
      }
      const parsed=source.parsed;
      if(!source.nativeSources?.length)throw new Error('Missing original EU source bytes.');
      for(const native of source.nativeSources)archive.add('documents/'+native.name,native.source,native.requestedUrl,native.kind,native.metadata);
      for(const warning of source.nativeWarnings??[]){
        const issues=source.nativeIssues?.filter(i=>i.message===warning);
        if(!issues?.length)throw new Error('Current EU source warning lacks an explicit classification.');
        for(const issue of issues)archive.warning(warning,issue);
      }
      const prefix=`${String(act.order).padStart(2,'0')}_${doc.celex.replace(/[^A-Za-z0-9.-]/g,'_')}_${source.language??'EN'}`;
      const names = parsed.chunks.map((_chunk, i) => parsed.legalDraft?legalPartName(prefix,parsed.legalDraft.chunks[i]):
        `${String(act.order).padStart(2, '0')}_${doc.celex.replace(/[^A-Za-z0-9.-]/g, '_')}__${String(i + 1).padStart(2, '0')}.md`);
      const resolved = {chunks:parsed.chunks,navigation:{sourceFragmentIssues:[] as string[]}};
      assertEuIntegrity(parsed.integrity, resolved.chunks.join(parsed.legalDraft?'':'\n'));
      if(!parsed.titleEvidence)throw new Error('EU parser lacks document title provenance; rebuild parsed cache.');
      result.documents.push({ ...doc,header:euDocumentHeader(parsed.titleEvidence,doc.celex,doc.metadata),...parsed.legalDraft?{legalDraft:parsed.legalDraft}:{}, language:source.language??'EN', sourceUrl: source.sourceUrl, sourceSha256: parsed.legalDraft?.sourceSha256??digest(source.html),
        articleCount: parsed.articleCount, textLength: resolved.chunks.reduce((n, chunk) => n + chunk.length, 0),
        integrity: parsed.integrity, navigation: resolved.navigation,
        oversizedParts: resolved.chunks.flatMap((chunk, i) => chunk.length > 80000 ? [i + 1] : []) });
      for (const [i, chunk] of resolved.chunks.entries()) {
        const name = names[i];
        const content = chunk;
        fs.writeFileSync(path.join(CHECKPOINT, name), content);
        result.files.push({ name, md5: digest(content, 'md5'), celex: doc.celex, part: i + 1 });
      }
    }
    setErrorPhase('CHECKPOINT');
    assertEuCaseCoverage(result,act);
    stage='source archive and local checkpoint';
    const native=archive.build(sourceArchiveName(act.order,act.celex));
    result.sourceArchive=native.metadata;fs.writeFileSync(path.join(CHECKPOINT,native.metadata.name),native.bytes);
    if ((!result.documents.length || !result.files.length)&&!result.missingDocuments?.length&&!result.excludedDocuments.some(d=>d.reason==='SKIPPED_UNSUPPORTED_LANGUAGE')) throw new Error(`Empty EU act: ${act.celex}`);
    return result;
    } catch(error) {
      archive.preserveDiagnostic(['CELLAR discovery','formal case discovery'].includes(stage)?'EU_DISCOVERY_FAILED':'EU_SOURCE_FAILED');
      const reason=safeFailureMessage(error,'source operation failed');
      throw new Error(`EU act ${act.celex} [${stage}]: ${reason}`);
    }
  }
  const pending = config.acts.filter((a) => !completed.some((d) => d.celex === a.celex));
  // Four workers keep the public source load bounded; checkpoint is committed per complete act.
  await runPool(pending,4,async act=>{
      console.log(`[UE ${config.acts.indexOf(act)+1}/${config.acts.length}] ${act.celex}`);
      await inErrorPhase('SOURCE_BUILD',async()=>{
        const built = await build(act);
        setErrorPhase('CHECKPOINT');
        operationMetrics.add('actsBuilt');completed.push(built); save(); await persistCompletedAct(ROOT,'EU');
        console.log(`UE VERIFIED ${act.celex}: ${built.documents.length} sources, ${built.files.length} files`);
      });
  });
  setErrorPhase('OUTPUT_WRITE');
  completed.sort((a,b) => a.order - b.order);
  if (completed.length !== config.acts.length) {
    throw new Error('EU checkpoint/output coverage is incomplete.');
  }
  const verifiedFiles=readEuCheckpointFiles(CHECKPOINT,completed,config.acts);
  const previous=readPreviousManifest(process.env.LAW_PUBLIC_WORK_ROOT?path.join(ROOT,'output-ue'):OUTPUT);
  const final=finalizeEu(completed,name=>verifiedFiles.get(name)!.toString('utf8'));
  fs.rmSync(OUTPUT,{recursive:true,force:true});fs.mkdirSync(OUTPUT,{recursive:true});
  for(const act of completed)fs.writeFileSync(path.join(OUTPUT,act.sourceArchive!.name),verifiedFiles.get(act.sourceArchive!.name)!);
  for(const file of final.files.values())fs.writeFileSync(path.join(OUTPUT,file.name),file.content);
  const manifest={schemaVersion:2,validationVersion:2,jurisdiction:'EU',generatedAt:process.env.LAW_GENERATED_AT ?? new Date().toISOString(),
    rangeFrom,rangeTo,language:'EN',languagePreference:[...languages],officialSources:{schemaVersion:1,model:'CELLAR',observedOn,originalBytes:true,view:'Markdown',...xmlValidationSummary()?{xmlValidation:xmlValidationSummary()}:{}},source:config.source,policy:config.policy,configSha256:digest(raw),normalization:final.normalization,acts:final.acts};
  writeControlFile(OUTPUT,'EU','INDEX.md',euIndex(manifest));
  writeCorpusManifest(OUTPUT,manifest);
  setErrorPhase('OUTPUT_VALIDATION');
  const files=completeBuiltOutput(OUTPUT,config.acts,result=>euReport(manifest,previous,result));
  console.log(`EU COMPLETE: ${completed.length} entries, ${files.length} final files, ${final.normalization.referenceCount} UE-REF.`);
  console.log(JSON.stringify({module:'EU',derivedCache:parsedCacheStats()}));

}

registerProcessMetrics('EU');
registerIncrementalPlan(ROOT,'EU');
withOperationErrors('EU',ROOT,async()=>{try{await main();}finally{closeXmlValidation();}})
  .catch((error) => { console.error('EU corpus build failed:', safeFailureMessage(error,'unknown error')); process.exitCode=1; });
