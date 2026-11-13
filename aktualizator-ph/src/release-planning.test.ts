import test from 'node:test';
import assert from 'node:assert/strict';
import {planningPart,exportPlanningDiagnostics} from './release-planning.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {newContext} from './release-engine.js';
import {hash} from './release-store.js';
import type {ReleaseStore,StoredObject} from './release-store.js';
import {runPool} from './concurrency.js';
import {withOperationErrors,inErrorPhase,errorRegistryReference,collectOperationErrors} from './operation-errors.js';
import {safeFailureMessage} from './drive-retry.js';

test('planning wrappers redact SDK credentials before their contextual message reaches logs',async()=>{
  const secret='SDK_CREDENTIAL_MUST_NOT_REACH_PLANNING_LOGS';
  const failure=Object.assign(new Error(secret),{response:{status:401},config:{data:{refresh_token:secret}}});
  await assert.rejects(planningPart(new MemoryStore(),context(),'combined-plan','NL-EU',async()=>{throw failure;}),error=>{
    const message=safeFailureMessage(error);
    assert(!message.includes(secret));assert.match(message,/Drive API failure \(HTTP 401\)/);return true;
  });
});

test('contextual planning errors retain only the safe original HTTP classification',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'planning-http-error-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let trace='';
  await assert.rejects(withOperationErrors('release',root,async()=>{
    trace=errorRegistryReference()!.traceId;
    await inErrorPhase('BASE_PLANNING',()=>planningPart(new MemoryStore(),context(),'combined-plan','NL-EU',async()=>{
      throw Object.assign(new Error('PRIVATE_SDK_PAYLOAD'),{response:{status:403},config:{data:'PRIVATE_SDK_PAYLOAD'}});
    }));
  },{}));
  const report=collectOperationErrors(path.join(root,'.source-diagnostics/errors'),trace);
  assert.equal(report.observedFailures,1);assert.equal(report.events[0].httpStatus,403);
  assert(!JSON.stringify(report).includes('PRIVATE_SDK_PAYLOAD'));
});

test('combined planning preserves each failed source task through its contextual error wrapper',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'planning-errors-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const store=new MemoryStore(),c=context();let trace='';
  await assert.rejects(withOperationErrors('release',root,async()=>{
    trace=errorRegistryReference()!.traceId;
    await inErrorPhase('BASE_PLANNING',()=>planningPart(store,c,'combined-plan','NL-EU',async()=>{
      await runPool([0,1,2,3],4,async n=>{
        await planningPart(store,c,'nl-discovery','FIXTURE-'+n,async()=>{
          await new Promise(resolve=>setTimeout(resolve,5*n));throw new Error('PRIVATE_SOURCE_DIAGNOSTIC');
        });
      });
      return part();
    }));
  },{}));
  const report=collectOperationErrors(path.join(root,'.source-diagnostics/errors'),trace);
  assert.equal(report.complete,true);assert.equal(report.status,'FAIL');
  assert.equal(report.observedFailures,4);
  assert(report.events.every(e=>e.phase==='BASE_PLANNING'));
  assert(!JSON.stringify(report).includes('PRIVATE_SOURCE_DIAGNOSTIC'));
});

class MemoryStore implements ReleaseStore {
  objects=new Map<string,{bytes:Buffer;metadata:StoredObject}>();lostPointer=false;
  async read(key:string){return this.objects.get(key)?.bytes??null;}
  async stat(key:string){return this.objects.get(key)?.metadata??null;}
  async write(key:string,bytes:Buffer,immutable:boolean){
    const old=this.objects.get(key);
    if(immutable&&old&&hash(old.bytes)!==hash(bytes))throw new Error('Immutable overwrite');
    const metadata={id:old?.metadata.id??String(this.objects.size+1),size:bytes.length,sha256:hash(bytes),md5:hash(bytes,'md5')};
    this.objects.set(key,{bytes:Buffer.from(bytes),metadata});
    if(key.startsWith('work/planning/')&&this.lostPointer){this.lostPointer=false;throw new Error('Response lost');}
    return metadata;
  }
  async list(prefix:string){return [...this.objects.keys()].filter(k=>k.startsWith(prefix));}
  async remove(key:string){this.objects.delete(key);}
}
const context=()=>newContext({baseId:'base',parentReleaseId:null,mode:'initialize',codeRevision:'revision',
  configSha256:'a'.repeat(64),rangeFrom:'2025-01-01',rangeTo:'2026-10-11',observedOn:'2026-10-16'});
const part=(value='frozen')=>({value,archives:new Map([['official.sources.zip',Buffer.from('unchanged official evidence')]])});

