import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {commitGeneration,newContext,prepareGeneration} from './release-engine.js';
import type {RunContext} from './release-engine.js';
import {finalizePublishedRun} from './release-lifecycle.js';
import {exportBaseEvidence} from './release-base-evidence.js';
import {buildReport} from './build-report.js';
import {encode,hash} from './release-store.js';
import type {ReleaseStore} from './release-store.js';

class Store implements ReleaseStore {
  files=new Map<string,Buffer>();
  async read(key:string){return this.files.get(key)??null;}
  async stat(key:string){const b=this.files.get(key);return b?{id:key,size:b.length,md5:hash(b,'md5'),sha256:hash(b)}:null;}
  async list(prefix:string){return [...this.files.keys()].filter(k=>k.startsWith(prefix));}
  async write(key:string,b:Buffer,immutable:boolean){const old=this.files.get(key);if(old&&immutable&&!old.equals(b))throw new Error('Immutable conflict');this.files.set(key,b);return (await this.stat(key))!;}
  async remove(key:string){this.files.delete(key);}
}
function pair(c:RunContext,base=false){
  return new Map((['NL','EU'] as const).map(module=>{
    const files=new Map<string,Buffer>();
    const acts=Array.from({length:module==='NL'?2:63},(_,i)=>{
      const id=`TECHNICAL_${module}_${i}`,name=`01_${id}.sources.zip`,bytes=Buffer.from(`TECHNICAL TRANSPORT FIXTURE — NOT LAW: ${id}`);files.set(name,bytes);
      return {[module==='NL'?'bwbId':'celex']:id,sourceArchive:{name,size:bytes.length,md5:hash(bytes,'md5')}};
    });
    const manifest={jurisdiction:module,rangeFrom:c.rangeFrom,rangeTo:base?c.rangeFrom:c.rangeTo,officialSources:{observedOn:c.observedOn},acts};
    const report=buildReport(manifest,null,{status:'PASS',checks:['Technical transport fixture only'],fileCount:0,contentFileCount:0,contentBytes:0},
      {LAW_RELEASE_CONTEXT:JSON.stringify(c),LAW_RELEASE_PHASE:base?'base':'release'});
    files.set('manifest.json',encode(manifest));files.set('INDEX.md',Buffer.from('TECHNICAL TRANSPORT FIXTURE — NOT LAW'));
    files.set('REPORT.md',Buffer.from('```json\n'+JSON.stringify(report)+'\n```\n'));return [module,files];
  }));
}
test('independent base verifier accepts a later active update, keeps original producer identity and rejects missing EU reuse or report overwrite',async t=>{
  t.mock.method(console,'log',()=>{});const root=fs.mkdtempSync(path.join(os.tmpdir(),'base-verifier-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const store=new Store(),c=newContext({mode:'initialize',baseId:'technical-base',parentReleaseId:null,codeRevision:'a'.repeat(40),configSha256:'b'.repeat(64),
    rangeFrom:'2025-01-01',rangeTo:'2026-10-20',observedOn:'2026-10-21'});
  await prepareGeneration(store,c,'base',pair(c,true));await commitGeneration(store,await prepareGeneration(store,c,'release',pair(c)));await finalizePublishedRun(store,c);
  const interruption=new Date().toISOString();await store.write(`checks/faults/${c.runId}-NL.json`,encode({schemaVersion:1,context:c,module:'NL',phase:'base',completedActs:2,confirmedAt:interruption}),true);
  for(const module of ['NL','EU'])await store.write(`checks/resumes/${module}.json`,encode({schemaVersion:1,context:c,module,phase:'base',at:interruption,
    completedActIds:Array.from({length:module==='NL'?2:63},(_,i)=>`TECHNICAL_${module}_${i}`),effectiveCheckpointKey:`technical-${module}`}),true);
  const later=newContext({...c,mode:'update',parentReleaseId:c.releaseId,parentOperationId:c.runId});
  await commitGeneration(store,await prepareGeneration(store,later,'release',pair(later)));await finalizePublishedRun(store,later);
  const directory=path.join(root,'export');await exportBaseEvidence(store,directory,true);
  const script=fileURLToPath(new URL('../scripts/verify_drive_acceptance_evidence.ts',import.meta.url));
  const verify=(dir:string,dest:string)=>spawnSync(process.execPath,['--import','tsx',script,dir,dest],{cwd:fileURLToPath(new URL('../',import.meta.url)),encoding:'utf8',timeout:30_000});
  const reportPath=path.join(root,'proof.json'),passed=verify(directory,reportPath);assert.equal(passed.status,0,passed.stderr);
  const original=fs.readFileSync(reportPath),proof=JSON.parse(original.toString());assert.equal(proof.releaseId,later.releaseId);assert.equal(proof.activeOperationId,later.runId);
  assert.equal(proof.baseProducerReleaseId,c.releaseId);assert.equal(proof.baseOperationId,c.runId);assert.deepEqual(proof.restored.map((r:any)=>[r.module,r.acts.length]),[['NL',2],['EU',63]]);
  assert.notEqual(verify(directory,reportPath).status,0);assert.deepEqual(fs.readFileSync(reportPath),original,'Existing evidence must never be overwritten');
  const event=JSON.parse(store.files.get('checks/resumes/EU.json')!.toString());event.completedActIds.pop();store.files.set('checks/resumes/EU.json',encode(event));
  const incomplete=path.join(root,'incomplete');await exportBaseEvidence(store,incomplete,true);
  const rejected=verify(incomplete,path.join(root,'must-not-exist.json'));assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/Missing actual EU checkpoint reuse receipt/);
  assert.equal(fs.existsSync(path.join(root,'must-not-exist.json')),false);
});
