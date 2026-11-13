import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildNlModel} from './nl-model.js';
import type {ScopeAct,VersionSnapshot} from './types.js';
import {assertEuSourceIdentity} from './eu-source-identity.js';
import type {CellarIndex} from './eu-provider.js';
import {fetchBinarySource,fetchSource,retrySource,SourceHttpError} from './source-cache.js';
import {safeFailureMessage} from './drive-retry.js';
import {CheckpointFileReader} from './checkpoint-files.js';
import {hash} from './release-store.js';

const act:ScopeAct={order:1,title:'Test',bwbId:'BWBR0000001',include:{articles:['1']},mustIncludeArticles:['1']};
const state=(from:string,to:string|null,content='Dezelfde tekst.'):VersionSnapshot=>({
  version:{key:from,toestandUrl:`https://example.org/${from}.xml`,validFrom:from,validTo:to},
  statute:{bwbId:act.bwbId,title:act.title,provisions:[{article:'1',provisionRef:'1',structurePath:'',content}]},
});
test('identical NL text cannot bridge a gap in documented intervals',()=>{
  const model=buildNlModel(act,[state('2025-01-01','2025-01-10'),state('2025-01-12',null)],'2025-01-01','2025-02-01');
  assert.deepEqual(model.states.map(s=>[s.validFrom,s.validTo,s.sourceStates]),[
    ['2025-01-01','2025-01-10',[0]],['2025-01-12',null,[1]],
  ]);
});
test('adjacent NL intervals merge without losing either observation',()=>{
  const model=buildNlModel(act,[state('2025-01-01','2025-01-10'),state('2025-01-11',null)],'2025-01-01','2025-02-01');
  assert.equal(model.states.length,1);assert.equal(model.states[0].validTo,null);assert.deepEqual(model.states[0].sourceStates,[0,1]);
});
test('a later NL snapshot never establishes a missing earlier end or continuity of identical text',()=>{
  for(const end of [null,'9999-12-31'])for(const content of ['Dezelfde tekst.','Andere tekst.']){
    const model=buildNlModel(act,[state('2025-01-01',end),state('2025-01-11',null,content)],'2025-01-01','2025-02-01');
    assert.deepEqual(model.states.map(s=>[s.validFrom,s.validTo,s.sourceStates]),[
      ['2025-01-01',null,[0]],['2025-01-11',null,[1]],
    ]);
    assert.equal(model.sourceStates[0].validTo,null);
  }
});
test('a documentary Toestand inwerkingtreding does not replace a missing g start in the NL model',()=>{
  const observation=state('2025-01-01',null);observation.version.validFrom=null;observation.statute.inForceDate='2025-01-01';
  const model=buildNlModel(act,[observation],'2025-01-01','2025-02-01');
  assert.equal(model.states[0].validFrom,null);assert.equal(model.sourceStates[0].validFrom,null);
});
test('blank and absent NL observations interrupt text merging without inferring repeal',()=>{
  for(const absent of [false,true]){
    const middle=state('2025-01-11','2025-01-20','');if(absent)middle.statute.provisions=[];
    const model=buildNlModel(act,[state('2025-01-01','2025-01-10'),middle,state('2025-01-21',null)],'2025-01-01','2025-02-01');
    assert.equal(model.states.length,2);assert.equal(model.states[0].validTo,'2025-01-10');
    assert(!JSON.stringify(model).includes('repealed'));
  }
});

