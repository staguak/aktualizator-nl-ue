import test from 'node:test';
import assert from 'node:assert/strict';
import {parseNlLegalStructure} from './nl-legal-structure.js';
import {indexLegalDocument,legalMarkdown,legalHash} from './legal-structure.js';
import {buildLegalImagePackage,validateLegalImagePackage} from './legal-images.js';
import {parseEuLegalStructure} from './eu-legal-structure.js';
import {ImageUnavailableError} from './image-retrieval.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC','base64');
function fixture(src='data:image/png;base64,'+png.toString('base64'),second=src){
  const xml=`<toestand bwb-id="BWBR0000001"><wetgeving><artikel nr="1"><al>Entire law.</al><plaatje url="${src}"/><plaatje url="${second}"/></artikel></wetgeving></toestand>`;
  const draft=parseNlLegalStructure(xml,{corpus:'NL',documentId:'BWBR0000001',version:'2025-01-01',language:'NL',sourceUrl:'https://official.example/a.xml',sourceSha256:legalHash(xml)});
  const names=draft.chunks.map((_,i)=>'p'+i+'.md'),doc=indexLegalDocument(draft,names,draft.chunks.map(c=>c.body));
  const files=new Map(names.map((n,i)=>[n,legalMarkdown('Law',draft,draft.chunks[i].body,[])]));
  return {doc,files};
}
test('each original image occurrence maps to native bytes and a legal unit without changing any Markdown byte',async()=>{
  const {doc,files}=fixture(),before=[...files];
  const result=await buildLegalImagePackage([doc],name=>files.get(name)!);
  assert.equal(result.index.occurrences.length,2);assert.equal(result.assets.size,1);
  const occurrence=result.index.occurrences[0];assert.equal(occurrence.documentId,doc.documentId);assert.equal(occurrence.version,doc.version);
  assert.equal(occurrence.sourceSha256,doc.sourceSha256);assert.equal(occurrence.legalUnitId,doc.units.find(u=>u.kind==='image')!.id);
  assert(occurrence.target.endsWith('.png'));assert.deepEqual(result.assets.get(occurrence.target),png);assert.deepEqual([...files],before);
  validateLegalImagePackage([doc],name=>files.get(name)!,result.index,name=>result.assets.get(name)!);
  assert.throws(()=>validateLegalImagePackage([doc],name=>files.get(name)!,{...result.index,occurrences:result.index.occurrences.slice(1)},name=>result.assets.get(name)!),/image/i);
});
test('CSS extensionless image URLs are fetched and native bytes are verified',async()=>{
  const html='<body><p style="background-image:url(https://official.example/illustration?id=17)">Full legal text</p></body>';
  const draft=parseEuLegalStructure(html,{corpus:'EU',documentId:'32024R0001',version:'32024R0001',language:'EN',sourceUrl:'https://official.example/doc',sourceSha256:legalHash(html)});
  const doc=indexLegalDocument(draft,['law.md'],draft.chunks.map(p=>p.body)),markdown=legalMarkdown('Law',doc,draft.chunks[0].body,[]);
  let reads=0;const result=await buildLegalImagePackage([doc],()=>markdown,async()=>{reads++;return {bytes:png,contentType:'image/png'};});
  assert.equal(reads,1);assert.equal(result.index.occurrences.length,1);
});
test('standalone SVG includes its implicit HTML namespace while source Markdown stays exact',async()=>{
  const html='<body><svg viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg></body>';
  const draft=parseEuLegalStructure(html,{corpus:'EU',documentId:'32024R0001',version:'32024R0001',language:'EN',sourceUrl:'https://official.example/doc',sourceSha256:legalHash(html)});
  const doc=indexLegalDocument(draft,['law.md'],draft.chunks.map(p=>p.body)),markdown=legalMarkdown('Law',doc,draft.chunks[0].body,[]);
  const result=await buildLegalImagePackage([doc],()=>markdown);
  assert.match([...result.assets.values()][0].toString(),/<svg[^>]*xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert(!markdown.includes('xmlns='));
});
test('swapping targets of distinct external image occurrences is rejected against download evidence',async()=>{
  const {doc,files}=fixture('https://official.example/a','https://official.example/b');
  const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>');
  const result=await buildLegalImagePackage([doc],name=>files.get(name)!,async url=>({bytes:url.endsWith('/a')?png:svg,contentType:url.endsWith('/a')?'image/png':'image/svg+xml'}));
  const changed=structuredClone(result.index);[changed.occurrences[0].target,changed.occurrences[1].target]=[changed.occurrences[1].target,changed.occurrences[0].target];
  assert.throws(()=>validateLegalImagePackage([doc],name=>files.get(name)!,changed,name=>result.assets.get(name)!),/image/i);
});
test('external images are reused once, keep their native format, and changed Markdown or binary data invalidates the index',async()=>{
  const {doc,files}=fixture('https://official.example/image');
  let reads=0;const result=await buildLegalImagePackage([doc],name=>files.get(name)!,async()=>{reads++;return {bytes:png,contentType:'image/jpeg'};});
  assert.equal(reads,1);assert(result.index.assets[0].name.endsWith('.png'));
  const read=(name:string)=>result.assets.get(name)!;
  assert.throws(()=>validateLegalImagePackage([doc],name=>files.get(name)!.replace('Entire law.','Changed law.'),result.index,read),/image/i);
  assert.throws(()=>validateLegalImagePackage([doc],name=>files.get(name)!,result.index,()=>Buffer.from('invalid image')),/image/i);
});
test('SVG image references and CSS graphics receive exact native sidecars alongside inline SVG',async()=>{
  const image='data:image/png;base64,'+png.toString('base64');
  const html=`<body><p>Article 1</p><style>.seal{background-image:url('${image}')}</style><svg xmlns="http://www.w3.org/2000/svg"><image href="${image}" width="1" height="1"/></svg></body>`;
  const draft=parseEuLegalStructure(html,{corpus:'EU',documentId:'32024R0001',version:'32024R0001',language:'EN',sourceUrl:'https://official.example/doc.xhtml',sourceSha256:legalHash(html)});
  const names=draft.chunks.map((_,i)=>'svg'+i+'.md'),doc=indexLegalDocument(draft,names,draft.chunks.map(p=>p.body));
  const files=new Map(names.map((name,i)=>[name,legalMarkdown('Law',doc,draft.chunks[i].body,[])]));
  const result=await buildLegalImagePackage([doc],name=>files.get(name)!);
  assert.deepEqual(result.index.occurrences.map(o=>o.kind).sort(),['css','inline-svg','svg-image']);
  assert.equal(result.assets.size,2);assert(result.index.assets.some(a=>a.contentType==='image/svg+xml'));assert(result.index.assets.some(a=>a.contentType==='image/png'));
});

const flagUrl='https://publications.europa.eu/resource/cellar/official.0001.03/europeanflag.gif';
function flagFixture(options:{source?:string;alt?:string;article?:boolean;title?:string}={}){
  const header=`<table><tr><td><img alt="${options.alt??'European flag'}" src="${options.source??flagUrl}"></td>`+
    `<td><p class="oj-hd-ti">${options.title??'Official Journal of the European Union'}</p></td></tr></table>`;
  const html='<body>'+(options.article?'<p class="oj-ti-art">Article 1</p>':'')+header+'<p>Complete legal text.</p></body>';
  const draft=parseEuLegalStructure(html,{corpus:'EU',documentId:'32024R0001',version:'32024R0001',language:'EN',sourceUrl:'https://publications.europa.eu/document.xhtml',sourceSha256:legalHash(html)});
  const names=draft.chunks.map((_,i)=>'flag-'+i+'.md'),doc=indexLegalDocument(draft,names,draft.chunks.map(p=>p.body));
  const files=new Map(names.map((name,i)=>[name,legalMarkdown('Law',doc,draft.chunks[i].body,[])]));
  return {doc,files};
}
test('decorative OJ header flags are explicitly indexed without download or changes to Markdown',async()=>{
  const {doc,files}=flagFixture(),before=[...files];let calls=0;
  const result=await buildLegalImagePackage([doc],n=>files.get(n)!,async()=>{calls++;throw new Error('Decorative flag must not be requested');});
  assert.equal(calls,0);assert.equal(result.assets.size,0);assert.equal(result.index.occurrences.length,0);assert.equal(result.index.sources.length,0);
  assert.equal(result.index.omittedDecorations!.length,1);
  const omission=result.index.omittedDecorations![0];assert.equal(omission.reason,'decorative-european-flag');assert.equal(omission.imageUrl,flagUrl);
  assert.equal(omission.sourceSha256,doc.sourceSha256);assert(doc.units.some(u=>u.id===omission.legalUnitId&&u.sourceLocator===omission.sourceLocator));
  assert.deepEqual([...files],before);
  validateLegalImagePackage([doc],n=>files.get(n)!,result.index,()=>{throw new Error('No binary is required');});
  for(const change of ['missing','reason','reference','duplicate']){
    const changed=structuredClone(result.index);
    if(change==='missing')changed.omittedDecorations=[];
    if(change==='reason')(changed.omittedDecorations![0] as any).reason='all-images';
    if(change==='reference')changed.omittedDecorations![0].imageUrl='https://publications.europa.eu/other.gif';
    if(change==='duplicate')changed.omittedDecorations!.push(changed.omittedDecorations![0]);
    assert.throws(()=>validateLegalImagePackage([doc],n=>files.get(n)!,changed,()=>png),/image/i);
  }
});
test('flag exemption does not cover table braces, formulas, article illustrations or unverified header lookalikes',async()=>{
  for(const options of [{source:'https://publications.europa.eu/r1.jpg',alt:'right accolade'},
    {source:'https://publications.europa.eu/formula.jpg'}, {article:true},
    {source:'https://foreign.example/europeanflag.gif'}, {alt:'Legal illustration'}, {title:'Article 1'}]){
    const {doc,files}=flagFixture(options);let calls=0;
    await assert.rejects(buildLegalImagePackage([doc],n=>files.get(n)!,async()=>{calls++;throw new Error('Required image unavailable');}),/Required image unavailable/);
    assert.equal(calls,1);
  }
});
test('decorative OJ flag detection supports headers in every configured fallback language',async()=>{
  for(const title of ['Dziennik Urzędowy Unii Europejskiej','Publicatieblad van de Europese Unie','Journal officiel de l’Union européenne']){
    const {doc,files}=flagFixture({title}),result=await buildLegalImagePackage([doc],n=>files.get(n)!,async()=>{throw new Error('No flag download');});
    assert.equal(result.index.omittedDecorations!.length,1);
  }
});
test('an explicit omission cannot be added for a substantive image and earlier image indexes remain readable',async()=>{
  const {doc,files}=fixture(),result=await buildLegalImagePackage([doc],n=>files.get(n)!);
  const legacy=structuredClone(result.index);delete legacy.omittedDecorations;
  validateLegalImagePackage([doc],n=>files.get(n)!,legacy,n=>result.assets.get(n)!);
  const changed=structuredClone(result.index);
  changed.omittedDecorations=[{...changed.occurrences[0],reason:'decorative-european-flag',imageUrl:flagUrl} as any];
  assert.throws(()=>validateLegalImagePackage([doc],n=>files.get(n)!,changed,n=>result.assets.get(n)!),/image/i);
});


test('a failed occurrence does not poison a later identical source image URL',async()=>{
  const url='https://official.example/missing-image.png';
  const {doc,files}=fixture(url);
  let calls=0;
  const loader=async()=>{
    calls++;
    if(calls===1)throw new ImageUnavailableError([{language:'NL',url,outcome:'UNAVAILABLE',reason:'Transient HTTP error'}]);
    return {bytes:png,contentType:'image/png',url};
  };
  const result=await buildLegalImagePackage([doc],name=>files.get(name)!,loader);
  assert.equal(calls,2);
  assert.equal(result.index.unavailableImages?.length,1);
  assert.equal(result.index.occurrences.length,1);
});
