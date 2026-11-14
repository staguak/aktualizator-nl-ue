import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseBwbXml} from './bwb-parser.js';
import {parseNlLegalStructure} from './nl-legal-structure.js';
import {buildNlModel} from './nl-model.js';
import {renderNlModel} from './render.js';
import {nlActManifest,nlIndex,nlReport} from './nl-output.js';
import {OfficialSources} from './official-sources.js';
import {completeBuiltOutput} from './publication-validation.js';
import {readNlCheckpointFiles} from './nl-checkpoint.js';
import {stableJson,fileMetadata} from './output.js';
import {extractLegalBody,indexLegalDocument,legalHash} from './legal-structure.js';
import type {ScopeAct,VersionSnapshot,VersionRecord} from './types.js';
import {finalizePackageImages} from './package-images.js';

function fixture(t:import('node:test').TestContext){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nl-legal-output-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const scope:ScopeAct={order:1,title:'Complete law',bwbId:'BWBR0000001',include:{articles:['1']},mustIncludeArticles:['1'],retrievalScope:'full-act',outputProfile:'legal-structure-v1'};
  const archive=new OfficialSources('NL',scope.bwbId,{from:'2025-01-01',to:'2026-11-14',observedOn:'2026-11-14'});
  const snapshots:VersionSnapshot[]=[0,1].map(i=>{
    const version:VersionRecord={key:'version-'+i,validFrom:i?'2025-07-01':'2025-01-01',validTo:i?null:'2025-06-30',
      toestandUrl:`https://repository.officiele-overheidspublicaties.nl/bwb/BWBR0000001/state-${i}.xml`};
    const xml=`<toestand bwb-id="BWBR0000001" inwerkingtreding="${version.validFrom}"><wetgeving><intitule>Complete law</intitule>
      <aanhef><al>Original preamble.</al></aanhef><hoofdstuk nr="1"><kop><label>Chapter</label> <nr>1</nr></kop>
      <artikel nr="1"><kop><label>Artikel</label> <nr>1</nr></kop><lid nr="1"><al>${'Complete unchanged legal content. '.repeat(2300)}</al></lid></artikel>
      <artikel nr="2"><al>Additional legal article ${i}.</al></artikel></hoofdstuk>
      <bijlage id="annex"><al>Complete original annex ${i}.</al><table><tbody><tr><td>Cell ${i}</td></tr></tbody></table><plaatje url="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"/></bijlage>
      <wetsluiting><al>Official closing.</al></wetsluiting></wetgeving></toestand>`;
    const bytes=Buffer.from(xml),sourceSha256=legalHash(xml);
    archive.add(`states/${i}.xml`,{bytes,url:version.toestandUrl,contentType:'application/xml'},version.toestandUrl,'BWB-Toestand',{version});
    return {version,statute:parseBwbXml(xml),sourceSha256,legalDraft:parseNlLegalStructure(xml,{corpus:'NL',documentId:scope.bwbId,
      version:version.key,language:'NL',sourceUrl:version.toestandUrl,sourceSha256,metadata:{sourceState:version}})};
  });
  const rendered=renderNlModel(buildNlModel(scope,snapshots,'2025-01-01','2026-11-14'));
  const native=archive.build('01_BWBR0000001.sources.zip'),act={...nlActManifest(rendered,2),sourceArchive:native.metadata};
  const manifest={schemaVersion:2,validationVersion:2,jurisdiction:'NL',rangeFrom:'2025-01-01',rangeTo:'2026-11-14',generatedAt:'2026-11-14T00:00:00.000Z',
    normalization:{outputProfile:'legal-structure-v1'},officialSources:{originalBytes:true,model:'BWB'},acts:[act]};
  for(const chunk of rendered.chunks)fs.writeFileSync(path.join(directory,chunk.fileName),chunk.file.content);
  fs.writeFileSync(path.join(directory,native.metadata.name),native.bytes);
  const checkpoint=fs.mkdtempSync(path.join(os.tmpdir(),'nl-legal-checkpoint-'));t.after(()=>fs.rmSync(checkpoint,{recursive:true,force:true}));
  for(const name of [...act.files.map(f=>f.name),native.metadata.name])fs.copyFileSync(path.join(directory,name),path.join(checkpoint,name));
  fs.writeFileSync(path.join(directory,'manifest.json'),stableJson(manifest));fs.writeFileSync(path.join(directory,'INDEX.md'),nlIndex(manifest));
  return {directory,checkpoint,scope,snapshots,act,manifest,rendered};
}
test('the complete public NL path validates separate versions, natural boundaries and source-backed reconstruction',async t=>{
  const f=fixture(t);
  assert.equal(f.act.legalDocuments?.length,2);
  assert(f.act.files.some(file=>file.size>50000&&file.articles.length===2));
  const files=completeBuiltOutput(f.directory,[f.scope],result=>nlReport(f.manifest,null,result));
  assert(files.length>0);assert.match(fs.readFileSync(path.join(f.directory,'REPORT.md'),'utf8'),/Walidacja: PASS/);
  const cp=readNlCheckpointFiles(f.checkpoint,[f.act],{schemaVersion:2,source:{title:'Test',derivedAt:'2026-11-14'},acts:[f.scope]});
  assert(cp.size===f.act.files.length+1);
  const ids=f.act.legalDocuments!.map(doc=>doc.units.find(u=>u.kind==='article'&&u.reference==='1')!.id);
  assert.notEqual(ids[0],ids[1]);
  for(const doc of f.act.legalDocuments!)assert(doc.parts.every(part=>fs.readFileSync(path.join(f.directory,part.file),'utf8').includes(doc.version)));
  const before=f.act.files.map(file=>[file.name,fs.readFileSync(path.join(f.directory,file.name))] as const);
  const images=await finalizePackageImages(f.directory,[f.scope]);assert.equal(images.occurrences.length,2);assert.equal(images.assets.length,1);
  for(const [name,bytes]of before)assert.deepEqual(fs.readFileSync(path.join(f.directory,name)),bytes);
});
test('updating all generated hashes cannot hide a lost annex from the original-source checker',t=>{
  const f=fixture(t),document=f.act.legalDocuments![0],draft=f.snapshots[0].legalDraft!;
  const name=document.parts.find(p=>extractLegalBody(fs.readFileSync(path.join(f.checkpoint,p.file),'utf8')).includes('Complete original annex'))!.file;
  const changed=fs.readFileSync(path.join(f.checkpoint,name),'utf8').replace('Complete original annex','Altered annex');
  fs.writeFileSync(path.join(f.checkpoint,name),changed);
  Object.assign(f.act.files.find(file=>file.name===name)!,fileMetadata(name,Buffer.from(changed)));
  const names=document.parts.map(p=>p.file),bodies=names.map(n=>extractLegalBody(fs.readFileSync(path.join(f.checkpoint,n),'utf8')));
  f.act.legalDocuments![0]=indexLegalDocument({...draft,sourceFragmentIssues:document.sourceFragmentIssues},names,bodies);
  assert.throws(()=>readNlCheckpointFiles(f.checkpoint,[f.act],{schemaVersion:2,source:{title:'Test',derivedAt:'2026-11-14'},acts:[f.scope]}),/original source|original/);
});
