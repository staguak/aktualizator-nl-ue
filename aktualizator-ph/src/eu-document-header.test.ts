import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readEuTitle,euDocumentHeader,euHeaderDateLines,euHeaderMetadata} from './eu-document-header.js';
import {parseEuHtml} from './eu-parser.js';
import {finalizeEu,euIndex,euReport} from './eu-output.js';
import {OfficialSources,loadSourceArchive} from './official-sources.js';
import {verifyEuLegalAct} from './eu-legal-verification.js';
import {readEuCheckpointFiles,upgradeEuCheckpointHeaders} from './eu-checkpoint.js';
import {completeBuiltOutput} from './publication-validation.js';
import {writeCorpusManifest} from './legal-manifest-files.js';
import {finalizePackageImages} from './package-images.js';
import {hash} from './release-store.js';
import {fileMetadata} from './output.js';
import type {EuBuiltAct} from './eu-model.js';
import type {EuLanguage} from './eu-language.js';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const audit=(directory:string)=>spawnSync(process.env.LAW_IMAGE_PYTHON??'python3',['-c',"import sys;from pathlib import Path;sys.path.insert(0,'scripts');from verify_official_output import audit;audit(Path(sys.argv[1]),'EU')",directory],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{PATH:process.env.PATH},encoding:'utf8',timeout:60000});
const languages={EN:['REGULATION','Corrigendum','JUDGMENT OF THE COURT','Judgment notice','Article'],PL:['ROZPORZĄDZENIE','Sprostowanie','WYROK TRYBUNAŁU','Komunikat dotyczący wyroku','Artykuł'],NL:['VERORDENING','Rectificatie','ARREST VAN HET HOF','Mededeling betreffende het arrest','Artikel'],FR:['RÈGLEMENT','Rectificatif','ARRÊT DE LA COUR','Communication concernant un arrêt','Article']};
function fixture(t:import('node:test').TestContext,language:EuLanguage='EN'){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'eu-document-header-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const scope={order:1,title:'Family grouping label only',celex:'32024R0001',include:'full-document' as const,requiredVersions:[],attachedDocuments:[],outputProfile:'legal-structure-v1' as const};
  const act:EuBuiltAct={...scope,documents:[],files:[],excludedDocuments:[]},bodies=new Map<string,string>(),rawBodies=new Map<string,string>();
  const archive=new OfficialSources('EU',scope.celex,{from:'2024-01-01',to:'2026-11-15',observedOn:'2026-11-15'}),rows:any[]=[];
  for(const [i,id]of ['32024R0001','02024R0001-20250101','32024R0001R(01)','62023CJ0019','62023CA0019'].entries()){
    const parts=i===1?[languages[language][0],'of 3 January 2024','Complete original subject','(EU) 2024/1']:i===3?[languages[language][2],'(Second Chamber)','10 October 2025']:[languages[language][i===2?1:i===4?3:0],id];
    const className=i===1?'title-doc-first':i===3?'coj-sum-title-1':'oj-doc-ti';
    const toc={EN:'Table of Contents',PL:'Spis treści',NL:'Inhoudsopgave',FR:'Table des matières'}[language];
    const title=parts.map((p,j)=>`<p class="${i===1&&j===parts.length-1?'title-doc-last':className}">${p}</p>`).join('')+(i===3?`<p class="coj-sum-title-1">${toc}</p>`:'');
    const html=`<html lang="${language.toLowerCase()}"><head><title>${id}.xml</title></head><body>${title}<p class="oj-ti-art">${languages[language][4]} 1</p><p>${'Official legal content. '.repeat(50)}</p><img alt="formula" src="data:image/png;base64,${png}"><p>ANNEX I</p><p class="oj-doc-ti">Annex title must not become document title</p></body></html>`;
    const metadata={work_date_document:[['2024-01-03','2025-01-01','2024-02-04','2025-10-10','2025-10-24'][i]],'official-journal-act_date_publication':[['2024-01-11','2025-01-09','2024-02-11','2025-10-20','2025-11-01'][i]]};
    for(const[key,values]of Object.entries(metadata))for(const value of values)rows.push({id:{value:id},p:{value:'http://publications.europa.eu/ontology/cdm#'+key},v:{value}});
    const url=`https://publications.europa.eu/${language}/${id}.xhtml`,sha=hash(Buffer.from(html));
    const parsed=parseEuHtml(html,url,'full-document',language,{corpus:'EU',documentId:id,version:id,language,sourceUrl:url,sourceSha256:sha});
    archive.add(`documents/${i}.xhtml`,{bytes:Buffer.from(html),url,contentType:'application/xhtml+xml'},url,'CELLAR-XHTML',{celex:id,language,include:'full-document'});
    act.documents.push({celex:id,role:'original',include:'full-document',outputProfile:'legal-structure-v1',metadata,language,sourceUrl:url,sourceSha256:sha,header:euDocumentHeader(parsed.titleEvidence!,id,metadata),legalDraft:parsed.legalDraft,integrity:parsed.integrity,articleCount:parsed.articleCount,textLength:parsed.textLength});
    parsed.chunks.forEach((body,p)=>{const name=`doc${i}_${p}.md`;bodies.set(name,body);rawBodies.set(name,body);fs.writeFileSync(path.join(dir,name),body);act.files.push({name,celex:id,part:p+1,md5:hash(Buffer.from(body),'md5')});});
  }
  rows.push({id:{value:'32000R9999'},p:{value:'http://publications.europa.eu/ontology/cdm#work_date_document'},v:{value:'1999-01-01'}});
  const url='https://publications.europa.eu/webapi/rdf/sparql';archive.add('discovery.json',{bytes:Buffer.from(JSON.stringify({results:{bindings:rows}})),url,contentType:'application/json'},url,'CELLAR-SPARQL');
  const native=archive.build('01_headers.sources.zip');act.sourceArchive=native.metadata;fs.writeFileSync(path.join(dir,native.metadata.name),native.bytes);
  return {dir,scope,act,bodies,rawBodies,native,originals:loadSourceArchive(native.bytes,native.metadata,'EU',scope.celex)};
}
test('initial complete title blocks exclude annexes and technical head titles are fallback only',()=>{
  const html='<head><title>technical.xml</title></head><body><p>Journal header</p><p class="title-doc-first">REGULATION</p><p class="title-doc-first">of 3 January</p><p class="title-doc-first">Full subject</p><p class="title-doc-last">(EU) 2024/1</p><p>Article 1</p><p class="title-doc-last">Annex title</p></body>';
  const title=readEuTitle(html,'https://publications.europa.eu/a',hash(Buffer.from(html)),'32024R0001');
  assert.equal(title.value,'REGULATION of 3 January Full subject (EU) 2024/1');assert.equal(title.provenance.fragments.length,4);
  assert.equal(readEuTitle('<title>32024R0001.xml</title><body><p>ANNEX I</p><p class="oj-doc-ti">Not a document title</p></body>','https://publications.europa.eu/a','a'.repeat(64),'32024R0001').value,'CELEX 32024R0001');
  const legacy=readEuTitle('<title>EUR-Lex - 32024R0001</title><h1>32024R0001</h1><p><strong>Official full title</strong><em>Journal citation</em></p><div><p>Legal content</p></div>','https://publications.europa.eu/a','a'.repeat(64),'32024R0001');
  assert.equal(legacy.value,'Official full title');assert.equal(legacy.provenance.kind,'legacy-xhtml-title');
});
test('document, consolidation and publication dates remain distinct and ambiguous or invalid dates are never guessed',()=>{
  const title=readEuTitle('<title>Original regulation</title>','https://publications.europa.eu/a','a'.repeat(64));
  const h=euDocumentHeader(title,'02024R0001-20250101',{work_date_document:['2024-01-03'],'official-journal-act_date_publication':['2024-01-11'],work_date_creation_legacy:['1900-01-01']});
  assert.equal(h.dates.document.value,'2024-01-03');assert.equal(h.dates.consolidation.value,'2025-01-01');assert.equal(h.dates.publication.value,'2024-01-11');
  for(const values of [[],['2024-01-03','2024-02-03'],['2024-02-30']]){
    const unknown=euDocumentHeader(title,'32024R0001',{work_date_document:values,act_consolidated_date:['2025-01-01'],work_date_creation_legacy:['1900-01-01']});assert.equal(unknown.dates.document.value,null);assert(!euHeaderDateLines(unknown).includes('1900-01-01'));
  }
  assert.deepEqual(euHeaderMetadata('32024R0001',{entries:[{kind:'CELLAR-SPARQL',name:'invalid.json'}],discovery:{unavailable:true}},{'invalid.json':Buffer.from('Malformed official catalog')}),{},'An explicitly unavailable catalog must leave dates unknown while document processing continues');
  const cases=Buffer.from(JSON.stringify({results:{bindings:[{id:{value:'62023CJ0019'},date:{value:'2025-10-10'}},{id:{value:'62023CA0019'},date:{value:'2025-10-24'}}]}}));
  assert.deepEqual(euHeaderMetadata('62023CA0019',{entries:[{kind:'CELLAR-case-catalog',name:'cases.json'}]},{'cases.json':cases}),{work_date_document:['2025-10-24']},'A notice must not borrow the judgment date from the same case');
});
test('different family documents, corrigenda, judgment and notice have source-backed headers in EN/PL/NL/FR before and after Base64',async t=>{
  for(const language of ['EN','PL','NL','FR'] as const){
    const f=fixture(t,language),final=finalizeEu([f.act],n=>f.bodies.get(n)!);
    assert.equal(final.acts[0].title,f.scope.title);
    for(const doc of final.acts[0].documents){
      assert(doc.header);assert(!doc.header.title.value.includes('Annex title'));
      assert(!/Table of Contents|Spis treści|Inhoudsopgave|Table des matières/i.test(doc.header.title.value));
      for(const part of doc.legalStructure!.parts){const text=final.outputs.get(part.file)!;assert(!text.startsWith('# '+f.scope.title));assert(text.includes(euHeaderDateLines(doc.header)));}
    }
    verifyEuLegalAct(final.acts[0],f.originals.index,f.originals.items,n=>final.outputs.get(n)!);
    for(const file of final.files.values())fs.writeFileSync(path.join(f.dir,file.name),file.content);
    const manifest={schemaVersion:2,validationVersion:2,jurisdiction:'EU',rangeFrom:'2024-01-01',rangeTo:'2026-11-15',generatedAt:'2026-11-15',language,officialSources:{originalBytes:true},acts:final.acts,normalization:final.normalization};
    writeCorpusManifest(f.dir,manifest);fs.writeFileSync(path.join(f.dir,'INDEX.md'),euIndex(manifest));completeBuiltOutput(f.dir,[f.scope],r=>euReport(manifest,null,r));
    const images=await finalizePackageImages(f.dir,[f.scope]);assert.equal(images.unavailableImages!.length,0);
    assert(fs.readFileSync(path.join(f.dir,'INDEX.md'),'utf8').includes(f.scope.title));
    const independent=audit(f.dir);assert.equal(independent.status,0,independent.stderr);
  }
});
test('changing only a generated title or date is rejected after recomputing output hashes; matching forged manifest also fails',t=>{
  const f=fixture(t),final=finalizeEu([f.act],n=>f.bodies.get(n)!),file=[...final.files.values()].find(f=>f.metadata.celex==='32024R0001')!;
  for(const replacement of [(s:string)=>s.replace(/^# .*$/m,'# Forged title'),(s:string)=>s.replace('Data dokumentu (work_date_document): 2024-01-03','Data dokumentu (work_date_document): 2024-01-04')]){
    const text=replacement(final.outputs.get(file.name)!);assert.notEqual(text,final.outputs.get(file.name));const changed=structuredClone(final.acts[0]);Object.assign(changed.files.find(p=>p.name===file.name)!,fileMetadata(file.name,Buffer.from(text)));
    assert.throws(()=>verifyEuLegalAct(changed,f.originals.index,f.originals.items,n=>n===file.name?text:final.outputs.get(n)!),/header differs/);
    for(const output of final.files.values())fs.writeFileSync(path.join(f.dir,output.name),output.name===file.name?text:output.content);
    const manifest={schemaVersion:2,validationVersion:2,jurisdiction:'EU',rangeFrom:'2024-01-01',rangeTo:'2026-11-15',generatedAt:'2026-11-15',language:'EN',officialSources:{originalBytes:true},acts:[changed],normalization:final.normalization};
    writeCorpusManifest(f.dir,manifest);fs.writeFileSync(path.join(f.dir,'INDEX.md'),euIndex(manifest));
    assert.throws(()=>completeBuiltOutput(f.dir,[f.scope],r=>euReport(manifest,null,r)),/header differs/);
    const independent=audit(f.dir);assert.notEqual(independent.status,0);assert.match(independent.stderr,/EU generated (?:title|date) differs/);
    changed.documents.find(d=>d.celex===file.metadata.celex)!.header!.title.value='Forged title';
    assert.throws(()=>verifyEuLegalAct(changed,f.originals.index,f.originals.items,n=>n===file.name?text:final.outputs.get(n)!),/title or dates differ/);
    writeCorpusManifest(f.dir,manifest);fs.writeFileSync(path.join(f.dir,'INDEX.md'),euIndex(manifest));
    const forged=audit(f.dir);assert.notEqual(forged.status,0);assert.match(forged.stderr,/EU title\/date metadata differs/);
  }
});
test('legacy checkpoints upgrade only from verified originals, preserve source bytes and reject forged existing headers',t=>{
  const f=fixture(t),old=structuredClone(f.act);old.documents.forEach(d=>delete d.header);
  old.title='Old primary document title instead of family label';
  assert.throws(()=>readEuCheckpointFiles(f.dir,[old],[f.scope]),/title or dates/);
  const upgraded=upgradeEuCheckpointHeaders(f.dir,[old],[f.scope]);assert.deepEqual(upgraded,[f.act]);assert(old.documents.every(d=>!d.header));assert(fs.readFileSync(path.join(f.dir,f.native.metadata.name)).equals(f.native.bytes));
  const corrupt=structuredClone(f.act);corrupt.documents[0].header!.dates.document.value='1900-01-01';
  assert.throws(()=>upgradeEuCheckpointHeaders(f.dir,[corrupt],[f.scope]),/title or dates/);
  fs.writeFileSync(path.join(f.dir,f.act.files[0].name),'Changed legal body');
  assert.throws(()=>upgradeEuCheckpointHeaders(f.dir,[old],[f.scope]),/checksum/);
});
