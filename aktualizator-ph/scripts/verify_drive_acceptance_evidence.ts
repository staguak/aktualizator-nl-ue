/** Independently bind exported checkpoint receipts to the committed base. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {hash,encode} from '../src/release-store.js';
import {validateContext,validateManifest,validatePointer} from '../src/release-engine.js';

const [directory,reportPath]=process.argv.slice(2);
if(!directory||!reportPath)throw new Error('Pass the unmodified read-only base export and report path.');
const raw=fs.readFileSync(path.join(directory,'generation.json')),base:unknown=JSON.parse(raw.toString());
validateManifest(base);assert.equal(base.kind,'base');
const active=JSON.parse(fs.readFileSync(path.join(directory,'active.json'),'utf8'));
validatePointer(active);
assert.equal(active.baseManifestSha256,hash(raw));assert.equal(active.baseId,base.context.baseId);
assert.equal(base.context.mode,'initialize');assert.equal(base.context.parentReleaseId,null);
// A subsequent update/rollback still uses this exact immutable baseline.
// Reuse receipts belong to its producer, not the current pointer operation.
const expected:Record<string,Set<string>>={},sourceArchives:Record<string,Record<string,string>>={};
for(const module of ['NL','EU']){
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,module,'manifest.json'),'utf8'));
  assert.equal(manifest.jurisdiction,module);
  assert.equal(manifest.rangeFrom,base.context.rangeFrom);assert.equal(manifest.rangeTo,base.context.rangeFrom);
  const ids=manifest.acts.map((act:any)=>module==='NL'?act.bwbId:act.celex);
  assert(ids.every((id:unknown)=>typeof id==='string'&&id.length>0));
  expected[module]=new Set(ids);assert.equal(expected[module].size,ids.length);
  sourceArchives[module]=Object.fromEntries(manifest.acts.map((act:any)=>{
    const name=act.sourceArchive?.name;assert(typeof name==='string'&&name===path.basename(name));
    const reference=base.files.find(file=>file.jurisdiction===module&&file.name===name);assert(reference,'Archive is not anchored in this base');
    const digest=hash(fs.readFileSync(path.join(directory,module,name)));assert.equal(digest,reference.sha256);
    return [module==='NL'?act.bwbId:act.celex,digest];
  }));
}
for(const file of base.files){
  assert.equal(path.basename(file.name),file.name);
  const bytes=fs.readFileSync(path.join(directory,file.jurisdiction,file.name));
  assert.equal(bytes.length,file.size);assert.equal(hash(bytes),file.sha256);assert.equal(hash(bytes,'md5'),file.md5);
}
const index=JSON.parse(fs.readFileSync(path.join(directory,'checkpoint-evidence.json'),'utf8'));
assert.equal(index.runId,base.context.runId);const events:any[]=[],keys=new Set<string>();
for(const row of index.records){
  assert(!keys.has(row.key));keys.add(row.key);
  assert.equal(row.file,`checkpoints/${row.key.replaceAll('/','_')}`);
  const bytes=fs.readFileSync(path.join(directory,row.file));assert.equal(hash(bytes),row.sha256);
  const event=JSON.parse(bytes.toString());validateContext(event.context);
  assert.deepEqual(event.context,base.context);assert.equal(event.schemaVersion,1);
  events.push({...event,evidenceKey:row.key,sha256:row.sha256});
}
const interruption=events.find(e=>e.evidenceKey.startsWith('checks/faults/')&&e.phase==='base'&&e.module==='NL'&&e.completedActs>=2);
assert(interruption,'Missing exact durable NL interruption receipt');
const restored=[];
for(const module of ['NL','EU']){
  const receipt=events.find(e=>{
    if(!e.evidenceKey.startsWith('checks/resumes/')||e.phase!=='base'||e.module!==module)return false;
    const ids=e.completedActIds;
    assert(Array.isArray(ids)&&ids.every((id:unknown)=>typeof id==='string'&&expected[module].has(id)));
    assert.equal(new Set(ids).size,ids.length);
    return module==='NL'?ids.length>=2:ids.length===expected.EU.size;
  });
  assert(receipt,`Missing actual ${module} checkpoint reuse receipt`);
  assert(typeof receipt.effectiveCheckpointKey==='string'&&receipt.effectiveCheckpointKey.length>0);
  const resumedAt=Date.parse(receipt.at),interruptedAt=Date.parse(interruption.confirmedAt);
  assert(Number.isFinite(resumedAt)&&Number.isFinite(interruptedAt)&&resumedAt>=interruptedAt);
  restored.push({module,receiptKey:receipt.evidenceKey,receiptSha256:receipt.sha256,at:receipt.at,
    effectiveCheckpointKey:receipt.effectiveCheckpointKey,
    acts:receipt.completedActIds.map((id:string)=>({id,baseSourceArchiveSha256:sourceArchives[module][id]}))});
}
assert(expected.EU.size>=63,'Baseline no longer meets the established minimum');
assert(expected.NL.size>=2,'Baseline no longer meets the established NL minimum');
const report={status:'PASS',scope:'Exact durable base interruption/reuse receipts and all anchored base bytes; combine with the workflow local-removal and no-recomputation evidence, not a standalone network-exclusion assertion',
  codeRevision:base.context.codeRevision,baseId:active.baseId,releaseId:active.releaseId,
  activeOperationId:active.operationId,baseProducerReleaseId:base.context.releaseId,baseOperationId:base.context.runId,
  baseManifestSha256:hash(raw),baseFiles:base.files.length,rangeStart:base.context.rangeFrom,
  baseActs:{NL:expected.NL.size,EU:expected.EU.size},interruption:{key:interruption.evidenceKey,sha256:interruption.sha256,
    completedActs:interruption.completedActs,at:interruption.confirmedAt},restored};
fs.writeFileSync(reportPath,encode(report),{flag:'wx'});console.log(JSON.stringify({status:report.status,baseFiles:report.baseFiles,restored:restored.map(r=>({module:r.module,acts:r.acts.length}))}));