const work='https://publications.europa.eu/resource/cellar/f232aa0b-f575-11ef-b7db-01aa75ed71a1';
const item=work+'.0001.03/DOC_1';
const index={rows:[{work,expression:work+'.0001',manifestation:work+'.0001.03',format:'html',item}]} as CellarIndex;
test('EU identity binds the returned XHTML item to the CELEX language index',()=>{
  assert.doesNotThrow(()=>assertEuSourceIdentity('<html><head><title>Official text</title></head></html>',item,'32024L2831R(01)',index));
  assert.doesNotThrow(()=>assertEuSourceIdentity('<html/>',item.replace('https:','http:'),'32024L2831R(01)',index));
  assert.throws(()=>assertEuSourceIdentity('<html/>',item.replace('.0001.03','.0002.03'),'32024L2831R(01)',index),/WEMI/);
  assert.throws(()=>assertEuSourceIdentity('<html/>',item,'32024L2831R(01)'),/WEMI/);
});
test('a different legal document or consolidation layer cannot satisfy EU identity',()=>{
  const html=(title:string)=>`<html><head><title>${title}</title></head></html>`;
  const url='https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32016R0679';
  assert.throws(()=>assertEuSourceIdentity(html('EUR-Lex - 32003L0088 - EN'),url,'32016R0679'),/identity mismatch/);
  const title='Consolidated TEXT: 32016R0679 — EN — 04.05.2016';
  assert.doesNotThrow(()=>assertEuSourceIdentity(html(title),item,'02016R0679-20160504',index));
  assert.throws(()=>assertEuSourceIdentity(html(title),item,'02016R0679-20180525',index),/identity mismatch/);
  assert.throws(()=>assertEuSourceIdentity(html('Official text'),url,'32016R0679'),/independently confirmed/);
});
test('EU canonical identifiers cannot contradict the requested CELEX',()=>{
  const html='<html><head><title>Official text</title><meta name="DC.identifier" content="32003L0088"/></head></html>';
  assert.throws(()=>assertEuSourceIdentity(html,item,'32016R0679',index),/identity mismatch/);
});
test('only transient source failures are retried; deterministic validation and HTTP 404 stop immediately',async()=>{
  for(const error of [new SourceHttpError(404),new Error('Invalid source redirect.'),new SyntaxError('Malformed XML')]){
    let calls=0;await assert.rejects(retrySource(async()=>{calls++;throw error;},3,async()=>{}));assert.equal(calls,1);
  }
  for(const error of [new SourceHttpError(503),new SourceHttpError(429),new DOMException('timed out','TimeoutError'),new TypeError('fetch failed')]){
    let calls=0;assert.equal(await retrySource(async()=>{if(++calls<3)throw error;return 'ok';},3,async()=>{}),'ok');assert.equal(calls,3);
  }
});
test('SDK errors without response objects never expose OAuth request details',()=>{
  for(const error of [Object.assign(new Error('PRIVATE_TOKEN'),{config:{data:'PRIVATE_TOKEN'}}),
    Object.assign(new Error('PRIVATE_TOKEN'),{request:{body:'PRIVATE_TOKEN'}}),
    Object.assign(new Error('PRIVATE_TOKEN'),{code:'ECONNRESET'})]){
    assert(!safeFailureMessage(error).includes('PRIVATE_TOKEN'));
  }
  assert.equal(safeFailureMessage(new Error('Invalid checkpoint.')),'Invalid checkpoint.');
});
test('binary cache stores one byte representation, revalidates it and rejects modified payloads',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'audit-cache-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const bytes=Buffer.from([0,255,128,13,10]),url='https://example.org/source';
  await fetchBinarySource(url,{}, {cacheDir:dir,fetcher:async()=>new Response(bytes,{headers:{etag:'v1'}})});
  const file=path.join(dir,fs.readdirSync(dir)[0]),entry=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(entry.version,3);assert.equal(entry.text,undefined);
  assert.deepEqual((await fetchBinarySource(url,{}, {cacheDir:dir,fetcher:async()=>new Response(null,{status:304})})).bytes,bytes);
  entry.base64=Buffer.from('corrupt').toString('base64');fs.writeFileSync(file,JSON.stringify(entry));
  await assert.rejects(fetchBinarySource(url,{}, {cacheDir:dir,fetcher:async()=>new Response(null,{status:304})}),/without a verified cache/);
});
test('verified version 2 caches remain reusable after the compact cache migration',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'audit-cache-v2-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const url='https://example.org/source';await fetchSource(url,{}, {cacheDir:dir,fetcher:async()=>new Response('bron',{headers:{etag:'v1'}})});
  const file=path.join(dir,fs.readdirSync(dir)[0]),entry=JSON.parse(fs.readFileSync(file,'utf8'));
  entry.version=2;entry.text='bron';fs.writeFileSync(file,JSON.stringify(entry));
  assert.equal((await fetchSource(url,{}, {cacheDir:dir,fetcher:async()=>new Response(null,{status:304})})).text,'bron');
});
test('completed checkpoint files are read once and local modifications invalidate the in-process memo',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'audit-checkpoint-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'native.zip');fs.writeFileSync(file,'original');let reads=0;
  const reader=new CheckpointFileReader(name=>{reads++;return fs.readFileSync(name);}),md5=hash(Buffer.from('original'),'md5');
  assert.equal(reader.load(file,md5).toString(),'original');assert.equal(reader.load(file,md5).toString(),'original');assert.equal(reads,1);
  fs.writeFileSync(file,'modified');assert.throws(()=>reader.load(file,md5),/checksum mismatch/);assert.equal(reads,2);
  fs.rmSync(file);fs.symlinkSync(path.join(dir,'other'),file);fs.writeFileSync(path.join(dir,'other'),'original');
  assert.throws(()=>reader.load(file,md5),/regular files/);
});

