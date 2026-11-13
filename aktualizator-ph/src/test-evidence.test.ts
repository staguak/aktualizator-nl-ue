import test from 'node:test';
import assert from 'node:assert/strict';
import {encode,hash,type ReleaseStore} from './release-store.js';
import {saveEvidenceBundle,readEvidenceBundle,finalizeEvidence,evidenceRetirementRows,retireEvidence,
  evidencePrefix,type EvidenceIdentity,type FinalizeEvidencePlan} from './test-evidence.js';
import {obsoleteTestEvidence} from './test-evidence-retention.js';
import {evidencePlan} from './test-evidence-plan.js';

class Memory implements ReleaseStore{
  files=new Map<string,Buffer>();calls=0;fault=0;after=false;
  cut(){if(++this.calls===this.fault&&!this.after)throw new Error('Synthetic transport failure');}
  done(){if(this.calls===this.fault&&this.after)throw new Error('Synthetic response loss');}
  meta(key:string){const b=this.files.get(key);return b?{id:key,size:b.length,sha256:hash(b),md5:hash(b,'md5')}:null;}
  async read(k:string){this.cut();const b=this.files.get(k)??null;this.done();return b;}
  async stat(k:string){this.cut();const m=this.meta(k);this.done();return m;}
  async list(p:string){this.cut();const keys=[...this.files.keys()].filter(k=>k.startsWith(p)).sort();this.done();return keys;}
  async write(k:string,b:Buffer,immutable:boolean){this.cut();if(immutable&&this.files.has(k)&&!this.files.get(k)!.equals(b))throw new Error('Immutable conflict');
    this.files.set(k,Buffer.from(b));const m=this.meta(k)!;this.done();return m;}
  async remove(k:string){this.cut();this.files.delete(k);this.done();}
  async removeIfUnchanged(k:string,expected:ReturnType<Memory['meta']>){
    assert.deepEqual(this.meta(k),expected);await this.remove(k);
  }
  async removeEmptyDirectory(_p:string){}
}
const identity=(run='100',attempt='1',job='verify'):EvidenceIdentity=>({run,attempt,job,revision:'a'.repeat(40)});
const plan=(sequence=1):FinalizeEvidencePlan=>({expected:[{name:'sample',job:'verify'}],jobs:{verify:'success'},requiredJobs:['verify'],sequence,protected:false});
const data=Buffer.from('Synthetic exact bundle bytes');

test('manual finalization binds corpus and operation and keeps non-update evidence protected',()=>{
  const env={GITHUB_RUN_ATTEMPT:'1',GITHUB_RUN_ID:'100',GITHUB_RUN_NUMBER:'1',
    LAW_EVIDENCE_JOB_RESULTS:'{"validate":"success"}',LAW_EVIDENCE_PRESERVE:'0',INPUT_RELEASE_OPERATION:'initialize'};
  const p=evidencePlan('evidence-manual-tests',env);
  assert.equal(p.protected,false);assert.equal(p.retention?.namespace,'release-test-manual-100');
  for(const operation of ['check','rollback','recover']){
    const other=evidencePlan('evidence-manual-tests',{...env,INPUT_RELEASE_OPERATION:operation,INPUT_TEST_NAMESPACE:'release-test-manual-100'});
    assert.equal(other.protected,true);assert.equal(other.retention?.operation,operation);
  }
  assert.throws(()=>evidencePlan('evidence-manual-tests',{...env,INPUT_RELEASE_OPERATION:'update'}),/Ambiguous/);
  assert.throws(()=>evidencePlan('evidence-manual-tests',{...env,INPUT_TEST_NAMESPACE:'production'}),/Ambiguous/);
});

