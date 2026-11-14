import * as fs from 'node:fs';
import {operationMetrics,registerProcessMetrics} from './operation-metrics.js';
import * as path from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {parseNlSource,parseNlLegalSource,parsedCacheStats} from './parsed-source-cache.js';
import {executionRevision} from './execution-revision.js';
import {sourceAuditCheckpointTag} from './source-audit.js';
import {assertWorkDirectory} from './work-directory.js';
import { discoverVersions, fetchVersionSource, fetchBwbAuxiliary, selectBwbVersions } from './sru.js';
import { OfficialSources } from './official-sources.js';
import { resolveRange, configFile } from './run-config.js';
import { persistCompletedAct, recordCheckpointResume } from './durable-checkpoint.js';
import { renderNlModel } from './render.js';
import {incrementalNlModel} from './incremental-model.js';
import {registerIncrementalPlan} from './incremental-plan.js';
import { nlActManifest, nlIndex, nlReport } from './nl-output.js';
import type { NlActManifest } from './nl-output.js';
import { stableJson, readPreviousManifest } from './output.js';
import { writeControlFile } from './final-file.js';
import {safeFailureMessage} from './drive-retry.js';
import {readNlCheckpointFiles,installCheckpointFiles} from './nl-checkpoint.js';
import {ensureXmlValidation,closeXmlValidation,xmlValidationSummary,XmlValidationInfrastructureError} from './xml-validation.js';
import {validateCheckpointArchive} from './xml-archive-validation.js';
import { completeBuiltOutput } from './publication-validation.js';
import type { ScopeConfig, VersionRecord, VersionSnapshot } from './types.js';
import {withOperationErrors,setErrorPhase,inErrorPhase} from './operation-errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
let RUN_RANGE:ReturnType<typeof resolveRange>;
const CONFIG_PATH = configFile(ROOT, 'zakres.json');
const OUTPUT_DIR = path.join(process.env.LAW_PUBLIC_WORK_ROOT??ROOT, 'output');
const CHECKPOINT_DIR = path.join(ROOT, '.checkpoint');
const CHECKPOINT_OUTPUT_DIR = path.join(CHECKPOINT_DIR, 'output');
const CHECKPOINT_STATE_PATH = path.join(CHECKPOINT_DIR, 'state.json');

function readConfig(): { config: ScopeConfig; configSha256: string } {
  const raw = process.env.LAW_RELEASE_PHASE==='base'&&process.env.LAW_SCOPE_NL_JSON
    ?process.env.LAW_SCOPE_NL_JSON:fs.readFileSync(CONFIG_PATH, 'utf8');
  return {
    config: JSON.parse(raw) as ScopeConfig,
    configSha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
  };
}

function today(): string {
  return RUN_RANGE.observedOn;
}

function md5(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex');
}

type CheckpointAct = NlActManifest;

interface CheckpointState {
  schemaVersion: 2;
  rangeFrom: string;
  rangeTo: string;
  configSha256: string;
  revision: string;
  completedActs: CheckpointAct[];
}

function freshCheckpoint(
  rangeFrom: string,
  rangeTo: string,
  configSha256: string,
  revision: string,
): CheckpointState {
  return {
    schemaVersion: 2,
    rangeFrom,
    rangeTo,
    configSha256,
    revision,
    completedActs: [],
  };
}

function resetCheckpointProgress(): void {
  fs.rmSync(CHECKPOINT_OUTPUT_DIR, { recursive: true, force: true });
  fs.rmSync(CHECKPOINT_STATE_PATH, { force: true });
  fs.mkdirSync(CHECKPOINT_OUTPUT_DIR, { recursive: true });
}

function checkpointMatches(
  state: CheckpointState,
  rangeFrom: string,
  rangeTo: string,
  configSha256: string,
  revision: string,
): boolean {
  return (
    state.schemaVersion === 2 &&
    state.rangeFrom === rangeFrom &&
    state.rangeTo === rangeTo &&
    state.configSha256 === configSha256 &&
    state.revision === revision
  );
}

