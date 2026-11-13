import fs from 'node:fs';
import {registerProcessMetrics,bindMetricsContext} from './operation-metrics.js';
import {measureStoreFootprint} from './store-footprint.js';
import {safeCacheDirectory} from './cache-directory.js';
import {comparisonManifest} from './comparison-manifest.js';
import {stableJson} from './output.js';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {google} from 'googleapis';
import {authorizeDrive} from './drive-auth.js';
import {DriveReleaseStore} from './drive-release-store.js';
import {buildModules} from './build-runner.js';
import {resolveRange,effectiveScopeJson,configFile} from './run-config.js';
import {assertPublicationAllowed} from './public-command.js';
import {baselineEuAct,baselineNlScope,baselineNlUnits} from './base-plan.js';
import {discoverVersions,fetchVersionSource,selectBwbVersions} from './sru.js';
import {parseNlSource} from './parsed-source-cache.js';
import {discoverEuDocuments} from './eu-provider.js';
import type {EuAct} from './eu-provider.js';
import type {ScopeConfig,VersionRecord} from './types.js';
import {OfficialSources,sourceArchiveName} from './official-sources.js';
import {runPool} from './concurrency.js';
import {validatedPublicationBytes,validatedPublicationSnapshot} from './publication-validation.js';
import {completedBuild,materializeCompletedOutputs} from './completed-build.js';
import type {PublicationInputs} from './completed-build.js';
import {validateCompletedBuildXml} from './completed-build-validation.js';
import {hash,encode,readJson,writeJson} from './release-store.js';
import {activeContext as getActiveContext,assertRangeProgression,resumeRunContext,assertInitializationBase,commitGeneration,newContext,preflight,prepareGeneration,rollbackGeneration,recoverGeneration,validateContext,validateManifest} from './release-engine.js';
import type {RunContext,ActivePointer} from './release-engine.js';
import {planningPart,exportPlanningDiagnostics} from './release-planning.js';
import {safeFailureMessage} from './drive-retry.js';
import {finalizePublishedRun,reconcilePendingPublication,loadProcessingCheckpoint,requestedRunDiffers} from './release-lifecycle.js';
import {ensureXmlValidation,closeXmlValidation} from './xml-validation.js';
import {recordUnchangedSourceCheck,resumeSourceCheck} from './source-check.js';
import {exportBaseEvidence} from './release-base-evidence.js';
import {verifyBaseResumeEvidence} from './base-resume-evidence.js';
import {baseCheckpointReadiness} from './base-checkpoint-readiness.js';
import {sourceAuditMode} from './source-audit.js';
import {exportCompletionEvidence,assertFinalizedRun} from './release-completion-evidence.js';
import {withOperationErrors,setErrorPhase,inErrorPhase,bindErrorContext} from './operation-errors.js';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
function configHash():string {
  return hash(Buffer.from(['aktualizator.json','zakres.json','zakres-ue.json'].map(n=>fs.readFileSync(configFile(ROOT,n),'utf8')).join('\n')));
}
let baseScopes:{NL:ScopeConfig;EU:{acts:EuAct[];[key:string]:unknown}}|undefined;
function targets(base=false){return (['NL','EU'] as const).map(jurisdiction=>({jurisdiction,
  dir:path.join(ROOT,jurisdiction==='NL'?'output':'output-ue'),
  acts:base&&baseScopes?baseScopes[jurisdiction].acts:JSON.parse(fs.readFileSync(configFile(ROOT,jurisdiction==='NL'?'zakres.json':'zakres-ue.json'),'utf8')).acts}));}
