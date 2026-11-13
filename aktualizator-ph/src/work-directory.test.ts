import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {assertWorkDirectory} from './work-directory.js';

test('work roots reject existing and dangling directory symlinks without touching their targets',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'work-directory-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const target=path.join(root,'preserved'),link=path.join(root,'checkpoint'),dangling=path.join(root,'dangling');
  fs.mkdirSync(target);fs.writeFileSync(path.join(target,'evidence'),'preserve me');
  fs.symlinkSync(target,link,'dir');fs.symlinkSync(path.join(root,'missing'),dangling,'dir');
  assert.throws(()=>assertWorkDirectory(link),/real directory/);assert.throws(()=>assertWorkDirectory(dangling),/real directory/);
  assert.equal(fs.readFileSync(path.join(target,'evidence'),'utf8'),'preserve me');
  assert.doesNotThrow(()=>assertWorkDirectory(target));assert.doesNotThrow(()=>assertWorkDirectory(path.join(root,'new')));
});
