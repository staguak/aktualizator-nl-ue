import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {renderBase64Markdown} from './inline-legal-images.js';
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


test('a rejected image transfer does not permanently poison the same URL',async()=>{
  const url='https://publications.europa.eu/EN/transient.png';
  let calls=0;
  const resolver=createOfficialImageResolver({load:async()=>{
    calls++;
    if(calls===1)throw new Error('Simulated transient fetch failure');
    return {url,bytes:png,contentType:'image/png'};
  },log:()=>{}});
  await assert.rejects(resolver(url),ImageUnavailableError);
  const result=await resolver(url);
  assert.deepEqual(Buffer.from(result.bytes),png);
  assert.equal(calls,2);
});


test('same missing URL in two separate legal articles uses distinct translation graphics and proofs',async()=>{
  const missing='https://publications.europa.eu/EN/absent.png';
  const docId='32024R0001';
  const original='<body><p class="oj-ti-art">Article 1</p><p><img src="'+missing+'" alt="Chart one"></p>'+
    '<p class="oj-ti-art">Article 2</p><p><img src="'+missing+'" alt="Chart two"></p></body>';
  const alternate='<body><p class="oj-ti-art">Article 1</p><p><img src="https://publications.europa.eu/PL/one.png" alt="Chart one"></p>'+
    '<p class="oj-ti-art">Article 2</p><p><img src="https://publications.europa.eu/PL/two.svg" alt="Chart two"></p></body>';
  const draft=parseEuLegalStructure(original,{corpus:'EU',documentId:docId,version:docId,
    language:'EN',sourceUrl:'https://publications.europa.eu/EN/a.xhtml',sourceSha256:legalHash(original)});
  const names=draft.chunks.map((_,i)=>'multi-'+i+'.md'),doc=indexLegalDocument(draft,names,draft.chunks.map(c=>c.body));
  const markdown=new Map(names.map((name,i)=>[name,legalMarkdown('Act',draft,draft.chunks[i].body,[])]));
  const polish=parseEuLegalStructure(alternate,{corpus:'EU',documentId:docId,version:docId,
    language:'PL',sourceUrl:'https://publications.europa.eu/PL/a.xhtml',sourceSha256:legalHash(alternate)});
  const source={language:'PL',sourceUrl:'https://publications.europa.eu/PL/a.xhtml',html:alternate,
    parsed:{legalDraft:polish}} as EuSource;
  const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><path d="M0 0L2 2"/></svg>');
  const resolver=createOfficialImageResolver({load:async url=>{
    if(url===missing)throw new Error('404');
    return {url,bytes:url.includes('two.svg')?svg:png,contentType:url.includes('two.svg')?'image/svg+xml':'image/png'};
  },document:async()=>source});
  const result=await buildLegalImagePackage([doc],name=>markdown.get(name)!,resolver);
  assert.equal(result.index.occurrences.length,2);
  assert.equal(new Set(result.index.occurrences.map(o=>o.target)).size,2);
  assert.equal(new Set(result.index.occurrences.map(o=>o.sourceEvidenceKey)).size,2);
  assert.equal(result.index.sources.length,2);
  validateLegalImagePackage([doc],name=>markdown.get(name)!,result.index,name=>result.assets.get(name)!);
  const swapped=structuredClone(result.index);
  [swapped.occurrences[0].sourceEvidenceKey,swapped.occurrences[1].sourceEvidenceKey]=
    [swapped.occurrences[1].sourceEvidenceKey,swapped.occurrences[0].sourceEvidenceKey];
  [swapped.occurrences[0].target,swapped.occurrences[1].target]=
    [swapped.occurrences[1].target,swapped.occurrences[0].target];
  assert.throws(()=>validateLegalImagePackage([doc],name=>markdown.get(name)!,swapped,name=>result.assets.get(name)!),
    /Fallback image legal context differs from original unit/);
});

test('independent Python checks two contextual CSS fallbacks sharing one original URL',async t=>{
  const missing='https://publications.europa.eu/EN/same.png',docId='32024R0001';
  const original='<body><p class="oj-ti-art">Article 1</p>'+
    '<p style="background-image:url('+missing+')">First chart.</p>'+
    '<p class="oj-ti-art">Article 2</p>'+
    '<p style="background-image:url('+missing+')">Second chart.</p></body>';
  const alternate='<body><p class="oj-ti-art">Article 1</p>'+
    '<p style="background-image:url(https://publications.europa.eu/PL/one.png)">First chart.</p>'+
    '<p class="oj-ti-art">Article 2</p>'+
    '<p style="background-image:url(https://publications.europa.eu/PL/two.svg)">Second chart.</p></body>';
  const draft=parseEuLegalStructure(original,{corpus:'EU',documentId:docId,version:docId,language:'EN',
    sourceUrl:'https://publications.europa.eu/EN/a.xhtml',sourceSha256:legalHash(original)});
  const names=draft.chunks.map((_,i)=>'css-context-'+i+'.md');
  const doc=indexLegalDocument(draft,names,draft.chunks.map(c=>c.body));
  const markdown=new Map(names.map((name,i)=>[name,legalMarkdown('Act',doc,draft.chunks[i].body,[])]));
  const foreign=parseEuLegalStructure(alternate,{corpus:'EU',documentId:docId,version:docId,language:'PL',
    sourceUrl:'https://publications.europa.eu/PL/a.xhtml',sourceSha256:legalHash(alternate)});
  const source={language:'PL',sourceUrl:'https://publications.europa.eu/PL/a.xhtml',html:alternate,
    parsed:{legalDraft:foreign}} as EuSource;
  const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><path d="M0 0L2 2"/></svg>');
  const resolver=createOfficialImageResolver({
    load:async url=>{
      if(url===missing)throw new Error('404');
      return {url,bytes:url.includes('two.svg')?svg:png,contentType:url.includes('two.svg')?'image/svg+xml':'image/png'};
    },
    document:async()=>source
  });
  const result=await buildLegalImagePackage([doc],name=>markdown.get(name)!,resolver);
  assert.equal(result.index.occurrences.length,2);
  assert.equal(new Set(result.index.occurrences.map(o=>o.sourceEvidenceKey)).size,2);
  result.index.rendering={profile:'inline-base64-v1',offsetEncoding:'utf16-code-units',
    patchScope:'full-markdown',legalOffsetScope:'restored-canonical-body',files:[]};
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'css-translation-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  fs.mkdirSync(path.join(directory,'images'));
  for(const [name,text]of markdown){
    const rendered=renderBase64Markdown(name,text,result.index,n=>result.assets.get(n)!);
    fs.writeFileSync(path.join(directory,name),rendered.text);
    result.index.rendering.files.push(rendered.recipe);
  }
  for(const [name,bytes]of result.assets)fs.writeFileSync(path.join(directory,name),bytes);
  fs.writeFileSync(path.join(directory,'IMAGE_INDEX.json'),JSON.stringify(result.index));
  fs.writeFileSync(path.join(directory,'documents.json'),JSON.stringify([doc]));
  const script="import sys,json;from pathlib import Path;sys.path.insert(0,'scripts');from verify_inline_images import audit_inline;p=Path(sys.argv[1]);audit_inline(p,json.loads((p/'IMAGE_INDEX.json').read_text()),json.loads((p/'documents.json').read_text()))";
  const completed=spawnSync(process.env.LAW_IMAGE_PYTHON??'python3',['-c',script,directory],
    {cwd:fileURLToPath(new URL('../',import.meta.url)),env:{PATH:process.env.PATH},encoding:'utf8',timeout:60000});
  assert.equal(completed.status,0,completed.stderr);
});
