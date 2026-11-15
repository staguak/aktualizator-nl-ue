import test from 'node:test';
import assert from 'node:assert/strict';
import {createOfficialImageResolver} from './eu-image-resolver.js';
import {ImageUnavailableError} from './image-retrieval.js';
import {ImageValidationInfrastructureError} from './image-retrieval.js';
import {parseEuLegalStructure} from './eu-legal-structure.js';
import {indexLegalDocument,legalHash,legalMarkdown} from './legal-structure.js';
import {buildLegalImagePackage,validateLegalImagePackage} from './legal-images.js';
import type {EuSource} from './eu-provider.js';
import type {EuLanguage} from './eu-language.js';
import {createHash} from 'node:crypto';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC','base64');
const id='01992L0058-20190726';
function fixture(language:EuLanguage='EN',documentId=id,embedded=false){
  const url=`https://publications.europa.eu/${language}/act.xhtml`,image=embedded?'data:image/png;base64,'+png.toString('base64'):`https://publications.europa.eu/${language}/r1.jpg`;
  const table=`<table><tr><td>Preserved grouping</td><td><img alt="right accolade" width="16" height="160" src="${image}"></td></tr></table>`;
  const html=`<body><p>ANNEX VIII</p>${language==='PL'?'<div>'+table+'</div>':table}</body>`;
  const draft=parseEuLegalStructure(html,{corpus:'EU',documentId,version:documentId,language,sourceUrl:url,sourceSha256:legalHash(html)});
  const names=draft.chunks.map((_,i)=>`${documentId}-part-${i}.md`),doc=indexLegalDocument(draft,names,draft.chunks.map(c=>c.body));
  const files=new Map(names.map((n,i)=>[n,legalMarkdown('Act',doc,draft.chunks[i].body,[])]));
  const source={language,html,sourceUrl:url,parsed:{legalDraft:draft}} as EuSource;
  return {doc,files,image,source,context:{document:doc,sourceLocator:doc.units.find(u=>u.kind==='image')!.sourceLocator,kind:'img'}};
}
test('missing English graphic uses a corresponding Polish original once and preserves language/source proof',async()=>{
  const f=fixture(),visited:string[]=[],documents:string[]=[];
  const resolver=createOfficialImageResolver({load:async url=>{visited.push(url);if(url.includes('/EN/'))throw new Error('404');
    return Object.defineProperty({url,contentType:'image/png'},'bytes',{get:()=>png}) as any;
  },document:async(id,language)=>{documents.push(language);return fixture(language,id).source;}});
  const result=await buildLegalImagePackage([f.doc],n=>f.files.get(n)!,resolver);
  assert.deepEqual(documents,['PL']);assert.equal(visited.length,2);assert.equal(result.index.unavailableImages!.length,0);
  const proof=result.index.sources[0].resolution!;assert.equal(proof.language,'PL');assert.equal(proof.documentId,id);
  assert.equal(legalHash(Buffer.from(proof.sourceDocumentBase64,'base64').toString()),proof.sourceSha256);
  assert.deepEqual([...result.assets.values()],[png]);
});
test('all four failed languages become a proven gap while later legal documents still build',async()=>{
  const f=fixture(),later=fixture('EN','01999L0092-20070627',true),files=new Map([...f.files,...later.files]),logs:string[]=[],languages:string[]=[];
  const resolver=createOfficialImageResolver({load:async()=>{throw new Error('404');},document:async(id,language)=>{languages.push(language);return fixture(language,id).source;},log:m=>logs.push(m)});
  const result=await buildLegalImagePackage([f.doc,later.doc],n=>files.get(n)!,resolver);
  assert.deepEqual(languages,['PL','NL','FR']);assert.equal(logs.length,1);assert.equal(result.assets.size,1);assert.equal(result.index.occurrences.length,1);
  assert.deepEqual(result.index.unavailableImages![0].attempts.map(a=>a.language),['EN','PL','NL','FR']);
  validateLegalImagePackage([f.doc,later.doc],n=>files.get(n)!,result.index,()=>png);
  const changed=structuredClone(result.index);changed.unavailableImages![0].attempts.pop();
  assert.throws(()=>validateLegalImagePackage([f.doc,later.doc],n=>files.get(n)!,changed,()=>png),/unavailability/i);
});
test('another act or a different version cannot supply a fallback illustration',async()=>{
  const f=fixture();let attempts=0;
  const resolver=createOfficialImageResolver({load:async()=>{attempts++;throw new Error('404');},document:async(_id,lang)=>fixture(lang,'01999L0092-20070627').source,log:()=>{}});
  await assert.rejects(resolver(f.image,f.context),error=>error instanceof ImageUnavailableError&&error.attempts.length===4);
  assert.equal(attempts,1);
});
test('a corrupt embedded graphic follows the same language fallback and retains proof of the replacement',async()=>{
  const f=fixture(),html=f.source.html.replace(f.image,'data:image/png;base64,not_base64');
  const draft=parseEuLegalStructure(html,{...f.doc,sourceSha256:legalHash(html)});
  const names=draft.chunks.map((_,i)=>'corrupt-'+i+'.md'),doc=indexLegalDocument(draft,names,draft.chunks.map(c=>c.body));
  const files=new Map(names.map((n,i)=>[n,legalMarkdown('Act',doc,draft.chunks[i].body,[])]));
  const resolver=createOfficialImageResolver({load:async url=>({url,bytes:png,contentType:'image/png'}),document:async(id,l)=>fixture(l,id).source});
  const result=await buildLegalImagePackage([doc],n=>files.get(n)!,resolver);
  assert.equal(result.index.sources[0].resolution?.language,'PL');assert.deepEqual([...result.assets.values()],[png]);
});
test('broken validation infrastructure is not downgraded to a missing official graphic',async()=>{
  const f=fixture();let fallback=0;
  const resolver=createOfficialImageResolver({load:async()=>{throw new ImageValidationInfrastructureError('Unavailable runtime');},document:async()=>{fallback++;return f.source;}});
  await assert.rejects(resolver(f.image,f.context),ImageValidationInfrastructureError);assert.equal(fallback,0);
});
test('source cache corruption is not reported as four missing official graphics',async()=>{
  const f=fixture(),error=new Error('Source cache checksum changed.');let fallback=0;
  const resolver=createOfficialImageResolver({load:async()=>{throw error;},document:async()=>{fallback++;return f.source;}});
  await assert.rejects(resolver(f.image,f.context),caught=>caught===error);assert.equal(fallback,0);
});
test('a fallback XHTML BOM is preserved in original bytes and does not shift the verified legal image context',async()=>{
  const f=fixture(),polish=fixture('PL'),bytes=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(polish.source.html)]);
  const sha=createHash('sha256').update(bytes).digest('hex');polish.source.parsed.legalDraft!.sourceSha256=sha;
  polish.source.nativeSources=[{name:'original.xhtml',source:{bytes,url:polish.source.sourceUrl,contentType:'application/xhtml+xml'},requestedUrl:polish.source.sourceUrl,kind:'CELLAR-XHTML'}];
  const resolver=createOfficialImageResolver({load:async url=>{if(url.includes('/EN/'))throw new Error('404');return {bytes:png,url,contentType:'image/png'};},document:async()=>polish.source});
  const result=await buildLegalImagePackage([f.doc],n=>f.files.get(n)!,resolver);
  assert.equal(result.index.sources[0].resolution!.sourceSha256,sha);
  assert.deepEqual(Buffer.from(result.index.sources[0].resolution!.sourceDocumentBase64,'base64'),bytes);
});