async function loadCheckpoint(
  config: ScopeConfig,
  rangeFrom: string,
  rangeTo: string,
  configSha256: string,
  revision: string,
): Promise<CheckpointState> {
  fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
  fs.mkdirSync(CHECKPOINT_OUTPUT_DIR, { recursive: true });

  if (!fs.existsSync(CHECKPOINT_STATE_PATH)) {
    return freshCheckpoint(rangeFrom, rangeTo, configSha256, revision);
  }

  try {
    const state = JSON.parse(
      fs.readFileSync(CHECKPOINT_STATE_PATH, 'utf8'),
    ) as CheckpointState;

    if (!checkpointMatches(state, rangeFrom, rangeTo, configSha256, revision)) {
      console.warn('Checkpoint does not match this range/config/revision; starting fresh progress.');
      resetCheckpointProgress();
      return freshCheckpoint(rangeFrom, rangeTo, configSha256, revision);
    }

    const files=readNlCheckpointFiles(CHECKPOINT_OUTPUT_DIR,state.completedActs,config);
    for(const act of state.completedActs)await validateCheckpointArchive(files.get(act.sourceArchive!.name)!,act.sourceArchive!,'NL',act.bwbId);
    installCheckpointFiles(OUTPUT_DIR,files);

    if (state.completedActs.length > 0) {
      console.log(
        'Resuming checkpoint with ' + state.completedActs.length + ' completed act(s).',
      );
    }
    return state;
  } catch (error) {
    if(error instanceof XmlValidationInfrastructureError)throw error;
    console.warn(
      'Checkpoint is unusable; keeping HTTP cache but restarting progress: ' +
        (error instanceof Error ? error.message : String(error)),
    );
    resetCheckpointProgress();cleanOutput();
    return freshCheckpoint(rangeFrom, rangeTo, configSha256, revision);
  }
}

function saveCheckpoint(
  state: CheckpointState,
  completed: CheckpointAct,
  chunks: import('./types.js').RenderedChunk[],
): void {
  fs.mkdirSync(CHECKPOINT_OUTPUT_DIR, { recursive: true });

  for (const chunk of chunks) {
    const target = path.join(CHECKPOINT_OUTPUT_DIR, chunk.fileName);
    const temp = target + '.tmp';
    fs.writeFileSync(temp, chunk.file.content);
    fs.renameSync(temp, target);
  }

  state.completedActs = state.completedActs
    .filter((act) => act.bwbId !== completed.bwbId)
    .concat(completed)
    .sort((a, b) => a.order - b.order);

  const tempState = CHECKPOINT_STATE_PATH + '.tmp';
  fs.writeFileSync(tempState, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tempState, CHECKPOINT_STATE_PATH);
}

async function fetchSnapshots(
  act: ScopeConfig['acts'][number],
  versions: VersionRecord[],
  archive: OfficialSources,
): Promise<VersionSnapshot[]> {
  const snapshots: VersionSnapshot[] = [];
  const bwbId=act.bwbId;

  for (const version of versions) {
    process.stdout.write(`  ${version.key} ... `);
    const source = await fetchVersionSource(version.toestandUrl, archive, version);
    const statute = parseNlSource(source);

    if (statute.bwbId && statute.bwbId !== bwbId) {
      throw new Error(
        `${version.toestandUrl} returned ${statute.bwbId}, expected ${bwbId}`,
      );
    }
    if (statute.provisions.length === 0) {
      throw new Error(`No provisions parsed for ${bwbId} at ${version.key}`);
    }

    const sourceSha256=source.sha256??createHash('sha256').update(source.bytes).digest('hex');
    const legalDraft=act.outputProfile==='legal-structure-v1'?parseNlLegalSource(source,{corpus:'NL',documentId:bwbId,version:version.key,language:'NL',
      sourceUrl:source.url,sourceSha256,metadata:{sourceState:version}}):undefined;
    snapshots.push({ version, statute,sourceSha256,...legalDraft?{legalDraft}:{}});
    console.log(`${statute.provisions.length} articles`);
  }

  return snapshots;
}

async function buildAct(
  act: ScopeConfig['acts'][number],
  rangeFrom: string,
  rangeTo: string,
): Promise<{
  discoveredVersions: number;
  rendered: ReturnType<typeof renderNlModel>;
  native: ReturnType<OfficialSources['build']>;
}> {
  const archive = new OfficialSources('NL',act.bwbId,{from:rangeFrom,to:rangeTo,observedOn:today()});
  setErrorPhase('SOURCE_DISCOVERY');
  const allVersions = await discoverVersions(act.bwbId,archive);
  if (allVersions.length === 0) {
    throw new Error('No BWB versions discovered for ' + act.bwbId);
  }

  const selected = selectBwbVersions(allVersions, rangeFrom, rangeTo, today(),archive);
  console.log(
    '  SRU versions: ' + allVersions.length + '; selected: ' + selected.length,
  );

  setErrorPhase('SOURCE_BUILD');
  const snapshots = await fetchSnapshots(act, selected, archive);
  const model = incrementalNlModel(ROOT,act, snapshots, rangeFrom, rangeTo);

  if (
    model.missingArticles.length > 0 ||
    model.missingStructures.length > 0
  ) {
    throw new Error(
      'Scope validation incomplete for ' +
        act.bwbId +
        ': missing articles=[' +
        model.missingArticles.join(', ') +
        ']; empty structures=[' +
        model.missingStructures.join(', ') +
        ']',
    );
  }

  await fetchBwbAuxiliary(selected.at(-1)!,archive);
  return { discoveredVersions: allVersions.length, rendered: renderNlModel(model),
    native:archive.build(`${String(act.order).padStart(2,'0')}_${act.bwbId}.sources.zip`) };
}

