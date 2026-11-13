import * as fs from 'node:fs';
import {operationMetrics,registerProcessMetrics} from './operation-metrics.js';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { finalizeEu, euIndex, euReport } from './eu-output.js';
import { stableJson, readPreviousManifest } from './output.js';
import { writeControlFile } from './final-file.js';
import { OfficialSources, sourceArchiveName } from './official-sources.js';
import type { SourceArchive } from './official-sources.js';
import { resolveRange, configFile } from './run-config.js';
import { persistCompletedAct, recordCheckpointResume } from './durable-checkpoint.js';
import {safeFailureMessage} from './drive-retry.js';
import { assertEuIntegrity } from './content-integrity.js';
import type { EuIntegrity } from './content-integrity.js';
import type { EuNavigation } from './eu-navigation.js';
import { discoverEuDocuments, selectEuDocuments, createEuSourceLoader } from './eu-provider.js';
import { runPool } from './concurrency.js';
import type { EuAct, EuDocument } from './eu-provider.js';
import { completeBuiltOutput } from './publication-validation.js';
import {ensureXmlValidation,closeXmlValidation,xmlValidationSummary,XmlValidationInfrastructureError} from './xml-validation.js';
import {validateCheckpointArchive} from './xml-archive-validation.js';
import {readEuCheckpointFiles} from './eu-checkpoint.js';
import {parsedCacheStats} from './parsed-source-cache.js';
import {executionRevision} from './execution-revision.js';
import {sourceAuditCheckpointTag} from './source-audit.js';
import {assertWorkDirectory} from './work-directory.js';
import {withOperationErrors,setErrorPhase,inErrorPhase} from './operation-errors.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'output-ue');
const CHECKPOINT = path.join(ROOT, '.checkpoint-ue');
const digest = (s: string, algo = 'sha256') => createHash(algo).update(s).digest('hex');
interface SourceFile { name: string; md5: string; celex: string; part: number }
interface CompletedAct {
  sourceArchive?: SourceArchive;
  order: number; title: string; celex: string; documents: (EuDocument & {
    language:'EN';
    sourceUrl: string; sourceSha256: string; articleCount: number; textLength: number;
    integrity: EuIntegrity; navigation: EuNavigation; oversizedParts: number[];
  })[]; files: SourceFile[];
  excludedDocuments: {celex: string; reason: string}[];
}

