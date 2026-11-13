import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readEuCheckpointFiles} from './eu-checkpoint.js';
import {OfficialSources,sourceArchiveName} from './official-sources.js';
import {parseEuHtml} from './eu-parser.js';
import type {EuAct} from './eu-provider.js';
import type {EuBuiltAct} from './eu-model.js';
import {hash} from './release-store.js';

function fixture(t:import('node:test').TestContext){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'eu-checkpoint-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const scope:EuAct[]=[1,2].map(order=>({order,celex:`32024R000${order}`,title:`Fixture ${order}`,
    include:'full-document',requiredVersions:[],attachedDocuments:[]}));
  const acts:EuBuiltAct[]=scope.map(act=>{
    const url=`https://publications.europa.eu/resource/celex/${act.celex}`;
    const html='<html lang="en"><body><p>REGULATION</p><p>Article 1</p><p>'+ 'Official fixture text. '.repeat(50)+'</p></body></html>';
    const parsed=parseEuHtml(html,url,'full-document','EN');
    const sources=new OfficialSources('EU',act.celex,{from:'2025-01-01',to:'2026-10-17',observedOn:'2026-10-17'});
    sources.add('documents/text.xhtml',{bytes:Buffer.from(html),url,contentType:'application/xhtml+xml'},url,'CELLAR-XHTML',{celex:act.celex});
    const native=sources.build(sourceArchiveName(act.order,act.celex));fs.writeFileSync(path.join(dir,native.metadata.name),native.bytes);
    const files=parsed.chunks.map((body,i)=>{
      const name=`${act.order}_${act.celex}__${i+1}.md`;fs.writeFileSync(path.join(dir,name),body);
      return {name,celex:act.celex,part:i+1,md5:hash(Buffer.from(body),'md5')};
    });
    return {...act,sourceArchive:native.metadata,documents:[{celex:act.celex,role:'original',include:'full-document',metadata:{},
      language:'EN',sourceUrl:url,sourceSha256:hash(Buffer.from(html)),articleCount:parsed.articleCount,
      textLength:html.length,integrity:parsed.integrity}],files,excludedDocuments:[]};
  });
  return {dir,scope,acts};
}
test('EU checkpoint accepts complete acts, verifies native bytes and returns a stable byte snapshot',t=>{
  const {dir,scope,acts}=fixture(t),files=readEuCheckpointFiles(dir,acts,scope);
  const name=acts[0].files[0].name,bytes=Buffer.from(files.get(name)!);
  fs.writeFileSync(path.join(dir,name),'changed after validation');
  assert.deepEqual(files.get(name),bytes);assert.throws(()=>readEuCheckpointFiles(dir,acts,scope),/checksum/);
});
test('EU checkpoint rejects symlinked archives and content even when their checksums match',t=>{
  for(const archive of [false,true]){
    const {dir,scope,acts}=fixture(t),name=archive?acts[0].sourceArchive!.name:acts[0].files[0].name;
    const original=path.join(dir,name),other=path.join(dir,'outside');fs.renameSync(original,other);fs.symlinkSync(other,original);
    assert.throws(()=>readEuCheckpointFiles(dir,acts,scope),/regular files/);
  }
});
test('EU checkpoint rejects duplicate acts, shared file names, missing parts and unsupported document files',t=>{
  const {dir,scope,acts}=fixture(t);
  assert.throws(()=>readEuCheckpointFiles(dir,[acts[0],acts[0]],scope),/scope/);
  for(const mutate of [
    (copy:EuBuiltAct[])=>{copy[1].sourceArchive!.name=copy[0].sourceArchive!.name;},
    (copy:EuBuiltAct[])=>{copy[0].files[0].part=2;},
    (copy:EuBuiltAct[])=>{copy[0].files[0].celex='32000R0001';},
    (copy:EuBuiltAct[])=>{copy[0].files[0].name='../outside.md';},
    (copy:EuBuiltAct[])=>{copy[0].documents.push(copy[0].documents[0]);},
  ]){
    const copy=structuredClone(acts);mutate(copy);assert.throws(()=>readEuCheckpointFiles(dir,copy,scope));
  }
});
