/** Build the shared public corpus without loading any Drive credentials. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {buildModules} from './build-runner.js';
import {configFile,resolveRange} from './run-config.js';
import {validatedPublicationBytes} from './publication-validation.js';
import {withOperationErrors,setErrorPhase} from './operation-errors.js';
import {hash} from './release-store.js';
import {PublicBuildError,independentAuditError,recordPublicBuildFailure} from './public-build-errors.js';
import type {PublicBuildStage} from './public-build-errors.js';
import {publicIncrementalEnvironment,warmPublicSources,recoverPublicOutputs,promotePublicOutputs} from './public-incremental.js';
import {sourceAuditMode} from './source-audit.js';
import {publicPreflight} from './public-preflight.js';
import {runPublicBuildPhases} from './public-build-phases.js';
import {safeCacheDirectory} from './cache-directory.js';
import {finalizePackageImages} from './package-images.js';

const root=fileURLToPath(new URL('../',import.meta.url));
let stage:PublicBuildStage='CONFIGURATION';
async function main(){
  if(process.argv.length!==2)throw new PublicBuildError('BUILD_ARGUMENT_INVALID');
  if(process.env.GOOGLE_DRIVE_OAUTH_JSON||process.env.LAW_CONFIG_JSON||process.env.LAW_RELEASE_CONTEXT||
    process.env.LAW_CONFIG_DIR||process.env.GH_TOKEN||process.env.GITHUB_TOKEN)
    throw new PublicBuildError('PRIVATE_CREDENTIALS_FORBIDDEN');
  recoverPublicOutputs(root);
  const range=resolveRange(root),env=publicIncrementalEnvironment(root,{...process.env,LAW_XML_VALIDATION:'required',
    LAW_PUBLIC_OPERATION_ID:process.env.GITHUB_RUN_ID, LAW_RANGE_FROM:range.rangeFrom,LAW_RANGE_TO:range.rangeTo,LAW_OBSERVED_ON:range.observedOn});
  Object.assign(process.env,env);
  if(sourceAuditMode(env)!=='unconditional')console.log(JSON.stringify(warmPublicSources(root,env.LAW_SOURCE_CACHE_DIR!)));
  const state=path.join(root,'.public-state');
  fs.mkdirSync(state,{recursive:true});
  const preflight=await publicPreflight(state,env.LAW_SOURCE_CACHE_DIR!,range);
  if(preflight)console.log(JSON.stringify({phase:'PREFLIGHT',...preflight}));
  if(preflight?.status==='NO_CHANGE')return;
  await runPublicBuildPhases(env.LAW_PUBLIC_INITIALIZE==='true',range.rangeFrom,range.rangeTo,async(phase,to)=>{
    const work=path.join(state,phase==='BASE'?'base':'build');
    if(!safeCacheDirectory(work))throw new Error('Unsafe phase work directory.');
    const phaseEnv={...env,LAW_PUBLIC_SOURCE_FILES:'1',LAW_PUBLIC_EU_MODULES:'NL',LAW_PUBLIC_WORK_ROOT:work,LAW_RANGE_TO:to,
      LAW_PUBLIC_PHASE:phase,LAW_PUBLIC_CHECKPOINT_ROOT:path.join(env.LAW_SOURCE_CACHE_DIR!,'models','0','public-checkpoints',hash(Buffer.from(JSON.stringify([env.LAW_PUBLIC_OPERATION_ID,range,to,env.LAW_UPDATER_REVISION,sourceAuditMode(env)]))),phase),LAW_XML_DIAGNOSTICS_DIR:path.join(state,'source-diagnostics')};
    Object.assign(process.env,phaseEnv);
    stage='MODULE_BUILD';
    setErrorPhase('MODULE_BUILD');
    await buildModules(['src/main.ts','src/eu-main.ts'],phaseEnv);
    stage='OUTPUT_VALIDATION';
    const targets=(['NL','EU'] as const).map(jurisdiction=>{
      const config=phase==='BASE'?path.join(work,jurisdiction.toLowerCase()+'-base-scope.json'):
        configFile(root,jurisdiction==='NL'?'zakres.json':'zakres-ue.json');
      return {jurisdiction,dir:path.join(work,jurisdiction==='NL'?'output':'output-ue'),
        acts:JSON.parse(fs.readFileSync(config,'utf8')).acts};
    });
    for(const target of targets)await finalizePackageImages(target.dir,target.acts);
    const snapshot=validatedPublicationBytes(targets);
    stage='INDEPENDENT_AUDIT';
    const check=spawnSync(process.env.LAW_XML_PYTHON??'python3',['scripts/verify_official_output.py'],
      {cwd:root,encoding:'utf8',timeout:300_000,maxBuffer:1_000_000,env:phaseEnv,stdio:['ignore','pipe','pipe']});
    if(check.error||check.status!==0)throw independentAuditError(check.stderr,(check.error as NodeJS.ErrnoException)?.code==='ETIMEDOUT');
    let audit:any;
    try{audit=JSON.parse(check.stdout);}catch{throw new PublicBuildError('AUDIT_OUTPUT_INVALID');}
    if(audit.status!=='PASS'||audit.results?.length!==2)throw new PublicBuildError('AUDIT_FAILED');
    if(audit.results.some((result:any)=>result.completeness!=='COMPLETE')){
      console.error(JSON.stringify({phase,status:'PARTIAL',results:audit.results}));
      throw new PublicBuildError('OUTPUT_INCOMPLETE');
    }
    stage='FREEZE';
    const files=[...snapshot].flatMap(([module,values])=>[...values].map(([name,bytes])=>({
      name:`${module==='EU'?'UE':'NL'}/${name}`,bytes:bytes.length,sha256:hash(bytes)}))).sort((a,b)=>a.name.localeCompare(b.name,'en'));
    fs.writeFileSync(path.join(work,'verified.json'),JSON.stringify({audit,files},null,2)+'\n');
    console.log(JSON.stringify({phase,status:'PASS',rangeFrom:range.rangeFrom,rangeTo:to,files:files.length}));
  });
  promotePublicOutputs(root,path.join(state,'build'));
}

withOperationErrors('entry',root,main).catch(error=>{
  recordPublicBuildFailure(root,error,stage);
  console.error('Public corpus build failed; previous published data remains active.');process.exitCode=1;
});