test('manual receipt scope cannot be detached from its sealed plan',async()=>{
  const s=new Memory(),i=identity();await saveEvidenceBundle(s,i,'sample',data);
  await finalizeEvidence(s,i,{...plan(),retention:{profile:'manual-update-retention-v1',operation:'update',namespace:'release-test-manual-100'}});
  const key='checks/runs/100-1.json',r=JSON.parse(s.files.get(key)!.toString());
  r.retention.namespace='release-test-manual-200';s.files.set(key,encode(r));
  await assert.rejects(evidenceRetirementRows(s),/RETIREMENT_SCOPE_CHANGED/);
});

test('retirement rechecks exact object identity after external activity inspection',async()=>{
  const s=new Memory();
  for(const n of [100,101,102]){const i=identity(String(n));await saveEvidenceBundle(s,i,'sample',data);await finalizeEvidence(s,i,plan(n));}
  const rows=await evidenceRetirementRows(s),ids=obsoleteTestEvidence(rows);
  const key=evidencePrefix(identity())+'sample/manifest.json';
  await assert.rejects(retireEvidence(s,rows,ids,true,async()=>{s.files.set(key,Buffer.from('changed after planning'));}),/RETIREMENT_OBJECT_CHANGED/);
  assert(s.files.has(key));
});

test('evidence roundtrip binds job, ID, complete bytes and final plan; sealed retry is stable and read-only save rejection leaves no lease',async()=>{
  const store=new Memory(),i=identity();
  await saveEvidenceBundle(store,i,'sample',data);assert((await readEvidenceBundle(store,i,'sample')).bytes.equals(data));
  await assert.rejects(readEvidenceBundle(store,{...i,job:'foreign'},'sample'),/MANIFEST/);
  const receipt=await finalizeEvidence(store,{...i,job:'finalize_evidence'},plan());assert.equal(receipt.status,'PASS');
  assert.deepEqual(await finalizeEvidence(store,{...i,job:'finalize_evidence'},plan()),receipt);
  const before=new Map(store.files);await assert.rejects(saveEvidenceBundle(store,i,'sample',data),/FINALIZED/);
  assert.deepEqual(store.files,before);assert.deepEqual(await store.list('work/leases/'),[]);
});

test('arbitrary manifest, missing part, corrupt bytes, wrong metadata and foreign keys never receive a successful completion receipt',async()=>{
  for(const scenario of ['empty','missing','corrupt','identity','key','limit']){
    const s=new Memory(),i=identity();await saveEvidenceBundle(s,i,'sample',data);
    const key=evidencePrefix(i)+'sample/manifest.json',m=JSON.parse(s.files.get(key)!.toString());
    if(scenario==='empty')s.files.set(key,encode({}));
    else if(scenario==='missing')s.files.delete(m.chunks[0].key);
    else if(scenario==='corrupt')s.files.set(m.chunks[0].key,Buffer.from('altered'));
    else{if(scenario==='identity')m.job='wrong';if(scenario==='key')m.chunks[0].key='work/evidence/foreign';if(scenario==='limit')m.chunks[0].size=100_000_001;s.files.set(key,encode(m));}
    await assert.rejects(finalizeEvidence(s,identity('100','1','finalize_evidence'),plan()),(e:unknown)=>e instanceof Error,scenario);
    assert(!s.files.has('checks/runs/100-1.json'));
  }
});

test('partial required input and unfinished job cannot become PASS; terminal failure is recorded and protected',async()=>{
  const s=new Memory(),i=identity();
  await saveEvidenceBundle(s,i,'sample',data,{profile:'evidence-input-inventory-v1',requested:['NL','EU'],missing:['EU'],files:1,partial:true});
  await assert.rejects(finalizeEvidence(s,i,plan()),/PARTIAL_REQUIRED_INPUTS/);
  const failed=new Memory();const p={...plan(),jobs:{verify:'failure' as const}};
  const r=await finalizeEvidence(failed,i,p);assert.equal(r.status,'FAIL');assert.equal(r.protected,true);
  assert.deepEqual(obsoleteTestEvidence(await evidenceRetirementRows(failed)),[]);
});

