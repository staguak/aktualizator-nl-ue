/** Build the shared public corpus without loading any Drive credentials. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {buildModules} from './build-runner.js';
import {configFile,resolveRange} from './run-config.js';
import {validatedPublicationBytes} from './publication-validation.js';
import {withOperationErrors} from './operation-errors.js';
import {hash} from './release-store.js';
import {PublicBuildError,independentAuditError,recordPublicBuildFailure} from './public-build-errors.js';
import type {PublicBuildStage} from './public-build-errors.js';
import {publicIncrementalEnvironment,warmPublicSources,recoverPublicOutputs,promotePublicOutputs} from './public-incremental.js';
import {sourceAuditMode} from './source-audit.js';
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
    LAW_RANGE_FROM:range.rangeFrom,LAW_RANGE_TO:range.rangeTo,LAW_OBSERVED_ON:range.observedOn});
  Object.assign(process.env,env);
  if(sourceAuditMode(env)!=='unconditional')console.log(JSON.stringify(warmPublicSources(root,env.LAW_SOURCE_CACHE_DIR!)));
  const work=env.LAW_PUBLIC_WORK_ROOT!;
  stage='MODULE_BUILD';
  await buildModules(['src/main.ts','src/eu-main.ts'],env);
  stage='OUTPUT_VALIDATION';
  const targets=(['NL','EU'] as const).map(jurisdiction=>({jurisdiction,
    dir:path.join(work,jurisdiction==='NL'?'output':'output-ue'),
    acts:JSON.parse(fs.readFileSync(configFile(root,jurisdiction==='NL'?'zakres.json':'zakres-ue.json'),'utf8')).acts}));
  for(const target of targets)await finalizePackageImages(target.dir,target.acts);
  const snapshot=validatedPublicationBytes(targets);
  stage='INDEPENDENT_AUDIT';
  const check=spawnSync(process.env.LAW_XML_PYTHON??'python3',['scripts/verify_official_output.py'],
    {cwd:root,encoding:'utf8',timeout:120_000,maxBuffer:1_000_000,env,stdio:['ignore','pipe','pipe']});
  if(check.error||check.status!==0)throw independentAuditError(check.stderr,(check.error as NodeJS.ErrnoException)?.code==='ETIMEDOUT');
  let audit:any;
  try{audit=JSON.parse(check.stdout);}catch{throw new PublicBuildError('AUDIT_OUTPUT_INVALID');}
  if(audit.status!=='PASS')throw new PublicBuildError('AUDIT_FAILED');
  stage='FREEZE';
  const state=path.join(root,'.public-state');fs.mkdirSync(state,{recursive:true});
  fs.writeFileSync(path.join(state,'independent-audit.json'),JSON.stringify(audit,null,2)+'\n');
  const files=[...snapshot].flatMap(([module,values])=>[...values].map(([name,bytes])=>({
    name:`${module==='EU'?'UE':'NL'}/${name}`,bytes:bytes.length,sha256:hash(bytes)}))).sort((a,b)=>a.name.localeCompare(b.name,'en'));
  fs.writeFileSync(path.join(state,'validated-files.json'),JSON.stringify(files,null,2)+'\n');
  stage='DISTRIBUTION';
  const distribution=spawnSync(process.env.LAW_XML_PYTHON??'python3',['scripts/create_distribution.py',work,path.join(state,'distribution'),path.join(state,'validated-files.json'),path.join(state,'independent-audit.json')],
    {cwd:root,encoding:'utf8',timeout:15*60_000,maxBuffer:10000,env,stdio:['ignore','pipe','pipe']});
  if(distribution.error||distribution.status!==0)throw new PublicBuildError('DISTRIBUTION_FAILED');
  promotePublicOutputs(root,work);
  console.log(JSON.stringify({status:'PASS',rangeFrom:range.rangeFrom,rangeTo:range.rangeTo,
    files:[...snapshot.values()].reduce((n,files)=>n+files.size,0),scope:'Public official sources only; no Drive operation.'}));
}
withOperationErrors('entry',root,main).catch(error=>{
  recordPublicBuildFailure(root,error,stage);
  console.error('Public corpus build failed; previous published data remains active.');process.exitCode=1;
});
