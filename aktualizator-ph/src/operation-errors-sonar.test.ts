import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {withOperationErrors} from './operation-errors.js';

test('successful operation writes a complete PASS summary', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'operation-sonar-pass-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  await withOperationErrors('entry',root,async()=>{});
  const directory=path.join(root,'.source-diagnostics','errors');
  const reports=fs.readdirSync(directory).filter(name=>name.startsWith('summary-'));
  assert.equal(reports.length,1);
  const summary=JSON.parse(fs.readFileSync(path.join(directory,reports[0]),'utf8'));
  assert.equal(summary.status,'PASS');
  assert.equal(summary.complete,true);
});

test('failed operation propagates its original error without logging sensitive messages', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'operation-sonar-fail-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const original=new Error('PRIVATE_TOKEN_IN_ERROR');
  const lines:string[]=[];
  t.mock.method(console,'error',(...args:unknown[])=>{lines.push(args.join(' '));});
  await assert.rejects(withOperationErrors('entry',root,async()=>{throw original;}),error=>error===original);
  const directory=path.join(root,'.source-diagnostics','errors');
  const report=fs.readdirSync(directory).find(name=>name.startsWith('summary-'));
  assert(report);
  const text=fs.readFileSync(path.join(directory,report),'utf8');
  assert.equal(JSON.parse(text).status,'FAIL');
  assert(!text.includes('PRIVATE_TOKEN_IN_ERROR'));
  assert(lines.every(line=>!line.includes('PRIVATE_TOKEN_IN_ERROR')));
});
