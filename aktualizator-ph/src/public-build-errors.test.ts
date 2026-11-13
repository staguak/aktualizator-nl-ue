import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PublicBuildError,independentAuditError,recordPublicBuildFailure} from './public-build-errors.js';

test('independent audit diagnostics retain the failing check location without its input or stderr',()=>{
  const error=independentAuditError('PRIVATE_CREDENTIAL\nFile "/private/path/verify_official_output.py", line 42\nAssertionError: PRIVATE_VALUE');
  assert.equal(error.code,'AUDIT_FAILED');assert.equal(error.auditLine,42);
  assert(!JSON.stringify(error).includes('PRIVATE_'));
  assert.equal(independentAuditError('timeout payload',true).code,'AUDIT_TIMEOUT');
});
test('public failure report distinguishes phases and never serializes arbitrary errors',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'public-diagnostic-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const output:string[]=[];t.mock.method(console,'error',(value:string)=>output.push(value));
  assert.equal(recordPublicBuildFailure(root,new Error('PRIVATE_TOKEN'),'MODULE_BUILD').code,'MODULE_BUILD_FAILED');
  const report=recordPublicBuildFailure(root,new PublicBuildError('AUDIT_FAILED',18),'INDEPENDENT_AUDIT');
  assert.equal(report.auditLine,18);
  const saved=fs.readFileSync(path.join(root,'.public-control/build-error.json'),'utf8');
  assert(!saved.includes('PRIVATE_TOKEN'));assert(output.every(line=>!line.includes('PRIVATE_TOKEN')));
  assert(saved.includes('INDEPENDENT_AUDIT'));
});