function inputs(base=false):Map<'NL'|'EU',Map<string,Buffer>>{
  return validatedPublicationBytes(targets(base));
}
async function main():Promise<void>{
  sourceAuditMode(); // Reject mistyped control before authentication/mutation.
  const namespace=process.env.LAW_RELEASE_NAMESPACE;
  if(!namespace)throw new Error('Set an explicitly audited release namespace.');
  const diagnosePlanning=process.argv.includes('--diagnose-planning');
  const diagnoseBase=process.argv.includes('--diagnose-base');
  const diagnoseFootprint=process.argv.includes('--diagnose-footprint');
  const diagnoseCompletion=process.argv.includes('--diagnose-completion');
  if([diagnosePlanning,diagnoseBase,diagnoseFootprint,diagnoseCompletion].filter(Boolean).length>1)throw new Error('Choose one read-only diagnostic.');
  if((diagnosePlanning||diagnoseBase||diagnoseFootprint||diagnoseCompletion)&&!/^release-test-corpus-\d+-\d+$/.test(namespace))throw new Error('Evidence export requires an isolated test corpus namespace.');
  const diagnoseAcceptance=process.argv.includes('--diagnose-acceptance');
  const checkpointReadiness=process.argv.includes('--test-checkpoints-ready');
  if((diagnoseAcceptance||checkpointReadiness)&&!/^release-test-corpus-\d+-\d+$/.test(namespace))throw new Error('Acceptance diagnostics require an isolated test corpus.');
  const readOnly=diagnoseAcceptance||checkpointReadiness||diagnosePlanning||diagnoseBase||diagnoseFootprint||diagnoseCompletion||process.argv.includes('--check')||process.argv.includes('--diagnose')||process.argv.includes('--test-interruption-recorded')||process.argv.includes('--test-resume-recorded');
  if(!namespace.startsWith('release-test-')&&!readOnly){
    assertPublicationAllowed(process.env);
    const approval=JSON.parse(fs.readFileSync(configFile(ROOT,'release-consumers.json'),'utf8'));
    if(approval.schemaVersion!==1||approval.namespace!==namespace||approval.approved!==true||
      !Array.isArray(approval.consumers)||!approval.consumers.length||approval.consumers.some((c:{verified?:boolean})=>c.verified!==true))
      throw new Error('Production cutover blocked: consumer audit is not complete.');
  }
  const mode=process.argv.includes('--initialize')?'initialize':'update';
  setErrorPhase('AUTHENTICATION');
  const auth=await authorizeDrive();
  setErrorPhase('STORAGE_OPEN');
  const store=await DriveReleaseStore.open(google.drive({version:'v3',auth}),namespace,mode==='initialize'&&!readOnly);
  setErrorPhase('DIAGNOSTIC');
  if(checkpointReadiness){
    const result=await baseCheckpointReadiness(store,process.env.LAW_UPDATER_REVISION??'',configHash());
    console.log(JSON.stringify(result));if(result.status==='NOT_READY')process.exitCode=3;return;
  }
  if(diagnoseAcceptance&&await store.read('work/context.json')===null){
    console.log(JSON.stringify(await exportCompletionEvidence(store,path.join(ROOT,'.source-diagnostics','completion'))));return;
  }
  if(diagnoseCompletion){console.log(JSON.stringify(await exportCompletionEvidence(store,path.join(ROOT,'.source-diagnostics','completion'))));return;}
  if(diagnoseFootprint){
    const dir=path.join(ROOT,'.source-diagnostics');
    if(!safeCacheDirectory(dir))throw new Error('Unsafe footprint evidence directory.');
    const report=await measureStoreFootprint(store);
    fs.mkdirSync(dir,{recursive:true});if(!safeCacheDirectory(dir))throw new Error('Unsafe footprint evidence directory.');
    fs.writeFileSync(path.join(dir,`store-footprint-${randomUUID()}.json`),encode(report),{flag:'wx'});
    console.log(JSON.stringify(report));return;
  }
  if(diagnoseBase){
    const report=await exportBaseEvidence(store,path.join(ROOT,'.source-diagnostics','base'),true);
    console.log(JSON.stringify(report));return;
  }
  if(diagnosePlanning||diagnoseAcceptance){
    const context=await readJson(store,'work/context.json') as RunContext;validateContext(context);
    const report=await exportPlanningDiagnostics(store,context,path.join(ROOT,'.source-diagnostics'));
    console.log(JSON.stringify({status:report.status,scope:'Read-only persisted isolated planning evidence',namespace,parts:report.records.length,codeRevision:context.codeRevision,
      rootFolder:await store.directoryUrl('/')}));return;
  }
  if(process.argv.includes('--test-interruption-recorded')){
    if(!/^release-test-corpus-\d+-\d+$/.test(namespace))throw new Error('Interruption diagnostics require an isolated test corpus.');
    for(const key of await store.list('checks/faults/')){
      const event=await readJson(store,key) as any;validateContext(event.context);
      if(event.schemaVersion===1&&event.module==='NL'&&event.phase==='base'&&event.completedActs>=2&&
        event.context.codeRevision===process.env.LAW_UPDATER_REVISION&&event.context.configSha256===configHash()){
        console.log('Verified prior isolated interruption record.');return;
      }
    }
    throw new Error('No confirmed checkpoint interruption.');
  }
  if(process.argv.includes('--diagnose')){
    const bytes=await store.read('active.json');
    const commits=[];
    for(const key of await store.list('checks/commits/')){
      const value=await readJson(store,key) as ActivePointer;
      commits.push({releaseId:value.releaseId,baseId:value.baseId,committedAt:value.committedAt});
    }
    console.log(JSON.stringify({namespace,activeSha256:bytes?hash(bytes):'missing',commits}));return;
  }
  if(process.argv.includes('--test-resume-recorded')){
    if(!/^release-test-corpus-\d+-\d+$/.test(namespace))throw new Error('Resume diagnostics require an isolated test corpus.');
    console.log(JSON.stringify(await verifyBaseResumeEvidence(store,process.env.LAW_UPDATER_REVISION??'',configHash())));
    console.log('Verified actual NL and complete EU checkpoint reuse from Drive.');return;
  }
  if(process.argv.includes('--check')){
    setErrorPhase('PREFLIGHT');
    const checked=await preflight(store,'update',process.argv.includes('--full'));
    if(process.argv.includes('--require-finalized'))await assertFinalizedRun(store,checked!);
    console.log('Previous paired Drive release PASS.');
    console.log(JSON.stringify({releaseId:checked!.releaseId,openFolder:checked!.openFolder}));return;
  }
  const recoveryTarget=process.argv.find(a=>a.startsWith('--recover='))?.slice('--recover='.length);
  if(recoveryTarget){
    setErrorPhase('RECOVERY');
    const expected=process.argv.find(a=>a.startsWith('--expected-active-sha256='))?.slice('--expected-active-sha256='.length);
    if(!expected||mode==='initialize')throw new Error('Recovery requires an explicit target and diagnosed active hash.');
    await recoverGeneration(store,recoveryTarget,expected);console.log('Explicit corruption recovery verified.');return;
  }
  const rollbackTarget=process.argv.find(a=>a.startsWith('--rollback='))?.slice('--rollback='.length);
  if(rollbackTarget&&mode==='initialize')throw new Error('Rollback cannot be combined with initialization.');
  if(rollbackTarget){
    setErrorPhase('ROLLBACK');
    const active=await preflight(store,'update',true);
    await rollbackGeneration(store,rollbackTarget,active!.releaseId);console.log('Explicit rollback verified.');return;
  }
  // Paired source processing requires the pinned validator. Read-only checks
  // and explicit pointer-only recovery do not need a Python runtime.
  setErrorPhase('RESUME');
  const completedCheck=await inErrorPhase('SOURCE_CHECK',()=>resumeSourceCheck(store));
  if(completedCheck){
    console.log('Pending no-change source check recorded and finalized; active pair unchanged.');
    if(!requestedRunDiffers(completedCheck,process.env,configHash()))return;
  }
  const reconciled=await inErrorPhase('FINALIZATION',()=>reconcilePendingPublication(store));
  if(reconciled){
    const finished=await getActiveContext(store,reconciled);
    console.log(`Pending publication finalized through ${finished.rangeTo} (revision ${finished.codeRevision}).`);
    if(!requestedRunDiffers(finished,process.env,configHash())){
      console.log(JSON.stringify({namespace,releaseId:reconciled.releaseId,openFolder:reconciled.openFolder}));return;
    }
    if(mode==='initialize')throw new Error('Frozen initialization completed; use release:update for the newly requested parameters.');
    console.log('Continuing with the requested range, revision or configuration.');
  }
  setErrorPhase('PREFLIGHT');
  const active=await preflight(store,mode,process.argv.includes('--full'));
  if(mode==='initialize')await store.write('README.md',Buffer.from('# Aktualizator — prawo NL i UE\n\nOtwórz active.json i użyj zawartego w nim odnośnika openFolder.\nW wybranym wydaniu znajdują się foldery NL i EU. Odczytuj oba z tego samego wydania.\nFolder base zachowuje stan początkowy, a work zawiera dane robocze.\n'),true);
  const range=resolveRange(ROOT),revision=process.env.LAW_UPDATER_REVISION;
  if(!revision)throw new Error('A code revision is required for durable runs.');
  const fresh=newContext({...range,baseId:active?.baseId??randomUUID(),parentReleaseId:active?.releaseId??null,...active?{parentOperationId:active.operationId}:{},
    codeRevision:revision,configSha256:configHash(),mode,sourceAudit:sourceAuditMode()});
  let context=fresh;
  const saved=await readJson(store,'work/context.json');
  if(saved!==null){
    validateContext(saved);
    context=resumeRunContext(saved,fresh,{LAW_RANGE_TO:process.env.LAW_RANGE_TO,LAW_OBSERVED_ON:process.env.LAW_OBSERVED_ON,LAW_SOURCE_AUDIT:process.env.LAW_SOURCE_AUDIT});
    if(context===fresh)console.log('Incompatible work context rejected; preparing a fresh run.');
  }
  process.env.LAW_SOURCE_AUDIT=context.sourceAudit??'conditional';
  if(active)assertRangeProgression(context,await getActiveContext(store,active));
  bindMetricsContext(context);
  bindErrorContext({...process.env,LAW_RELEASE_CONTEXT:JSON.stringify(context)});
  await assertInitializationBase(store,context);
  setErrorPhase('CHECKPOINT');
  process.env.LAW_XML_VALIDATION='required';await ensureXmlValidation();
  await writeJson(store,'work/context.json',context);
  await store.write('work/snapshots/.ready',Buffer.from('immutable snapshot objects\n'),true);
  await store.write('work/planning/.ready',Buffer.from('verified initial selection tasks\n'),true);
  await writeJson(store,'checks/resumes/.ready.json',{schemaVersion:1,role:'checkpoint-reuse-receipts'},true);
  if(mode==='initialize'){
    const baseKey=`base/${context.baseId}/release.json`,base=await readJson(store,baseKey);
    if(base===null){
      const baseInputs=await completedBuild(store,context,'base',async()=>{
        const plan=await inErrorPhase('BASE_PLANNING',()=>baselinePlan(context,store));baseScopes=plan.scopes;
        await build('base');const built=await inErrorPhase('OUTPUT_VALIDATION',()=>inputs(true)),extras=baselineExtras(plan);
        for(const j of ['NL','EU'] as const)for(const [name,bytes] of extras.get(j)!){
          if(built.get(j)!.has(name))throw new Error('Baseline evidence collides with a corpus file.');built.get(j)!.set(name,bytes);
        }
        return built;
      },async restored=>{
        const plan=await inErrorPhase('BASE_PLANNING',()=>baselinePlan(context,store,true));baseScopes=plan.scopes;
        await validateRestored(restored,true,baselineExtras(plan));
      });
      await inErrorPhase('PREPARE_GENERATION',()=>prepareGeneration(store,context,'base',baseInputs));
    }
    else{validateManifest(base);if(base.context.configSha256!==context.configSha256||base.context.rangeFrom!==context.rangeFrom)
      throw new Error('Existing base context conflicts with initialization.');}
  }
  let checkedBeforeFreeze=false,unchangedBeforeFreeze=false;
  const releaseInputs=await completedBuild(store,context,'release',async()=>{await build('release');return inErrorPhase('OUTPUT_VALIDATION',()=>inputs());},
    restored=>validateRestored(restored,false),async pair=>{
      checkedBeforeFreeze=true;unchangedBeforeFreeze=await inErrorPhase('SOURCE_CHECK',()=>recordUnchangedSourceCheck(store,context,pair));return unchangedBeforeFreeze;
    });
  if(unchangedBeforeFreeze||!checkedBeforeFreeze&&await inErrorPhase('SOURCE_CHECK',()=>recordUnchangedSourceCheck(store,context,releaseInputs))){
    console.log('Complete configured source check: no content, metadata or source change; active pair unchanged.');return;
  }
  const p=await inErrorPhase('PREPARE_GENERATION',()=>prepareGeneration(store,context,'release',releaseInputs));
  await inErrorPhase('COMMIT',()=>commitGeneration(store,p));
  await inErrorPhase('FINALIZATION',()=>finalizePublishedRun(store,context));
  console.log(`Paired release ${context.releaseId} verified and committed.`);
  setErrorPhase('PREFLIGHT');
  const committed=await preflight(store,'update',false);
  console.log(JSON.stringify({namespace,releaseId:committed!.releaseId,openFolder:committed!.openFolder,
    rootFolder:await store.directoryUrl('/')}));

  async function validateRestored(pair:PublicationInputs,base:boolean,extras?:PublicationInputs){
    setErrorPhase('OUTPUT_VALIDATION');
    await validateCompletedBuildXml(pair);
    const canonical=validatedPublicationSnapshot(targets(base).map(target=>{
      const files=new Map(pair.get(target.jurisdiction)!);
      for(const [name,expected] of extras?.get(target.jurisdiction)??[]){
        if(!files.get(name)?.equals(expected))throw new Error('Frozen baseline selection/source evidence differs from its persisted plan.');
        files.delete(name);
      }
      return {...target,files};
    }));
    materializeCompletedOutputs(ROOT,canonical);
  }
  function baselineExtras(plan:Awaited<ReturnType<typeof baselinePlan>>):PublicationInputs{
    return new Map((['NL','EU'] as const).map(j=>[j,new Map([
      ['BASE-SELECTION.json',Buffer.from(JSON.stringify(plan.evidence[j],null,2)+'\n')],...plan.catalogs[j]])]));
  }

  async function build(phase:'base'|'release'){
    setErrorPhase('CHECKPOINT');
    const restored=await Promise.all((['NL','EU'] as const).map(async module=>({module,saved:await loadProcessingCheckpoint(store,context,module,phase)})));
    for(const {module,saved} of restored){
      const dir=path.join(ROOT,module==='NL'?'.checkpoint':'.checkpoint-ue');
      fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});
      if(saved?.phase===phase)for(const [name,bytes] of saved.files){
        if(!name.startsWith(module+'/'))throw new Error('Checkpoint module mismatch.');
        const local=name.slice(module.length+1);
        const target=path.join(dir,module==='NL'&&local!=='state.json'?'output':'',local);
        fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);
      }
    }
    // Comparison input is always the verified predecessor, never leftover runner output.
    const previousKey=phase==='release'&&mode==='initialize'?`base/${context.baseId}/release.json`:active?.manifestKey;
    const previous=previousKey?await readJson(store,previousKey):null;
    for(const t of targets(phase==='base')){fs.rmSync(t.dir,{recursive:true,force:true});fs.mkdirSync(t.dir,{recursive:true});}
    if(previous){validateManifest(previous);
      for(const file of previous.files.filter(f=>f.name==='manifest.json')){
        const comparison=await comparisonManifest(store,previous,file.jurisdiction);
        fs.writeFileSync(path.join(ROOT,file.jurisdiction==='NL'?'output':'output-ue','manifest.json'),stableJson(comparison));
      }
    }
    setErrorPhase('MODULE_BUILD');
    await buildModules([fileURLToPath(new URL('./update.ts',import.meta.url))],{...process.env,
      LAW_RANGE_FROM:context.rangeFrom,LAW_RANGE_TO:phase==='base'?context.rangeFrom:context.rangeTo,
      LAW_OBSERVED_ON:context.observedOn,LAW_GENERATED_AT:context.createdAt,
      LAW_RELEASE_CONTEXT:JSON.stringify(context),LAW_RELEASE_PHASE:phase,LAW_RELEASE_NAMESPACE:namespace,
      LAW_SCOPE_NL_JSON:phase==='base'?effectiveScopeJson(baseScopes!.NL):undefined,
      LAW_SCOPE_EU_JSON:phase==='base'?effectiveScopeJson(baseScopes!.EU):undefined});
    setErrorPhase('CHECKPOINT');
  }
}
async function baselinePlan(context:RunContext,store:DriveReleaseStore,restoreOnly=false){
  const complete=await planningPart(store,context,'combined-plan','NL-EU',async()=>{
  if(restoreOnly)throw new Error('Completed baseline snapshot requires its original persisted selection plan; source re-fetch is forbidden.');
  const nl:ScopeConfig=JSON.parse(fs.readFileSync(configFile(ROOT,'zakres.json'),'utf8'));
  const eu=JSON.parse(fs.readFileSync(configFile(ROOT,'zakres-ue.json'),'utf8')) as {acts:EuAct[];[key:string]:unknown};
  const versions=new Map<string,VersionRecord[]>(),catalogs={NL:new Map<string,Buffer>(),EU:new Map<string,Buffer>()};
  const observations={from:context.rangeFrom,to:context.rangeFrom,observedOn:context.observedOn};
  await runPool(nl.acts,4,async act=>{
    const part=await planningPart(store,context,'nl-discovery',act.bwbId,async()=>{
      const archive=new OfficialSources('NL',act.bwbId,observations);
      const value=await discoverVersions(act.bwbId,archive),native=archive.build(`000_${act.bwbId}.sources.zip`);
      return {value,archives:new Map([[native.metadata.name,native.bytes]])};
    });
    versions.set(act.bwbId,part.value);for(const [name,bytes] of part.archives)catalogs.NL.set(name,bytes);
  });
  const n=baselineNlScope(nl,versions,context.rangeFrom,context.observedOn);
  const unitEvidence:unknown[]=[];
  await runPool(n.config.acts,4,async act=>{
    const part=await planningPart(store,context,'nl-units',act.bwbId,async()=>{
      const archive=new OfficialSources('NL',act.bwbId,observations);
      const selected=selectBwbVersions(versions.get(act.bwbId)!,context.rangeFrom,context.rangeFrom,context.observedOn);
      const snapshots=[];
      for(const state of selected)snapshots.push(parseNlSource(await fetchVersionSource(state.toestandUrl,archive,state)));
      const units=baselineNlUnits(act,snapshots),native=archive.build(`001_${act.bwbId}.sources.zip`);
      return {value:{act:units.act,evidence:{...units.evidence,states:selected}},archives:new Map([[native.metadata.name,native.bytes]])};
    });
    n.config.acts[n.config.acts.findIndex(a=>a.bwbId===act.bwbId)]=part.value.act;
    unitEvidence.push(part.value.evidence);
    for(const [name,bytes] of part.archives)catalogs.NL.set(name,bytes);
  });
  const selections=new Map<number,ReturnType<typeof baselineEuAct>>();
  await runPool(eu.acts,4,async act=>{
    const part=await planningPart(store,context,'eu-discovery',act.celex,async()=>{
      const archive=new OfficialSources('EU',act.celex,observations),value=await discoverEuDocuments(act,archive);
      const native=archive.build(sourceArchiveName(0,act.celex));
      return {value,archives:new Map([[native.metadata.name,native.bytes]])};
    });
    selections.set(act.order,baselineEuAct(act,part.value,context.rangeFrom));
    for(const [name,bytes] of part.archives)catalogs.EU.set(name,bytes);
  });
  const results=[...selections.entries()].sort(([a],[b])=>a-b).map(([,result])=>result);
  const acts=results.flatMap(r=>r.act?[r.act]:[]).map((act,i)=>({...act,order:i+1}));
  if(!acts.length)throw new Error('No confirmed EU baseline acts.');
  unitEvidence.sort((a:any,b:any)=>a.bwbId.localeCompare(b.bwbId));
  const scopes={NL:n.config,EU:{...eu,acts}},evidence={NL:{states:n.evidence,units:unitEvidence},EU:results.map(r=>r.evidence)};
  const archives=new Map<string,Buffer>();
  for(const j of ['NL','EU'] as const)for(const [name,bytes] of [...catalogs[j]].sort(([a],[b])=>a.localeCompare(b)))
    archives.set(`${j}__${name}`,bytes);
  return {value:{scopes,evidence},archives};
  });
  const catalogs={NL:new Map<string,Buffer>(),EU:new Map<string,Buffer>()};
  for(const [name,bytes] of complete.archives){
    const match=name.match(/^(NL|EU)__([A-Za-z0-9_.-]+)$/);
    if(!match)throw new Error('Invalid combined planning archive identity.');
    catalogs[match[1] as 'NL'|'EU'].set(match[2],bytes);
  }
  if(!catalogs.NL.size||!catalogs.EU.size)throw new Error('Incomplete combined planning evidence.');
  return {...complete.value,catalogs};
}
registerProcessMetrics('release');
withOperationErrors('release',ROOT,async()=>{try{await main();}finally{closeXmlValidation();}}).catch(error=>{
  // Google request objects may contain tokens; never dump raw SDK errors.
  console.error(safeFailureMessage(error,'Release operation failed.'));process.exitCode=1;
});
