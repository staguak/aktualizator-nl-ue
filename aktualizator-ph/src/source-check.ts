import {isDeepStrictEqual} from 'node:util';
import {loadSourceArchive} from './official-sources.js';
import {comparableSourceIndex} from './source-index-comparison.js';
import type {SourceArchive} from './official-sources.js';
import {activeContext,preflight,retainOperationalHistory,validateContext,validateManifest} from './release-engine.js';
import type {RunContext} from './release-engine.js';
import {assertSettledPointerOperations} from './pointer-work.js';
import {encode,hash,readJson,writeJson} from './release-store.js';
import type {ReleaseStore} from './release-store.js';
import {sourceAuditMode} from './source-audit.js';

type Pair=Map<'NL'|'EU',Map<string,Buffer>>;
interface CheckJournal {schemaVersion:1;context:RunContext;expectedActiveSha256:string;recordSha256:string;record:Record<string,unknown>}

function materialManifest(value:any){
  return {...value,generatedAt:undefined,
    ...value.officialSources?{officialSources:{...value.officialSources,observedOn:undefined,xmlValidation:undefined}}:{},
    acts:value.acts.map((act:any)=>act.sourceArchive?{...act,sourceArchive:{...act.sourceArchive,md5:undefined,size:undefined}}:act)};
}
function materialCatalog(index:any){
  // Do not duplicate the potentially large expanded unit/RDF/WTI models.
  // All nested facts remain compared; only observation-clock wrappers differ.
  return {...index,range:{...index.range,observedOn:undefined},entries:index.entries.map((entry:any)=>({...entry,httpObservation:undefined}))};
}

// Equality of text is insufficient. Compare complete module models, discovery
// catalogs, representation metadata and every native source byte as well.
export async function unchangedSourceEvidence(store:ReleaseStore,context:RunContext,pair:Pair):Promise<Record<string,unknown>|null>{
  validateContext(context);if(context.mode!=='update')return null;
  const audit=sourceAuditMode();
  if(context.sourceAudit!==undefined&&context.sourceAudit!==audit)throw new Error('Source audit policy differs from frozen context.');
  const active=await preflight(store,'update',false),previous=await activeContext(store,active!);
  if(context.parentReleaseId!==active!.releaseId||context.parentOperationId!==active!.operationId||
    context.codeRevision!==previous.codeRevision||context.configSha256!==previous.configSha256||
    context.rangeFrom!==previous.rangeFrom||context.rangeTo!==previous.rangeTo)return null;
  const generation=await readJson(store,active!.manifestKey);validateManifest(generation);
  const evidence:unknown[]=[],indexComparisons:unknown[]=[];
  for(const module of ['NL','EU'] as const){
    const files=pair.get(module);if(!files?.has('manifest.json'))return null;
    const current=JSON.parse(files.get('manifest.json')!.toString());
    const priorFile=generation.files.find(f=>f.jurisdiction===module&&f.name==='manifest.json')!;
    const priorBytes=await store.read(priorFile.key);
    if(!priorBytes||hash(priorBytes)!==priorFile.sha256)throw new Error('Source-check predecessor manifest changed.');
    const prior=JSON.parse(priorBytes.toString());
    if(!isDeepStrictEqual(materialManifest(current),materialManifest(prior)))return null;
    const archives=new Set<string>(current.acts.map((a:any)=>a.sourceArchive?.name));
    const oldFiles=generation.files.filter(f=>f.jurisdiction===module);
    if(files.size!==oldFiles.length||oldFiles.some(f=>!files.has(f.name)))return null;
    const currentIndex=files.get('INDEX.md'),priorIndexFile=oldFiles.find(f=>f.name==='INDEX.md');
    if(!currentIndex||!priorIndexFile)throw new Error('Source-check index is missing.');
    const priorIndex=await store.read(priorIndexFile.key);
    if(!priorIndex||hash(priorIndex)!==priorIndexFile.sha256)throw new Error('Source-check predecessor index changed.');
    if(comparableSourceIndex(current,currentIndex)!==comparableSourceIndex(prior,priorIndex))return null;
    indexComparisons.push({module,previousSha256:priorIndexFile.sha256,currentSha256:hash(currentIndex),
      rule:'Exact generated indexes verified; source-archive MD5 excluded only from material comparison after full source-byte/catalog checks'});
    for(const file of oldFiles)if(!archives.has(file.name)&&!['manifest.json','REPORT.md','INDEX.md'].includes(file.name)&&hash(files.get(file.name)!)!==file.sha256)return null;
    for(const act of current.acts){
      const archive:SourceArchive=act.sourceArchive;if(!archive)return null;
      const id=module==='NL'?act.bwbId:act.celex;
      const currentArchive=loadSourceArchive(files.get(archive.name)!,archive,module,id);
      const priorAct=prior.acts.find((a:any)=>(module==='NL'?a.bwbId:a.celex)===id);
      const oldFile=oldFiles.find(f=>f.name===priorAct?.sourceArchive?.name);
      if(!oldFile)return null;
      const oldBytes=await store.read(oldFile.key);
      if(!oldBytes||hash(oldBytes)!==oldFile.sha256)throw new Error('Source-check predecessor source archive changed.');
      const oldArchive=loadSourceArchive(oldBytes,priorAct.sourceArchive,module,id);
      const index=currentArchive.index;
      if(index.discovery?.protocol!==(module==='NL'?'SRU-2.0':'CELLAR-SPARQL')||
        !isDeepStrictEqual(materialCatalog(index),materialCatalog(oldArchive.index)))return null;
      for(const entry of index.entries){
        const observation=entry.httpObservation,at=Date.parse(observation?.checkedAt);
        if(!observation||!Number.isFinite(at)||at<Date.parse(context.createdAt)||at>Date.now()||
          !(audit==='unconditional'?observation.status===200:[200,304].includes(observation.status))||
          observation.method!==(observation.status===304?'conditional-not-modified':'downloaded'))return null;
        const bytes=Buffer.from(currentArchive.items[entry.name]);
        if(!bytes.equals(Buffer.from(oldArchive.items[entry.name])))return null;
        evidence.push({module,act:id,archive:archive.name,entry:entry.name,kind:entry.kind,
          sourceSha256:hash(bytes),requestedUrl:entry.requestedUrl,url:entry.url,httpObservation:observation});
      }
    }
  }
  return {schemaVersion:1,status:'NO_CHANGE',operationId:context.runId,releaseId:active!.releaseId,
    predecessorOperationId:active!.operationId,manifestSha256:active!.manifestSha256,context,
    rangeFrom:context.rangeFrom,rangeTo:context.rangeTo,checkedThrough:context.rangeTo,
    sourceAudit:audit,
    coverage:'Completed configured source discovery and comparison; no broader legal-history claim.',
    evidence,indexComparisons,completedAt:new Date().toISOString()};
}

