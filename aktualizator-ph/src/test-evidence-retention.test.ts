import test from 'node:test';
import assert from 'node:assert/strict';
import {obsoleteTestEvidence,type TestEvidenceRun,type ManualEvidenceRetention} from './test-evidence-retention.js';
const row=(n:number,extra:Partial<TestEvidenceRun>={}):TestEvidenceRun=>({id:`${n}-1`,sequence:n,status:'PASS',protected:false,active:false,...extra});
test('two latest completed updates survive; failure, active and protected evidence never deleted',()=>{
  assert.deepEqual(obsoleteTestEvidence([row(1),row(2),row(3),row(4)]),['2-1','1-1']);
  assert.deepEqual(obsoleteTestEvidence([row(1,{protected:true}),row(2,{active:true}),row(3,{status:'FAIL'}),row(4)]),[]);
  assert.deepEqual(obsoleteTestEvidence([row(1),row(2)]),[]);
  assert.throws(()=>obsoleteTestEvidence([row(1),row(1)]));
});
const manual=(n:number,operation:ManualEvidenceRetention['operation']='update',namespace='release-test-manual-100')=>
  row(n,{retention:{profile:'manual-update-retention-v1',namespace,operation}});
test('manual evidence ages only after two successful updates of the same corpus',()=>{
  assert.deepEqual(obsoleteTestEvidence([manual(1,'initialize'),manual(2,'check'),manual(3,'rollback'),
    manual(4,'recover'),manual(5),manual(6,'initialize','release-test-manual-200')]),[]);
  assert.deepEqual(obsoleteTestEvidence([manual(1,'initialize'),manual(2,'check'),manual(3),manual(4),
    manual(5,'initialize','release-test-manual-200'),manual(6,'update','release-test-manual-200')]),['1-1']);
  assert.deepEqual(obsoleteTestEvidence([manual(1),manual(2),manual(3),row(4)]),['1-1']);
});
test('manual reruns cannot change scope; an active attempt cannot advance retirement age',()=>{
  assert.throws(()=>obsoleteTestEvidence([manual(1),{...manual(1,'check'),id:'1-2'}]),/Ambiguous/);
  assert.throws(()=>obsoleteTestEvidence([manual(1),{...manual(1,'update','release-test-manual-200'),id:'1-2'}]),/Ambiguous/);
  assert.deepEqual(obsoleteTestEvidence([manual(1),manual(2),manual(3),{...manual(3),id:'3-2',active:true}]),[]);
  assert.deepEqual(obsoleteTestEvidence([{...manual(1),protected:true},manual(2),manual(3)]),[]);
  assert.throws(()=>obsoleteTestEvidence([{...manual(1),retention:{...manual(1).retention!,namespace:'production'}}]),/Ambiguous/);
});