async function main(): Promise<void> {
  for(const directory of [OUTPUT,CHECKPOINT])assertWorkDirectory(directory);
  await ensureXmlValidation();
  const raw = process.env.LAW_RELEASE_PHASE==='base'&&process.env.LAW_SCOPE_EU_JSON
    ?process.env.LAW_SCOPE_EU_JSON:fs.readFileSync(configFile(ROOT, 'zakres-ue.json'), 'utf8');
  const config = JSON.parse(raw) as { schemaVersion: number; rangeFrom: string; language: string;
    source: unknown; policy: unknown; acts: EuAct[] };
  if (config.schemaVersion !== 1 || config.language !== 'EN' || !config.acts.length ||
    new Set(config.acts.map((a) => a.celex)).size !== config.acts.length ||
    config.acts.some((a, i) => a.order !== i + 1 || a.include !== 'full-document')) {
    throw new Error('Invalid EU scope configuration.');
  }
  const {rangeFrom,rangeTo,observedOn}=resolveRange(ROOT);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rangeFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(rangeTo) || rangeFrom > rangeTo) {
    throw new Error('Invalid EU date range.');
  }
  const key = digest('official-sources-wemi-v3' + raw + rangeFrom + rangeTo + observedOn + executionRevision(ROOT)+':source-audit:'+sourceAuditCheckpointTag());
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
        completed=state.acts;
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
  const loadSource=createEuSourceLoader();
  async function build(act: EuAct): Promise<CompletedAct> {
    setErrorPhase('SOURCE_DISCOVERY');
    let stage='CELLAR discovery';
    const archive=new OfficialSources('EU',act.celex,{from:rangeFrom,to:rangeTo,observedOn});
    try {
    const discovered = await discoverEuDocuments(act,archive);
    stage='document selection';
    const documents = selectEuDocuments(discovered, act, rangeFrom, rangeTo,'EN');
    const result: CompletedAct = { order: act.order, title: act.title, celex: act.celex, documents: [], files: [],
      excludedDocuments: discovered.filter((d) => !documents.some((selected) => selected.celex === d.celex)).map((d) => ({
        celex: d.celex, reason: d.metadata.available_language?.length &&
          !d.metadata.available_language.some((lang) => lang.endsWith('/ENG')) ?
          'No English expression in official metadata; outside configured source language.' :
          'Outside documentary date interval and not the required baseline version.',
      })) };
    for (const doc of documents) {
      setErrorPhase('SOURCE_BUILD');
      stage=`source ${doc.celex}`;
      const source=await loadSource(doc),parsed=source.parsed;
      if(!result.documents.length)result.title=parsed.sourceTitle||`CELEX ${act.celex}`;
      if(!source.nativeSources?.length)throw new Error('Missing original EU source bytes.');
      for(const native of source.nativeSources)archive.add('documents/'+native.name,native.source,native.requestedUrl,native.kind,native.metadata);
      for(const warning of source.nativeWarnings??[]){
        const issues=source.nativeIssues?.filter(i=>i.message===warning);
        if(!issues?.length)throw new Error('Current EU source warning lacks an explicit classification.');
        for(const issue of issues)archive.warning(warning,issue);
      }
      const names = parsed.chunks.map((_chunk, i) =>
        `${String(act.order).padStart(2, '0')}_${doc.celex.replace(/[^A-Za-z0-9.-]/g, '_')}__${String(i + 1).padStart(2, '0')}.md`);
      const resolved = {chunks:parsed.chunks,navigation:{sourceFragmentIssues:[] as string[]}};
      assertEuIntegrity(parsed.integrity, resolved.chunks.join('\n'));
      result.documents.push({ ...doc, language:'EN', sourceUrl: source.sourceUrl, sourceSha256: digest(source.html),
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
    stage='source archive and local checkpoint';
    const native=archive.build(sourceArchiveName(act.order,act.celex));
    result.sourceArchive=native.metadata;fs.writeFileSync(path.join(CHECKPOINT,native.metadata.name),native.bytes);
    if (!result.documents.length || !result.files.length) throw new Error(`Empty EU act: ${act.celex}`);
    return result;
    } catch(error) {
      archive.preserveDiagnostic(stage==='CELLAR discovery'?'EU_DISCOVERY_FAILED':'EU_SOURCE_FAILED');
      const reason=safeFailureMessage(error,'source operation failed');
      throw new Error(`EU act ${act.celex} [${stage}]: ${reason}`);
    }
  }
  const pending = config.acts.filter((a) => !completed.some((d) => d.celex === a.celex));
  // Four workers keep the public source load bounded; checkpoint is committed per complete act.
  await runPool(pending,4,async act=>{
      console.log(`[UE ${act.order}/${config.acts.length}] ${act.celex}`);
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
  const previous=readPreviousManifest(OUTPUT);
  const final=finalizeEu(completed,name=>verifiedFiles.get(name)!.toString('utf8'));
  fs.rmSync(OUTPUT,{recursive:true,force:true});fs.mkdirSync(OUTPUT,{recursive:true});
  for(const act of completed)fs.writeFileSync(path.join(OUTPUT,act.sourceArchive!.name),verifiedFiles.get(act.sourceArchive!.name)!);
  for(const file of final.files.values())fs.writeFileSync(path.join(OUTPUT,file.name),file.content);
  const manifest={schemaVersion:2,validationVersion:2,jurisdiction:'EU',generatedAt:process.env.LAW_GENERATED_AT ?? new Date().toISOString(),
    rangeFrom,rangeTo,language:'EN',officialSources:{schemaVersion:1,model:'CELLAR',observedOn,originalBytes:true,view:'Markdown',...xmlValidationSummary()?{xmlValidation:xmlValidationSummary()}:{}},source:config.source,policy:config.policy,configSha256:digest(raw),normalization:final.normalization,acts:final.acts};
  writeControlFile(OUTPUT,'EU','INDEX.md',euIndex(manifest));
  writeControlFile(OUTPUT,'EU','manifest.json',stableJson(manifest));
  setErrorPhase('OUTPUT_VALIDATION');
  const files=completeBuiltOutput(OUTPUT,config.acts,result=>euReport(manifest,previous,result));
  console.log(`EU COMPLETE: ${completed.length} entries, ${files.length} final files, ${final.normalization.referenceCount} UE-REF.`);
  console.log(JSON.stringify({module:'EU',derivedCache:parsedCacheStats()}));

}

registerProcessMetrics('EU');
withOperationErrors('EU',ROOT,async()=>{try{await main();}finally{closeXmlValidation();}})
  .catch((error) => { console.error('EU corpus build failed:', safeFailureMessage(error,'unknown error')); process.exitCode=1; });
