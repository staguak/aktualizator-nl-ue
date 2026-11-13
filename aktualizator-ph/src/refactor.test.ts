import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildNlModel } from './nl-model.js';
import { renderNlModel } from './render.js';
import { parseNlFinal } from './nl-final-parser.js';
import { nlActManifest, nlIndex, nlReport } from './nl-output.js';
import { finalizeEu, euIndex, euReport } from './eu-output.js';
import { htmlIntegrity } from './content-integrity.js';
import { hash, stableJson, normalizeOutput } from './output.js';
import { finalFile, writeControlFile } from './final-file.js';
import { completeBuiltOutput, validateOutput, validatePublicationSet } from './publication-validation.js';
import type { ScopeAct, VersionSnapshot } from './types.js';
import type { ValidationResult } from './validation-result.js';

function fixture(t:{after:(fn:()=>void)=>void},jurisdiction:'NL'|'EU') {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'law-final-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const base={schemaVersion:2,validationVersion:2,jurisdiction,generatedAt:'2026-10-06T12:00:00Z',rangeFrom:'2025-01-01',rangeTo:'2026-10-06'};
  if(jurisdiction==='NL'){
    const act:ScopeAct={order:1,title:'Test NL',bwbId:'BWBR0000001',include:{articles:['21','93']},mustIncludeArticles:['21','93']};
    const snapshot:VersionSnapshot={version:{key:'2025-01-01_0',validFrom:'2025-01-01',validTo:null,toestandUrl:'https://example.org/state.xml'},
      statute:{bwbId:act.bwbId,title:act.title,provisions:act.include.articles!.map(article=>({article,provisionRef:article,structurePath:'',content:'Geen wijziging: 12,5%.'}))}};
    const rendered=renderNlModel(buildNlModel(act,[snapshot],base.rangeFrom,base.rangeTo));
    const manifest={...base,acts:[nlActManifest(rendered,1)]};
    for(const chunk of rendered.chunks)fs.writeFileSync(path.join(dir,chunk.file.name),chunk.file.content);
    writeControlFile(dir,jurisdiction,'INDEX.md',nlIndex(manifest));writeControlFile(dir,jurisdiction,'manifest.json',stableJson(manifest));
    return {dir,acts:[act],report:(r:ValidationResult)=>nlReport(manifest,null,r),contentName:rendered.chunks[0].file.name};
  }
  const celex='32008L0104',body='<p id="a">Artikel 1: een norm.</p>',name='01_32008L0104__01.md';
  const built={order:1,title:'Test UE',celex,excludedDocuments:[],documents:[{celex,metadata:{},role:'original',include:'full-document',sourceUrl:'https://example.org/act',sourceSha256:hash(body),articleCount:1,textLength:body.length,integrity:htmlIntegrity(body)}],files:[{name,celex,part:1,md5:hash(body,'md5')}]};
  const output=finalizeEu([built],()=>body),manifest={...base,acts:output.acts,normalization:output.normalization};
  for(const file of output.files.values())fs.writeFileSync(path.join(dir,file.name),file.content);
  writeControlFile(dir,jurisdiction,'INDEX.md',euIndex(manifest));writeControlFile(dir,jurisdiction,'manifest.json',stableJson(manifest));
  return {dir,acts:[{order:1,celex,requiredVersions:[celex]}],report:(r:ValidationResult)=>euReport(manifest,null,r),contentName:name};
}
test('both modules finalize REPORT only after validation and independently read each corpus file once',t=>{
  for(const jurisdiction of ['NL','EU'] as const){
    const p=fixture(t,jurisdiction),statuses:string[]=[],bytes:number[]=[];
    const files=completeBuiltOutput(p.dir,p.acts,result=>{statuses.push(result.status);bytes.push(result.contentBytes);return p.report(result);});
    assert.deepEqual(statuses,['PENDING','PASS']);assert.ok(bytes[1]>0);
    assert.equal(files.find(f=>f.name==='REPORT.md')!.md5,hash(fs.readFileSync(path.join(p.dir,'REPORT.md')),'md5'));
    const counts=new Map<string,number>(),read=fs.readFileSync;
    const mock=t.mock.method(fs,'readFileSync',(file:fs.PathOrFileDescriptor,options?:any)=>{
      const key=String(file);if(key.startsWith(p.dir+path.sep))counts.set(key,(counts.get(key)??0)+1);
      return read(file,options);
    });
    validateOutput(p.dir,p.acts);mock.mock.restore();
    assert.equal(counts.size,4);assert.ok([...counts.values()].every(n=>n===1));
  }
});
test('pending, failed and contradictory REPORTs cannot pass the publication gate',t=>{
  for(const jurisdiction of ['NL','EU'] as const){
    const p=fixture(t,jurisdiction);
    fs.writeFileSync(path.join(p.dir,'REPORT.md'),p.report({status:'PENDING',checks:[],fileCount:0,contentFileCount:0,contentBytes:0}));
    assert.throws(()=>validateOutput(p.dir,p.acts),/report/);
    completeBuiltOutput(p.dir,p.acts,p.report);
    fs.appendFileSync(path.join(p.dir,'REPORT.md'),'Walidacja: FAIL — uszkodzony zestaw.\n');
    assert.throws(()=>validateOutput(p.dir,p.acts),/report/);
    fs.appendFileSync(path.join(p.dir,p.contentName),'corruption\n');
    const statuses:string[]=[];
    assert.throws(()=>completeBuiltOutput(p.dir,p.acts,r=>{statuses.push(r.status);return p.report(r);}));
    assert.deepEqual(statuses,['PENDING','FAIL']);assert.match(fs.readFileSync(path.join(p.dir,'REPORT.md'),'utf8'),/Walidacja: FAIL/);
  }
});
test('final byte model and shared validation enforce UTF-8, LF, whitespace and file identity',t=>{
  const content=normalizeOutput('ą  \r\n');
  const file=finalFile('act.md',content,{jurisdiction:'NL',kind:'content',metadata:{articles:['1']}});
  assert.equal(file.size,file.content.length);assert.equal(file.md5,hash(file.content,'md5'));
  assert.throws(()=>finalFile('../act.md',content,{jurisdiction:'NL',kind:'content',metadata:{articles:['1']}}));
  assert.throws(()=>finalFile('act.md','a  \r\n',{jurisdiction:'NL',kind:'content',metadata:{articles:['1']}}));
  for(const jurisdiction of ['NL','EU'] as const){
    const p=fixture(t,jurisdiction);completeBuiltOutput(p.dir,p.acts,p.report);
    const report=fs.readFileSync(path.join(p.dir,'REPORT.md'));
    for(const changed of [Buffer.from('bad\r\n'),Buffer.from('bad  \n'),Buffer.from([0xff,10]),Buffer.alloc(0)]){
      fs.writeFileSync(path.join(p.dir,'REPORT.md'),changed);assert.throws(()=>validateOutput(p.dir,p.acts));
    }
    fs.writeFileSync(path.join(p.dir,'REPORT.md'),report);
    fs.writeFileSync(path.join(p.dir,'obsolete__02.md'),'old\n');assert.throws(()=>validateOutput(p.dir,p.acts),/file list/);
  }
});
test('NL model/render roundtrip preserves every generated version, URL and chunk boundary property',()=>{
  let seed=0x5eed;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  for(let iteration=0;iteration<24;iteration++){
    const ids=Array.from({length:2+random()%8},(_,i)=>String(21+i*7));
    const act:ScopeAct={order:1,title:'Zażółć NL',bwbId:'BWBR0000001',include:{articles:ids},mustIncludeArticles:ids};
    const states:VersionSnapshot[]=Array.from({length:2+random()%11},(_,i)=>({
      version:{key:`2025-01-${String(i+1).padStart(2,'0')}_0`,validFrom:`2025-01-${String(i+1).padStart(2,'0')}`,validTo:null,toestandUrl:`https://example.org/${i}.xml`},
      statute:{bwbId:act.bwbId,title:act.title,provisions:ids.map((article,j)=>({article,provisionRef:article,structurePath:'',
        content:`Artikel ${article}: niet wijzigen; 12,5%. ${'ą'.repeat(50+random()%700)} ${Math.floor(i/(1+j%3))}`}))},
    }));
    const model=buildNlModel(act,states,'2025-01-01','2026-10-06'),rendered=renderNlModel(model);
    assert.deepEqual(renderNlModel(buildNlModel(act,[...states].reverse(),'2025-01-01','2026-10-06')).chunks.map(c=>c.content),rendered.chunks.map(c=>c.content));
    const restored=rendered.chunks.flatMap(c=>parseNlFinal(c.content));
    assert.deepEqual(restored.map(a=>a.articleId),model.selectedArticles);
    for(const [i,a]of restored.entries())assert.deepEqual(a.versions.map(v=>[v.validFrom,v.validTo,v.content,v.sourceUrls]),model.articles[i].versions.map(v=>[v.validFrom,v.validTo,v.content,v.sourceUrls]));
    for(const chunk of rendered.chunks){assert.equal(chunk.file.md5,hash(chunk.file.content,'md5'));assert.equal(chunk.file.size,Buffer.byteLength(chunk.content));assert.ok(chunk.file.size<=50_000||chunk.articles.length===1);}
  }
});
test('historical diagnostics remain readable but strict publication accepts only v2',t=>{
  const nl=fixture(t,'NL'),eu=fixture(t,'EU');completeBuiltOutput(nl.dir,nl.acts,nl.report);completeBuiltOutput(eu.dir,eu.acts,eu.report);
  const targets=[{jurisdiction:'NL' as const,dir:nl.dir,acts:nl.acts},{jurisdiction:'EU' as const,dir:eu.dir,acts:eu.acts}];
  assert.doesNotThrow(()=>validatePublicationSet(targets,{requireV2:true}));
  const manifest=JSON.parse(fs.readFileSync(path.join(nl.dir,'manifest.json'),'utf8'));manifest.schemaVersion=1;manifest.validationVersion=1;
  fs.writeFileSync(path.join(nl.dir,'manifest.json'),stableJson(manifest));
  assert.doesNotThrow(()=>validateOutput(nl.dir,nl.acts));assert.throws(()=>validatePublicationSet(targets,{requireV2:true}),/v2/);
});