// A separate journal makes no-change receipt persistence and cleanup resumable.
// It never changes active.json or the immutable generation's range/observation.
export async function resumeSourceCheck(store:ReleaseStore):Promise<RunContext|null>{
  const value=await readJson(store,'work/source-check.json') as CheckJournal|null;if(value===null)return null;
  validateContext(value.context);
  if(value.schemaVersion!==1||value.context.mode!=='update'||value.record?.status!=='NO_CHANGE'||value.record.operationId!==value.context.runId||
    value.record.releaseId!==value.context.parentReleaseId||value.record.predecessorOperationId!==value.context.parentOperationId||
    value.record.checkedThrough!==value.context.rangeTo||!isDeepStrictEqual(value.record.context,value.context)||
    !Array.isArray(value.record.evidence)||!value.record.evidence.length||hash(encode(value.record))!==value.recordSha256||
    !/^[a-f0-9]{64}$/.test(value.expectedActiveSha256))throw new Error('Invalid source-check journal.');
  await assertSettledPointerOperations(store);
  if(await store.read('work/publication.json'))throw new Error('Publication and source check cannot run concurrently.');
  const active=await store.read('active.json');
  if(!active||hash(active)!==value.expectedActiveSha256)throw new Error('Source-check predecessor changed.');
  await preflight(store,'update',false);
  const context=await readJson(store,'work/context.json');
  if(context!==null&&!isDeepStrictEqual(context,value.context))throw new Error('Source-check cleanup refuses later work.');
  await writeJson(store,`checks/sources/${value.context.runId}.json`,value.record,true);
  await retainOperationalHistory(store);
  for(const key of await store.list('work/'))if(key!=='work/source-check.json')await store.remove(key);
  await store.remove('work/source-check.json');await store.removeEmptyDirectory?.('work/');return value.context;
}
export async function recordUnchangedSourceCheck(store:ReleaseStore,context:RunContext,pair:Pair):Promise<boolean>{
  const record=await unchangedSourceEvidence(store,context,pair);if(!record)return false;
  const active=await store.read('active.json');
  if(!active)throw new Error('Source-check predecessor disappeared.');
  const pointer=JSON.parse(active.toString());
  if(pointer.releaseId!==record.releaseId||pointer.operationId!==record.predecessorOperationId||pointer.manifestSha256!==record.manifestSha256)
    throw new Error('Source-check predecessor changed before recording.');
  await writeJson(store,'work/source-check.json',{schemaVersion:1,context,expectedActiveSha256:hash(active),recordSha256:hash(encode(record)),record} satisfies CheckJournal);
  return !!await resumeSourceCheck(store);
}
