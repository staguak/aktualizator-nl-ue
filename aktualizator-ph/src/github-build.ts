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

const root=fileURLToPath(new URL('../',import.meta.url));
async function main(){
  if(process.argv.length!==2)throw new Error('Public builds take no command arguments.');
  if(process.env.GOOGLE_DRIVE_OAUTH_JSON||process.env.LAW_CONFIG_JSON||process.env.LAW_RELEASE_CONTEXT||
    process.env.LAW_CONFIG_DIR||process.env.GH_TOKEN||process.env.GITHUB_TOKEN)
    throw new Error('Shared corpus builds must not receive credentials or private configuration.');
  const range=resolveRange(root),env={...process.env,LAW_XML_VALIDATION:'required',
    LAW_RANGE_FROM:range.rangeFrom,LAW_RANGE_TO:range.rangeTo,LAW_OBSERVED_ON:range.observedOn};
  await buildModules(['src/main.ts','src/eu-main.ts'],env);
  const targets=(['NL','EU'] as const).map(jurisdiction=>({jurisdiction,
    dir:path.join(root,jurisdiction==='NL'?'output':'output-ue'),
    acts:JSON.parse(fs.readFileSync(configFile(root,jurisdiction==='NL'?'zakres.json':'zakres-ue.json'),'utf8')).acts}));
  const snapshot=validatedPublicationBytes(targets);
  const check=spawnSync(process.env.LAW_XML_PYTHON??'python3',['scripts/verify_official_output.py'],
    {cwd:root,encoding:'utf8',timeout:120_000,maxBuffer:1_000_000,env});
  if(check.error||check.status!==0)throw new Error('Independent public corpus audit failed.');
  const audit=JSON.parse(check.stdout);
  if(audit.status!=='PASS')throw new Error('Independent public corpus audit did not pass.');
  const state=path.join(root,'.public-state');fs.mkdirSync(state,{recursive:true});
  fs.writeFileSync(path.join(state,'independent-audit.json'),JSON.stringify(audit,null,2)+'\n');
  const files=[...snapshot].flatMap(([module,values])=>[...values].map(([name,bytes])=>({
    name:`${module==='EU'?'UE':'NL'}/${name}`,bytes:bytes.length,sha256:hash(bytes)}))).sort((a,b)=>a.name.localeCompare(b.name,'en'));
  fs.writeFileSync(path.join(state,'validated-files.json'),JSON.stringify(files,null,2)+'\n');
  console.log(JSON.stringify({status:'PASS',rangeFrom:range.rangeFrom,rangeTo:range.rangeTo,
    files:[...snapshot.values()].reduce((n,files)=>n+files.size,0),scope:'Public official sources only; no Drive operation.'}));
}
withOperationErrors('entry',root,main).catch(()=>{console.error('Public corpus build failed; previous published data remains active.');process.exitCode=1;});
