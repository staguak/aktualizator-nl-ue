import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseEuHtml} from './eu-parser.js';
import {finalizeEu,euIndex,euReport} from './eu-output.js';
import {OfficialSources} from './official-sources.js';
import {hash,stableJson} from './output.js';
import {completeBuiltOutput} from './publication-validation.js';
import {extractLegalBody,validateLegalDocument} from './legal-structure.js';
import {readEuCheckpointFiles} from './eu-checkpoint.js';
import {htmlIntegrity} from './content-integrity.js';
import {finalizePackageImages} from './package-images.js';
import type {EuBuiltAct} from './eu-model.js';
import type {EuAct} from './eu-provider.js';

function fixture(t:import('node:test').TestContext){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'eu-structure-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const scope:EuAct={order:1,title:'Regulation',celex:'32024R0001',include:'full-document',requiredVersions:[],attachedDocuments:[],outputProfile:'legal-structure-v1'};
  const bodies=new Map<string,string>(),archive=new OfficialSources('EU',scope.celex,{from:'2024-01-01',to:'2026-11-14',observedOn:'2026-11-14'});
  const act:EuBuiltAct={order:1,title:scope.title,celex:scope.celex,documents:[],files:[],excludedDocuments:[]};
  for(const [i,celex] of ['32024R0001','02024R0001-20250101'].entries()){
    const html='<html lang="en"><head><style>.preserved {white-space:pre-wrap}</style></head><body><p>Regulation</p><p>CHAPTER I</p>'+ 
      '<p id="art1" class="oj-ti-art">Article 1</p><p class="preserved">  '+ 'Legal text. '.repeat(70)+'  </p><a href="#annex">See annex</a>'+ 
      '<p id="annex">ANNEX I</p><table><tr><td>All annex content.</td></tr></table></body></html>';
    const url='https://publications.europa.eu/'+celex+'.xhtml',sourceSha256=hash(html);
    const parsed=parseEuHtml(html,url,'full-document','EN',{corpus:'EU',documentId:celex,version:celex,language:'EN',sourceUrl:url,sourceSha256});
    archive.add(`documents/${i}.xhtml`,{bytes:Buffer.from(html),url,contentType:'application/xhtml+xml'},url,'CELLAR-XHTML',{celex,language:'EN',include:'full-document'});
    act.documents.push({celex,include:'full-document',role:'basic',metadata:{resource_legal_id_celex:[celex]},outputProfile:'legal-structure-v1',language:'EN',sourceUrl:url,
      sourceSha256,integrity:parsed.integrity,articleCount:parsed.articleCount,textLength:parsed.textLength,legalDraft:parsed.legalDraft});
    parsed.chunks.forEach((body,p)=>{const name=`d${i}_${p}.md`;bodies.set(name,body);act.files.push({name,celex,part:p+1,md5:hash(body,'md5')});});
  }
  const native=archive.build('01_32024R0001.sources.zip');act.sourceArchive=native.metadata;
  fs.writeFileSync(path.join(dir,native.metadata.name),native.bytes);
  return {dir,scope,act,bodies,native};
}
test('EU finalization preserves structural manifests through navigation, canonical references and exact reconstruction',async t=>{
  const f=fixture(t),final=finalizeEu([f.act],n=>f.bodies.get(n)!);
  for(const file of final.files.values())fs.writeFileSync(path.join(f.dir,file.name),file.content);
  const manifest={schemaVersion:2,validationVersion:2,jurisdiction:'EU',rangeFrom:'2024-01-01',rangeTo:'2026-11-14',generatedAt:'2026-11-14T00:00:00.000Z',language:'EN',
    officialSources:{originalBytes:true,model:'CELLAR'},normalization:final.normalization,acts:final.acts};
  assert(final.acts[0].documents.every(d=>d.legalStructure?.profile==='legal-structure-v1'));
  assert(final.acts[0].files.some(f=>f.kind==='reference'));
  const documents=final.acts[0].documents;
  assert.notEqual(documents[0].legalStructure!.units[0].id,documents[1].legalStructure!.units[0].id);
  for(const doc of documents){const result=validateLegalDocument(doc.legalStructure!,name=>extractLegalBody(final.outputs.get(name)!));assert(result.includes('  Legal text. '));}
  fs.writeFileSync(path.join(f.dir,'manifest.json'),stableJson(manifest));fs.writeFileSync(path.join(f.dir,'INDEX.md'),euIndex(manifest));
  completeBuiltOutput(f.dir,[f.scope],r=>euReport(manifest,null,r));
  assert.match(fs.readFileSync(path.join(f.dir,'REPORT.md'),'utf8'),/Walidacja: PASS/);
  await finalizePackageImages(f.dir,[f.scope]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'IMAGE_INDEX.json'),'utf8')).profile,'legal-images-v1');
});
test('structured EU checkpoint requires original text and refuses a changed body even with recomputed file checksums',t=>{
  const f=fixture(t);
  for(const [name,body]of f.bodies)fs.writeFileSync(path.join(f.dir,name),body);
  assert.equal(readEuCheckpointFiles(f.dir,[f.act],[f.scope]).size,f.act.files.length+1);
  const file=f.act.files[0],changed=f.bodies.get(file.name)!.replace('Legal text.','Changed law.');
  fs.writeFileSync(path.join(f.dir,file.name),changed);file.md5=hash(changed,'md5');
  // The original SHA and structural evidence must still win over generated hashes.
  f.act.documents[0].integrity=htmlIntegrity(f.act.files.filter(p=>p.celex===file.celex).sort((a,b)=>a.part-b.part).map(p=>fs.readFileSync(path.join(f.dir,p.name),'utf8')).join(''));
  assert.throws(()=>readEuCheckpointFiles(f.dir,[f.act],[f.scope]),/original|integrity|Integrity|fingerprint/);
});