test('initial planning restores verified results without making source requests',async()=>{
  const store=new MemoryStore(),c=context();let calls=0;
  await planningPart(store,c,'nl-discovery','BWBR0005290',async()=>{calls++;return part();});
  const restored=await planningPart(store,c,'nl-discovery','BWBR0005290',async()=>{calls++;throw new Error('Should remain offline');});
  assert.equal(calls,1);assert.equal(restored.value,'frozen');
  assert.equal(restored.archives.get('official.sources.zip')!.toString(),'unchanged official evidence');
});
test('planning source failure names stage and act, preserving completed tasks',async()=>{
  const store=new MemoryStore(),c=context();
  await planningPart(store,c,'eu-discovery','32016R0679',async()=>part());
  await assert.rejects(planningPart(store,c,'eu-discovery','32003L0088',async()=>{throw new DOMException('Timed out','TimeoutError');}),
    /eu-discovery 32003L0088: Request failed \[REQUEST_TIMEOUT\]/);
  const restored=await planningPart(store,c,'eu-discovery','32016R0679',async()=>{throw new Error('Unexpected retry');});
  assert.equal(restored.value,'frozen');
});
test('planning evidence and capsule corruption fail before any source retry',async()=>{
  for(const capsule of [false,true]){
    const store=new MemoryStore(),c=context();await planningPart(store,c,'nl-units','BWBR0005290',async()=>part());
    const pointer=JSON.parse((await store.read((await store.list('work/planning/'))[0]))!.toString());
    const payload=JSON.parse((await store.read(pointer.capsule.key))!.toString());
    const key=capsule?pointer.capsule.key:payload.archives[0].key;
    store.objects.get(key)!.bytes=Buffer.from('corrupt');
    await assert.rejects(planningPart(store,c,'nl-units','BWBR0005290',async()=>{throw new Error('Must not replace corruption silently');}),/corruption/);
  }
});
test('planning contexts are not reused after code or scope change',async()=>{
  const store=new MemoryStore(),c=context();await planningPart(store,c,'eu-discovery','12016E/TXT',async()=>part());
  const changed={...c,codeRevision:'new-code'};
  const result=await planningPart(store,changed,'eu-discovery','12016E/TXT',async()=>part('fresh'));
  assert.equal(result.value,'fresh');
});
test('lost planning pointer response is recognized on retry without rebuilding',async()=>{
  const store=new MemoryStore(),c=context();store.lostPointer=true;
  await assert.rejects(planningPart(store,c,'nl-discovery','BWBR0005290',async()=>part()),/Response lost/);
  assert.equal((await planningPart(store,c,'nl-discovery','BWBR0005290',async()=>{throw new Error('Unexpected source repeat');})).value,'frozen');
});
test('planning rejects an empty source evidence set and unsafe archive names',async()=>{
  const store=new MemoryStore(),c=context();
  await assert.rejects(planningPart(store,c,'nl-discovery','BWB',async()=>({value:'x',archives:new Map()})),/Missing planning source evidence/);
  await assert.rejects(planningPart(store,c,'nl-discovery','BWB',async()=>({value:'x',archives:new Map([['../escape',Buffer.from('x')]])})),/Unsafe planning/);
});
test('planning diagnostics export only verified original Drive evidence and never mutate its store',async t=>{
  const store=new MemoryStore(),c=context(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'planning-export-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  await planningPart(store,c,'nl-discovery','BWBR0005290',async()=>part());
  await store.write('work/planning/.ready',Buffer.from('verified initial selection tasks\n'),true);
  const before=[...store.objects].map(([key,value])=>[key,{bytes:Buffer.from(value.bytes),metadata:{...value.metadata}}]);
  store.write=async()=>{throw new Error('Forbidden Drive mutation');};store.remove=async()=>{throw new Error('Forbidden Drive deletion');};
  const report=await exportPlanningDiagnostics(store,c,dir);
  assert.equal(report.records.length,1);assert.deepEqual([...store.objects],before);
  const record=JSON.parse(fs.readFileSync(path.join(dir,report.records[0].file),'utf8'));
  assert.equal(record.value,'frozen');assert.equal(record.context.runId,c.runId);
  assert.equal(fs.readFileSync(path.join(dir,record.archives[0].file),'utf8'),'unchanged official evidence');
  const again=await exportPlanningDiagnostics(store,c,dir);assert.deepEqual(again,report);
  fs.writeFileSync(path.join(dir,record.archives[0].file),'corruption');
  await assert.rejects(exportPlanningDiagnostics(store,c,dir),/Conflicting planning/);
  assert.equal(fs.readFileSync(path.join(dir,record.archives[0].file),'utf8'),'corruption');
});
test('planning diagnostics cannot replace corrupt or incompatible capsules with a new fetch',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'planning-corrupt-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new MemoryStore(),c=context();await planningPart(store,c,'nl-discovery','BWBR0005290',async()=>part());
  await assert.rejects(exportPlanningDiagnostics(store,{...c,codeRevision:'other'},dir),/No compatible/);
  const key=(await store.list('work/snapshots/'))[0];store.objects.get(key)!.bytes=Buffer.from('corrupt');
  await assert.rejects(exportPlanningDiagnostics(store,c,dir),/corruption/);
  assert.deepEqual(fs.readdirSync(dir),[]);
});