function cleanOutput(): void {
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function main(): Promise<void> {
  RUN_RANGE=resolveRange(ROOT);
  if(process.env.LAW_PUBLIC_INCREMENTAL==='1')process.env.LAW_PUBLIC_OPERATION_ID??=randomUUID();
  for(const directory of [OUTPUT_DIR,CHECKPOINT_DIR,CHECKPOINT_OUTPUT_DIR])assertWorkDirectory(directory);
  await ensureXmlValidation();
  const { config, configSha256 } = readConfig();
  const {rangeFrom,rangeTo} = RUN_RANGE;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(rangeFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(rangeTo)) {
    throw new Error('LAW_RANGE_FROM/LAW_RANGE_TO must use YYYY-MM-DD');
  }
  if (rangeFrom > rangeTo) throw new Error('rangeFrom is after rangeTo');

  setErrorPhase('CHECKPOINT');
  const previous = readPreviousManifest(process.env.LAW_PUBLIC_WORK_ROOT?path.join(ROOT,'output'):OUTPUT_DIR);
  cleanOutput();
  const revision = 'official-sources-v2:' + today() + ':' + executionRevision(ROOT)+':source-audit:'+sourceAuditCheckpointTag()+
    (process.env.LAW_PUBLIC_INCREMENTAL==='1'?':operation:'+process.env.LAW_PUBLIC_OPERATION_ID:'');
  const checkpoint = await loadCheckpoint(
    config,
    rangeFrom,
    rangeTo,
    configSha256,
    revision,
  );
  const completedByBwb = new Map(
    checkpoint.completedActs.map((act) => [act.bwbId, act] as const),
  );
  await recordCheckpointResume('NL',[...completedByBwb.keys()],configSha256);
  operationMetrics.add('actsCheckpointReused',completedByBwb.size);

  const manifest = {
    schemaVersion: 2, validationVersion: 2, jurisdiction: 'NL', configSha256,
    generatedAt: process.env.LAW_GENERATED_AT ?? new Date().toISOString(), rangeFrom, rangeTo,
    source: config.source, normalization: {encoding:'UTF-8',newlines:'LF',finalNewline:1,
      ...config.acts.some(a=>a.outputProfile==='legal-structure-v1')?{outputProfile:'legal-structure-v1',boundaries:'Source structure; separate versions; technical size protection only'}:{targetMaxFileSize:50_000}},
    officialSources:{schemaVersion:1,model:'BWB',protocol:'SRU-2.0',observedOn:today(),originalBytes:true,view:'Markdown'},
    acts: [] as NlActManifest[],
  };
  for (const act of [...config.acts].sort((a,b)=>a.order-b.order)) {
    const cached = completedByBwb.get(act.bwbId);
    if (cached) { manifest.acts.push(cached); continue; }
    console.log(`\n[${act.order}/${config.acts.length}] ${act.title} (${act.bwbId})`);
    const {discoveredVersions, rendered, native} = await inErrorPhase('SOURCE_BUILD',()=>buildAct(act,rangeFrom,rangeTo));
    setErrorPhase('OUTPUT_WRITE');
    operationMetrics.add('actsBuilt');
    for (const c of rendered.chunks) fs.writeFileSync(path.join(OUTPUT_DIR,c.fileName),c.file.content);
    fs.writeFileSync(path.join(OUTPUT_DIR,native.metadata.name),native.bytes);
    fs.writeFileSync(path.join(CHECKPOINT_OUTPUT_DIR,native.metadata.name),native.bytes);
    const record = {...nlActManifest(rendered,discoveredVersions),sourceArchive:native.metadata};
    manifest.acts.push(record);
    setErrorPhase('CHECKPOINT');
    saveCheckpoint(checkpoint,record,rendered.chunks);
    await persistCompletedAct(ROOT,'NL');
  }
  setErrorPhase('OUTPUT_WRITE');
  Object.assign(manifest.officialSources,xmlValidationSummary()?{xmlValidation:xmlValidationSummary()}:{});
  writeControlFile(OUTPUT_DIR,'NL','INDEX.md',nlIndex(manifest));
  writeControlFile(OUTPUT_DIR,'NL','manifest.json',stableJson(manifest));
  setErrorPhase('OUTPUT_VALIDATION');
  completeBuiltOutput(OUTPUT_DIR,config.acts,result=>nlReport(manifest,previous,result));
  console.log(`NL COMPLETE: ${manifest.acts.length} acts, ${fs.readdirSync(OUTPUT_DIR).length} final files.`);
  console.log(JSON.stringify({module:'NL',derivedCache:parsedCacheStats()}));

}

registerProcessMetrics('NL');
registerIncrementalPlan(ROOT,'NL');
withOperationErrors('NL',ROOT,async()=>{try{await main();}finally{closeXmlValidation();}}).catch((error) => {
  console.error(safeFailureMessage(error,'NL corpus build failed.'));
  process.exitCode=1;
});
