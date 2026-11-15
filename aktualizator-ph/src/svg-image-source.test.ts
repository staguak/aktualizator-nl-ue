import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createOfficialImageResolver} from './eu-image-resolver.js';
import {prepareSvgImage,svgDerivative} from './svg-image-source.js';
import {buildLegalImagePackage,validateLegalImagePackage} from './legal-images.js';
import {renderBase64Markdown,assertInlineGraphics,restoreCanonicalMarkdown} from './inline-legal-images.js';
import {parseEuLegalStructure} from './eu-legal-structure.js';
import {indexLegalDocument,legalMarkdown,legalHash} from './legal-structure.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC','base64');
const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>Exact formula</text><image href="picture.png" width="10" height="10"/><filter id="f"><feImage href="picture.png"/></filter><use href="#symbol"/><path id="symbol" d="M0 0L10 10"/></svg>');
const url='https://publications.europa.eu/figures/root.svg';
function fixture(source=url,base='https://publications.europa.eu/act.xhtml'){
  const html=`<body><p class="oj-ti-art">Article 1</p><p>Exact law 😀</p><img alt="Formula" src="${source}"></body>`;
  const draft=parseEuLegalStructure(html,{corpus:'EU',documentId:'32024R0001',version:'32024R0001',language:'EN',sourceUrl:base,sourceSha256:legalHash(html)});
  const names=draft.chunks.map((_,i)=>`svg-${i}.md`),doc=indexLegalDocument(draft,names,draft.chunks.map(c=>c.body));
  const files=new Map(names.map((n,i)=>[n,legalMarkdown('Law',doc,draft.chunks[i].body,[])]));
  return {doc,files};
}
test('external SVG embeds native dependencies, preserves its exact original and passes independent geometry validation',async t=>{
  const f=fixture(),visited:string[]=[];
  const resolver=createOfficialImageResolver({load:async target=>{visited.push(target);return {bytes:target===url?svg:png,contentType:target===url?'image/svg+xml':'image/png',url:target};}});
  const r=await buildLegalImagePackage([f.doc],n=>f.files.get(n)!,resolver);
  assert.deepEqual(visited,[url,'https://publications.europa.eu/figures/picture.png']);
  const proof=r.index.sources[0].derivation!;assert.deepEqual(Buffer.from(proof.originalBase64,'base64'),svg);
  assert.deepEqual(Buffer.from(proof.resources[0].base64,'base64'),png);
  const bytes=[...r.assets.values()][0];assert(bytes.toString().includes('data:image/png;base64,'));assert(svgDerivative(proof).equals(bytes));
  const bad=structuredClone(r.index);bad.sources[0].derivation!.originalBase64=Buffer.from(svg.toString().replace('10 10','20 20')).toString('base64');
  assert.throws(()=>validateLegalImagePackage([f.doc],n=>f.files.get(n)!,bad,n=>r.assets.get(n)!),/original bytes/);
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'svg-derivative-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));fs.mkdirSync(path.join(temp,'images'));
  r.index.rendering={profile:'inline-base64-v1',offsetEncoding:'utf16-code-units',patchScope:'full-markdown',legalOffsetScope:'restored-canonical-body',files:[]};
  for(const[n,s]of f.files){const view=renderBase64Markdown(n,s,r.index,n=>r.assets.get(n)!);r.index.rendering.files.push(view.recipe);assertInlineGraphics(view.text);assert.equal(restoreCanonicalMarkdown(n,view.text,r.index),s);fs.writeFileSync(path.join(temp,n),view.text);}
  for(const[n,b]of r.assets)fs.writeFileSync(path.join(temp,n),b);
  fs.writeFileSync(path.join(temp,'IMAGE_INDEX.json'),JSON.stringify(r.index));fs.writeFileSync(path.join(temp,'documents.json'),JSON.stringify([f.doc]));
  const script="import sys,json;from pathlib import Path;sys.path.insert(0,'scripts');from verify_inline_images import audit_inline;p=Path(sys.argv[1]);audit_inline(p,json.loads((p/'IMAGE_INDEX.json').read_text()),json.loads((p/'documents.json').read_text()))";
  const check=()=>spawnSync(process.env.LAW_IMAGE_PYTHON??'python3',['-c',script,temp],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{PATH:process.env.PATH},encoding:'utf8',timeout:60000});
  const passed=check();assert.equal(passed.status,0,passed.stderr);
  const forged=structuredClone(proof);forged.originalBase64=Buffer.from(svg.toString().replace('L10 10','L20 20')).toString('base64');forged.originalSha256=legalHash(Buffer.from(forged.originalBase64,'base64').toString());
  r.index.sources[0].derivation=forged;fs.writeFileSync(path.join(temp,'IMAGE_INDEX.json'),JSON.stringify(r.index));assert.notEqual(check().status,0);
});
test('embedded SVG relative dependencies are bound to their document base URL',async()=>{
  const inner='data:image/svg+xml;base64,'+svg.toString('base64');
  const outer=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><image href="${inner}"/></svg>`);
  const source='data:image/svg+xml;base64,'+outer.toString('base64'),f=fixture(source);
  const resolver=createOfficialImageResolver({load:async target=>({bytes:png,url:target,contentType:'image/png'})});
  const r=await buildLegalImagePackage([f.doc],n=>f.files.get(n)!,resolver);
  assert.equal(r.index.sources[0].baseUrl,f.doc.sourceUrl);assert.equal(r.index.sources[0].derivation!.resources[0].derivation!.resources[0].requestUrl,'https://publications.europa.eu/picture.png');
  const bad=structuredClone(r.index);bad.sources[0].baseUrl='https://publications.europa.eu/other/act.xhtml';
  assert.throws(()=>validateLegalImagePackage([f.doc],n=>f.files.get(n)!,bad,n=>r.assets.get(n)!),/source evidence|context/);
});
test('a missing SVG dependency exhausts configured languages without ending the remaining update',async()=>{
  const f=fixture(),seen:string[]=[];
  const resolver=createOfficialImageResolver({load:async target=>{if(target===url)return {bytes:svg,url:target,contentType:'image/svg+xml'};throw new Error('404');},document:async(_id,l)=>{seen.push(l);throw new Error('404');},log:()=>{}});
  const r=await buildLegalImagePackage([f.doc],n=>f.files.get(n)!,resolver);
  assert.equal(r.assets.size,0);assert.equal(r.index.unavailableImages!.length,1);assert.deepEqual(seen,['PL','NL','FR']);
  assert.deepEqual(r.index.unavailableImages![0].attempts.map(a=>a.language),['EN','PL','NL','FR']);
});
test('cyclic SVG dependencies are bounded and local fragment references are preserved',async()=>{
  const cyclic=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="root.svg"/></svg>');
  await assert.rejects(prepareSvgImage({bytes:cyclic,url,contentType:'image/svg+xml'},url,url,async()=>({bytes:cyclic,url,contentType:'image/svg+xml'})),/Cyclic/);
  const local=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="#symbol"/><path id="symbol" d="M0 0L1 1"/></svg>');
  const result=await prepareSvgImage({bytes:local,url,contentType:'image/svg+xml'},url,url,async()=>{throw new Error('No request expected');});assert.deepEqual(Buffer.from(result.bytes),local);
});
test('nested SVG originals and their PNG dependency remain reconstructable independently',async t=>{
  const nested=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><use href="child.svg#symbol" width="10" height="10"/></svg>');
  const result=await prepareSvgImage({bytes:nested,url,contentType:'image/svg+xml'},url,url,async target=>({bytes:target.includes('child.svg')?svg:png,url:target,contentType:target.includes('child.svg')?'image/svg+xml':'image/png'}));
  assert.deepEqual(Buffer.from(result.derivation!.originalBase64,'base64'),nested);
  assert.deepEqual(Buffer.from(result.derivation!.resources[0].derivation!.originalBase64,'base64'),svg);
  assert(svgDerivative(result.derivation!).equals(Buffer.from(result.bytes)));
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'nested-svg-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  fs.writeFileSync(path.join(temp,'proof.json'),JSON.stringify(result.derivation));fs.writeFileSync(path.join(temp,'view.svg'),result.bytes);
  const script="import sys,json;from pathlib import Path;sys.path.insert(0,'scripts');from verify_inline_images import verify_svg_derivation;p=Path(sys.argv[1]);verify_svg_derivation(json.loads((p/'proof.json').read_text()),(p/'view.svg').read_bytes())";
  const check=spawnSync(process.env.LAW_IMAGE_PYTHON??'python3',['-c',script,temp],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{PATH:process.env.PATH},encoding:'utf8',timeout:60000});assert.equal(check.status,0,check.stderr);
});
