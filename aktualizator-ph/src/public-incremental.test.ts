import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {publicIncrementalEnvironment,promotePublicOutputs,recoverPublicOutputs} from './public-incremental.js';

function temporary(t:import('node:test').TestContext){const root=fs.mkdtempSync(path.join(os.tmpdir(),'public-incremental-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function write(root:string,value:string){for(const name of ['output','output-ue']){fs.mkdirSync(path.join(root,name),{recursive:true});fs.writeFileSync(path.join(root,name,'proof'),value);}}
test('the public entry enables streaming cache with one technical operation, without changing audit choice',t=>{
  const root=temporary(t),env=publicIncrementalEnvironment(root,{LAW_SOURCE_AUDIT:'unconditional'});
  assert.equal(env.LAW_PUBLIC_INCREMENTAL,'1');assert.equal(env.LAW_CACHE_SHARDS,'8');assert.equal(env.LAW_SOURCE_AUDIT,'unconditional');
  assert.equal(env.LAW_XML_SOURCE_ROOT,env.LAW_SOURCE_CACHE_DIR);assert.notEqual(publicIncrementalEnvironment(root,{}).LAW_PUBLIC_OPERATION_ID,env.LAW_PUBLIC_OPERATION_ID);
  assert.equal(publicIncrementalEnvironment(root,env).LAW_PUBLIC_OPERATION_ID,env.LAW_PUBLIC_OPERATION_ID);
});
test('a failure after installing NL restores both previous modules; a successful pair is then installed',t=>{
  const root=temporary(t),work=path.join(root,'.public-state','build');write(root,'old good base');write(work,'verified new base');
  assert.throws(()=>promotePublicOutputs(root,work,()=>{throw new Error('Simulated interruption');}),/interruption/);
  for(const name of ['output','output-ue'])assert.equal(fs.readFileSync(path.join(root,name,'proof'),'utf8'),'old good base');
  write(work,'verified new base');promotePublicOutputs(root,work);
  for(const name of ['output','output-ue'])assert.equal(fs.readFileSync(path.join(root,name,'proof'),'utf8'),'verified new base');
  assert(!fs.existsSync(path.join(root,'.public-state','output-promotion.json')));
});
test('a fresh process can roll back a journal left between the two module renames',t=>{
  const root=temporary(t),state=path.join(root,'.public-state'),backup=path.join(state,'prior-outputs');
  write(root,'old good base');fs.mkdirSync(backup,{recursive:true});
  fs.renameSync(path.join(root,'output'),path.join(backup,'output'));
  fs.mkdirSync(path.join(root,'output'));fs.writeFileSync(path.join(root,'output','proof'),'incomplete pair');
  fs.writeFileSync(path.join(state,'output-promotion.json'),JSON.stringify({profile:'public-output-promotion-v1',status:'PREPARED',previous:{output:true,'output-ue':true}}));
  recoverPublicOutputs(root);
  for(const name of ['output','output-ue'])assert.equal(fs.readFileSync(path.join(root,name,'proof'),'utf8'),'old good base');
});
test('an unexpected backup or symlink cannot be used to replace an active local base',t=>{
  const root=temporary(t),work=path.join(root,'.public-state','build');write(root,'old good base');write(work,'new');
  fs.mkdirSync(path.join(root,'.public-state','prior-outputs'));
  assert.throws(()=>promotePublicOutputs(root,work),/Unowned/);
  fs.rmSync(path.join(root,'.public-state','prior-outputs'),{recursive:true});
  const outside=path.join(root,'outside');fs.mkdirSync(outside);fs.renameSync(path.join(root,'output'),path.join(outside,'saved'));
  fs.symlinkSync(outside,path.join(root,'output'),'dir');assert.throws(()=>promotePublicOutputs(root,work),/Unsafe/);
  assert.equal(fs.readFileSync(path.join(outside,'saved','proof'),'utf8'),'old good base');
});