test('before/after failures at every upload boundary preserve resumability and exact original bytes',async t=>{
  const reference=new Memory();await saveEvidenceBundle(reference,identity(),'sample',data);const boundaries=reference.calls;
  for(const after of [false,true])for(let fault=1;fault<=boundaries;fault++){
    const s=new Memory();s.fault=fault;s.after=after;
    try{await saveEvidenceBundle(s,identity(),'sample',data);}catch{}
    s.fault=0;await saveEvidenceBundle(s,identity(),'sample',data);
    assert((await readEvidenceBundle(s,identity(),'sample')).bytes.equals(data));
    assert.deepEqual(await s.list('work/leases/'),[]);
    assert.equal((await finalizeEvidence(s,identity(),plan())).status,'PASS');
  }
  t.diagnostic(JSON.stringify({uploadFaultBoundaries:boundaries,checked:boundaries*2}));
});

test('finalization failures resume without accepting different plans or modifying uploaded bytes',async t=>{
  const initial=new Memory();await saveEvidenceBundle(initial,identity(),'sample',data);
  const reference=new Memory();reference.files=new Map(initial.files);await finalizeEvidence(reference,identity(),plan());const boundaries=reference.calls;
  for(const after of [false,true])for(let fault=1;fault<=boundaries;fault++){
    const s=new Memory();s.files=new Map(initial.files);s.fault=fault;s.after=after;
    try{await finalizeEvidence(s,identity(),plan());}catch{}
    s.fault=0;assert.equal((await finalizeEvidence(s,identity(),plan())).status,'PASS');
    assert((await readEvidenceBundle(s,identity(),'sample')).bytes.equals(data));
    await assert.rejects(finalizeEvidence(s,identity(),{...plan(),protected:true}),/SEAL_CONFLICT/);
  }
  t.diagnostic(JSON.stringify({finalizationFaultBoundaries:boundaries,checked:boundaries*2}));
});

test('two distinct updates, not retries, are retained; prune defaults to a verified plan and refuses changed IDs',async()=>{
  const s=new Memory();
  for(const [run,attempt,sequence]of [['100','1',1],['100','2',1],['101','1',2],['102','1',3]] as const){
    const i=identity(run,attempt);await saveEvidenceBundle(s,i,'sample',data);await finalizeEvidence(s,i,plan(sequence));
  }
  const rows=await evidenceRetirementRows(s),ids=obsoleteTestEvidence(rows);assert.deepEqual(ids,['100-1','100-2']);
  const before=new Map(s.files);await retireEvidence(s,rows,ids);assert.deepEqual(s.files,before);
  await assert.rejects(retireEvidence(s,rows,ids,true),/EXTERNAL_ACTIVITY_CHECK_REQUIRED/);
  await assert.rejects(retireEvidence(s,rows,['102-1'],true,async()=>{}),/RETAINED_UPDATE/);
  await retireEvidence(s,rows,ids,true,async()=>{});
  assert.equal((await s.list(evidencePrefix(identity()))).length,0);assert(s.files.has('checks/runs/100-1.json'));
  assert((await s.list(evidencePrefix(identity('101')))).length>0);
});

test('every release verification scope receives its expected terminal plan; a success flag alone cannot finalize',()=>{
  for(const scope of ['full','technical','source-check','finalize','diagnostic','benchmark']){
    const p=evidencePlan('evidence-release-tests',{GITHUB_RUN_ATTEMPT:'1',GITHUB_RUN_NUMBER:'7',LAW_EVIDENCE_SCOPE:scope,
      LAW_EVIDENCE_JOB_RESULTS:JSON.stringify({verify:{result:'success'},benchmark_prepare:{result:'success'},benchmark_full:{result:'success'},benchmark_incremental:{result:'success'}})});
    assert.equal(p.expected.length,scope==='benchmark'?5:1);assert.equal(p.protected,true);
  }
  assert.throws(()=>evidencePlan('evidence-release-tests',{GITHUB_RUN_ATTEMPT:'1',LAW_EVIDENCE_TERMINAL_SUCCESS:'1'}),/JOB_RESULTS_REQUIRED/);
});
