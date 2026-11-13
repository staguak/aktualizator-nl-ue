import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {executionRevision} from './execution-revision.js';

test('local checkpoints invalidate parser/model/validation/lock changes but preserve documentation-only reuse',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'execution-revision-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const dir of ['src','scripts','docs'])fs.mkdirSync(path.join(root,dir));
  const files=['src/parser.ts','src/model.ts','package-lock.json','scripts/xml_validation.py','scripts/xml-requirements.txt','scripts/rdf-requirements.txt'];
  for(const file of files)fs.writeFileSync(path.join(root,file),'original '+file);
  const before=executionRevision(root,{});assert.match(before,/^local-[a-f0-9]{64}$/);
  for(const file of files){const target=path.join(root,file),bytes=fs.readFileSync(target);
    fs.writeFileSync(target,Buffer.concat([bytes,Buffer.from('changed')]));assert.notEqual(executionRevision(root,{}),before);fs.writeFileSync(target,bytes);}
  fs.writeFileSync(path.join(root,'docs/status.md'),'new documentation');fs.writeFileSync(path.join(root,'src/model.test.ts'),'new tests');
  assert.equal(executionRevision(root,{}),before);
  assert.equal(executionRevision(root,{LAW_UPDATER_REVISION:'immutable-workflow-sha'}),'immutable-workflow-sha');
  fs.unlinkSync(path.join(root,'src/model.ts'));fs.symlinkSync(path.join(root,'src/parser.ts'),path.join(root,'src/model.ts'));
  assert.throws(()=>executionRevision(root,{}),/regular source files/);
});
