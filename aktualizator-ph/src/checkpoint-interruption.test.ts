import test from 'node:test';
import assert from 'node:assert/strict';
import {interruptVerifiedCheckpoint} from './checkpoint-interruption.js';
import {newContext} from './release-engine.js';
import {encode,hash} from './release-store.js';
import type {ReleaseStore} from './release-store.js';

function fixture(){
  const files=new Map<string,Buffer>();let writes=0,reads=0;
  const store:ReleaseStore={async read(key){reads++;return files.get(key)??null;},async stat(){return null;},async list(){return [...files.keys()];},
    async write(key,bytes,immutable){const old=files.get(key);if(old&&immutable&&!old.equals(bytes))throw new Error('Immutable overwrite');
      writes++;files.set(key,bytes);return {id:key,size:bytes.length,md5:hash(bytes,'md5'),sha256:hash(bytes)};},async remove(){throw new Error('Forbidden deletion');}};
  const context=newContext({mode:'initialize',baseId:'technical-base',parentReleaseId:null,codeRevision:'a'.repeat(40),configSha256:'b'.repeat(64),
    rangeFrom:'2025-01-01',rangeTo:'2026-10-20',observedOn:'2026-10-21'});
  const env={LAW_RELEASE_NAMESPACE:'release-test-corpus-123-1',LAW_TEST_INTERRUPT_MODULE:'NL',LAW_TEST_INTERRUPT_AFTER:'2'};
  return {store,files,context,env,writes:()=>writes,reads:()=>reads,stop:(count:number)=>interruptVerifiedCheckpoint(store,context,'NL','base',count,env)};
}
test('restored verified checkpoint interrupts again without overwriting the first immutable fault receipt',async t=>{
  t.mock.method(console,'log',()=>{});const f=fixture();await f.stop(1);assert.equal(f.writes(),0);
  await assert.rejects(f.stop(2),/Deliberate test interruption/);const first=new Map(f.files);
  await assert.rejects(f.stop(2),/Deliberate test interruption/);await assert.rejects(f.stop(3),/Deliberate test interruption/);
  assert.equal(f.writes(),1);assert.deepEqual(f.files,first);
});
test('fault injection is inert for the ordinary publisher and cannot target production or invalid counts',async()=>{
  const f=fixture();await interruptVerifiedCheckpoint(f.store,f.context,'NL','base',2,{});
  await interruptVerifiedCheckpoint(f.store,f.context,'EU','base',63,f.env);
  await interruptVerifiedCheckpoint(f.store,f.context,'NL','release',2,f.env);assert.equal(f.writes(),0);assert.equal(f.reads(),0);
  for(const env of [{...f.env,LAW_RELEASE_NAMESPACE:'production'},{...f.env,LAW_TEST_INTERRUPT_AFTER:'NaN'},{...f.env,LAW_TEST_INTERRUPT_AFTER:'0'}])
    await assert.rejects(interruptVerifiedCheckpoint(f.store,f.context,'NL','base',2,env),/isolated corpus/);
  assert.equal(f.writes(),0);
});
test('conflicting prior fault evidence is preserved and backend failure is not relabeled as deliberate interruption',async t=>{
  t.mock.method(console,'log',()=>{});const f=fixture();await assert.rejects(f.stop(2),/Deliberate/);
  const key=[...f.files.keys()][0],record=JSON.parse(f.files.get(key)!.toString());record.context.runId='different-operation';f.files.set(key,encode(record));
  const before=new Map(f.files);await assert.rejects(f.stop(2),/Conflicting/);assert.deepEqual(f.files,before);
  f.store.read=async()=>{throw new Error('Backend read failed');};await assert.rejects(f.stop(2),/Backend read failed/);
});
test('lost response after the first successful fault receipt write is reconciled on the next priming attempt',async t=>{
  t.mock.method(console,'log',()=>{});const f=fixture(),write=f.store.write.bind(f.store);let lost=true;
  f.store.write=async(...args)=>{const saved=await write(...args);if(lost){lost=false;throw new Error('Receipt response lost');}return saved;};
  await assert.rejects(f.stop(2),/Receipt response lost/);const first=new Map(f.files);
  await assert.rejects(f.stop(2),/Deliberate test interruption/);assert.equal(f.writes(),1);assert.deepEqual(f.files,first);
});
