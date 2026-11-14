import test from 'node:test';
import assert from 'node:assert/strict';
import {parseNlLegalStructure} from './nl-legal-structure.js';
import {indexLegalDocument,legalMarkdown,legalHash} from './legal-structure.js';
import {buildLegalImagePackage,validateLegalImagePackage} from './legal-images.js';
import {parseEuLegalStructure} from './eu-legal-structure.js';

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
