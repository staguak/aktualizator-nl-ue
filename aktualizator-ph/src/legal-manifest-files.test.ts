import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {writeCorpusManifest,loadCorpusManifest} from './legal-manifest-files.js';
import {parseNlLegalStructure} from './nl-legal-structure.js';
import {indexLegalDocument,legalHash} from './legal-structure.js';

test('version index storage reconstructs exact logical metadata and rejects missing, foreign, oversized or unsafe references',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'legal-index-storage-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const xml='<toestand bwb-id="BWBR0000001"><wetgeving><artikel nr="1"><al>Full original text.</al></artikel></wetgeving></toestand>';
  const draft=parseNlLegalStructure(xml,{corpus:'NL',documentId:'BWBR0000001',version:'v1',language:'NL',sourceUrl:'https://official.example/state.xml',sourceSha256:legalHash(xml)});
  const logical=indexLegalDocument(draft,['body.md'],draft.chunks.map(c=>c.body));
  const input={jurisdiction:'NL',acts:[{legalDocuments:[logical]}]};writeCorpusManifest(dir,input);
  const disk=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8')),read=(name:string)=>fs.readFileSync(path.join(dir,name));
  assert.deepEqual(loadCorpusManifest(disk,read).manifest.acts[0].legalDocuments[0],logical);
  assert.deepEqual(input.acts[0].legalDocuments[0],logical);
  for(const edit of [(r:any)=>{r.file='../manifest.json';},(r:any)=>{r.size=95_000_001;},(r:any)=>{r.language='PL';},(r:any)=>{r.extra='unverified';}]){
    const changed=structuredClone(disk);edit(changed.acts[0].legalDocuments[0]);assert.throws(()=>loadCorpusManifest(changed,read));
  }
  const missing=structuredClone(disk);delete missing.legalDocumentStorage;assert.throws(()=>loadCorpusManifest(missing,read));
  assert.throws(()=>loadCorpusManifest({...input,legalDocumentStorage:'legal-document-files-v1'},read));
});