test('unidentified EUR-Lex HTML falls back to an independently indexed CELLAR item',async t=>{
  const {fetchEuText}=await import('./eu-provider.js');
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let indexedReads=0,indexLookups=0;
  const body='<html lang="en"><head><title>Official text</title></head><body><p>REGULATION</p><p>Article 1</p><p>'+ 'Official provision. '.repeat(50)+'</p></body></html>';
  const rows=[{work:{value:work},expression:{value:work+'.0001'},language:{value:'http://publications.europa.eu/resource/authority/language/ENG'},
    manifestation:{value:work+'.0001.03'},format:{value:'xhtml'},item:{value:item}}];
  globalThis.fetch=async input=>{
    const url=String(input);let text:string;
    if(url.includes('/sparql?')){indexLookups++;text=JSON.stringify({results:{bindings:rows}});}
    else if(url===work)text='<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/>';
    else {text=body;if(url===item)indexedReads++;}
    const response=new Response(text);Object.defineProperty(response,'url',{value:url});return response;
  };
  const source=await fetchEuText({celex:'32024L2831',include:'full-document',role:'original',metadata:{}});
  assert.equal(indexedReads,1);assert.equal(indexLookups,1);assert.equal(source.sourceUrl,item);
  assert(source.nativeSources?.some(s=>s.kind==='CELLAR-WEMI-index'));
});


test('an NL heading-only amendment remains a separate dated version',()=>{
  const old=state('2025-01-01','2025-01-10'),next=state('2025-01-11',null);
  old.statute.provisions[0].title='Oude titel';next.statute.provisions[0].title='Nieuwe titel';
  const model=buildNlModel(act,[old,next],'2025-01-01','2025-02-01');
  assert.deepEqual(model.states.map(s=>[s.title,s.validFrom,s.validTo]),[
    ['Oude titel','2025-01-01','2025-01-10'],['Nieuwe titel','2025-01-11',null],
  ]);assert.equal(model.states[0].contentHash,model.states[1].contentHash);
});
test('ambiguous EU dates are rejected and dated decisions use their documentary layer',async()=>{
  const {selectEuDocuments}=await import('./eu-provider.js'),{documentDate}=await import('./base-plan.js');
  const scope={order:1,title:'Test',celex:'32016D0001',include:'full-document' as const,requiredVersions:[],attachedDocuments:[]};
  const layer={celex:'02016D0001-20250101',include:'full-document',role:'consolidation',metadata:{work_date_document:['2016-01-01']}};
  assert.equal(documentDate(layer),'2025-01-01');assert.equal(selectEuDocuments([layer],scope,'2025-01-01','2025-01-02','EN').length,1);
  const ambiguous={...layer,celex:'32016D0001',metadata:{work_date_document:['2016-01-01','2026-01-01']}};
  assert.equal(documentDate(ambiguous),null);
  assert.throws(()=>selectEuDocuments([ambiguous],scope,'2025-01-01','2026-01-02','EN'),/ambiguous/);
  assert.throws(()=>selectEuDocuments([{...layer,celex:'02016D0001-20250230'}],scope,'2025-01-01','2026-01-02','EN'),/Invalid/);
});
