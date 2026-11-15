import test from 'node:test';
import assert from 'node:assert/strict';
import {parseEuLegalStructure} from './eu-legal-structure.js';
import {indexLegalDocument,legalHash,legalMarkdown,extractLegalBody} from './legal-structure.js';
import {buildLegalImagePackage} from './legal-images.js';
import {renderBase64Markdown,restoreCanonicalMarkdown,validateInlineRendering,assertInlineGraphics} from './inline-legal-images.js';
import {ImageUnavailableError} from './image-retrieval.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC','base64');
function fixture(html:string){
  const draft=parseEuLegalStructure('<body>'+html+'</body>',{corpus:'EU',documentId:'32024R0001',version:'32024R0001',language:'EN',sourceUrl:'https://publications.europa.eu/act.xhtml',sourceSha256:legalHash(html)});
  const names=draft.chunks.map((_,i)=>`inline-${i}.md`),doc=indexLegalDocument(draft,names,draft.chunks.map(p=>p.body));
  const files=new Map(names.map((name,i)=>[name,legalMarkdown('Entire act 😀',doc,draft.chunks[i].body,[])]));
  return {doc,files};
}
async function render(f:ReturnType<typeof fixture>,loader:Parameters<typeof buildLegalImagePackage>[2]=async url=>({bytes:png,contentType:'image/png',url})){
  const result=await buildLegalImagePackage([f.doc],n=>f.files.get(n)!,loader),outputs=new Map<string,string>();
  result.index.rendering={profile:'inline-base64-v1',offsetEncoding:'utf16-code-units',patchScope:'full-markdown',legalOffsetScope:'restored-canonical-body',files:[]};
  for(const [name,original]of f.files){const view=renderBase64Markdown(name,original,result.index,n=>result.assets.get(n)!);outputs.set(name,view.text);result.index.rendering.files.push(view.recipe);}
  return {...result,outputs};
}
test('external graphics become native Base64 while all legal text, tables, anchors and original references remain exactly recoverable',async()=>{
  const f=fixture('<p class="oj-ti-art">Article 1</p><p>Full text 😀 &amp; punctuation.</p><table><tr><td>Exact cell</td><td><img alt="Legal diagram" src="https://publications.europa.eu/diagram.png"></td></tr></table>');
  const r=await render(f);assert([...r.outputs.values()].some(s=>s.includes('data:image/png;base64,'+png.toString('base64'))));
  for(const [n,s]of r.outputs){assertInlineGraphics(s);assert.equal(restoreCanonicalMarkdown(n,s,r.index),f.files.get(n));assert(s.includes('Full text 😀'));}
  validateInlineRendering([f.doc],r.index,n=>f.files.get(n)!,n=>r.outputs.get(n)!,n=>r.assets.get(n)!);
});
test('already embedded native PNG remains exact without duplicating its payload in the reversible recipe',async()=>{
  const f=fixture('<p>Preserved text</p><img src="data:image/png;base64,'+png.toString('base64')+'">'),r=await render(f);
  for(const [name,s]of r.outputs){assert.equal(s,f.files.get(name));assert.equal(r.index.rendering!.files.find(v=>v.name===name)!.patches.length,0);}
});
test('CSS image dependencies and nested SVG images are self-contained in encoded complete SVG',async()=>{
  const f=fixture('<p>Original text.</p><p style="background-image:url(https://publications.europa.eu/bg)">Same paragraph.</p><svg viewBox="0 0 10 10"><image href="https://publications.europa.eu/inner" width="10" height="10"/></svg>');
  const r=await render(f);
  for(const [name,s]of r.outputs){assertInlineGraphics(s);assert.equal(restoreCanonicalMarkdown(name,s,r.index),f.files.get(name));assert(!extractLegalBody(s).includes('src="https:'));assert(!extractLegalBody(s).includes('href="https:'));}
});
test('decorative flags and exhausted graphic gaps are explicit presentation omissions rather than broken graphic links',async()=>{
  const f=fixture('<table><tr><td><img alt="European flag" src="https://publications.europa.eu/europeanflag.gif"></td><td><p class="oj-hd-ti">Official Journal of the European Union</p></td></tr></table><p>Whole legal text</p><img alt="Missing formula" src="https://publications.europa.eu/missing.jpg">');
  const r=await render(f,async url=>{throw new ImageUnavailableError(['EN','PL','NL','FR'].map(language=>({language,url,outcome:'UNAVAILABLE',reason:'Source HTTP 404'})));});
  assert.equal(r.index.omittedDecorations!.length,1);assert.equal(r.index.unavailableImages!.length,1);
  for(const [name,s]of r.outputs){assertInlineGraphics(s);assert(s.includes('Grafika niedostępna'));assert(s.includes('Whole legal text'));assert.equal(restoreCanonicalMarkdown(name,s,r.index),f.files.get(name));}
});
test('changing text, swapping inline bytes, or forging a reversible patch cannot certify a different final presentation',async()=>{
  const f=fixture('<p>Do not change this text.</p><img src="https://publications.europa.eu/img.png">'),r=await render(f),name=[...r.outputs.keys()][0],original=r.outputs.get(name)!;
  assert.throws(()=>restoreCanonicalMarkdown(name,original.replace('Do not','Changed'),r.index),/checksum/);
  const fake=structuredClone(r.index);fake.rendering!.files[0].patches[0].original='forged';
  assert.throws(()=>restoreCanonicalMarkdown(name,original,fake),/patch|reconstruction/);
  const altered=original.replace('data:image/png;base64,','data:image/jpeg;base64,');
  assert.throws(()=>validateInlineRendering([f.doc],r.index,n=>f.files.get(n)!,()=>altered,n=>r.assets.get(n)!),/presentation/);
});
test('final presentation checks reject ordinary URL images and unencoded SVG graphics',()=>{
  for(const html of ['<img src="https://publications.europa.eu/a.png">','<svg><path d="M0 0L1 1"/></svg>']){
    const f=fixture(html);assert.throws(()=>assertInlineGraphics([...f.files.values()][0]),/Base64/);
  }
});
test('SVG view fragments survive Base64 embedding without changing the original vector bytes',async()=>{
  const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><view id="cut" viewBox="0 0 1 1"/><path d="M0 0L1 1"/></svg>');
  const f=fixture('<p>Original context.</p><img src="https://publications.europa.eu/figure.svg#cut">');
  const r=await render(f,async url=>({bytes:svg,url,contentType:'image/svg+xml'}));
  for(const [name,text]of r.outputs){assert(text.includes('data:image/svg+xml;base64,'+svg.toString('base64')+'#cut'));assertInlineGraphics(text);assert.equal(restoreCanonicalMarkdown(name,text,r.index),f.files.get(name));}
});
test('independent Python verifies native Base64/CSS/SVG and rejects changed SVG geometry even after presentation hashes are updated',async t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'independent-inline-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const script="import sys,json;from pathlib import Path;sys.path.insert(0,'scripts');from verify_inline_images import audit_inline;p=Path(sys.argv[1]);audit_inline(p,json.loads((p/'IMAGE_INDEX.json').read_text()),json.loads((p/'documents.json').read_text()))";
  const check=(directory:string)=>spawnSync(process.env.LAW_IMAGE_PYTHON??'python3',['-c',script,directory],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{PATH:process.env.PATH},encoding:'utf8',timeout:60000});
  for(const [i,html]of [
    '<p>Preserved 😀 law.</p><img style="background-image:url(https://publications.europa.eu/bg)" src="https://publications.europa.eu/a.png">',
    '<p style="background-image:url(https://publications.europa.eu/bg)">Exact paragraph.</p><svg viewBox="0 0 10 10"><image href="https://publications.europa.eu/picture" width="10" height="10"/><filter id="f"><feImage href="https://publications.europa.eu/picture"/></filter><use href="#symbol"/><path id="symbol" d="M0 0L10 10"/></svg>',
    '<p style="background-image:url(https://publications.europa.eu/missing-bg)">Exact retained text.</p><svg viewBox="0 0 10 10"><image href="https://publications.europa.eu/missing-pic" width="10" height="10"/><path d="M0 0L10 10"/></svg>',
  ].entries()){
    const f=fixture(html),r=await render(f,i===2?async url=>{throw new ImageUnavailableError(['EN','PL','NL','FR'].map(language=>({language,url,outcome:'UNAVAILABLE',reason:'Source HTTP 404'})));}:undefined),directory=path.join(temp,String(i));fs.mkdirSync(directory);fs.mkdirSync(path.join(directory,'images'));
    for(const [n,s]of r.outputs)fs.writeFileSync(path.join(directory,n),s);
    for(const [n,b]of r.assets)fs.writeFileSync(path.join(directory,n),b);
    fs.writeFileSync(path.join(directory,'IMAGE_INDEX.json'),JSON.stringify(r.index));fs.writeFileSync(path.join(directory,'documents.json'),JSON.stringify([f.doc]));
    const passed=check(directory);assert.equal(passed.status,0,passed.stderr);
    if(i===1){
      const name=[...r.outputs].find(([_n,s])=>s.includes('data:image/svg+xml;base64,'))![0],before=r.outputs.get(name)!;
      const match=/data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/.exec(before)!;
      const changed=Buffer.from(match[1],'base64').toString().replace('L10 10','L20 20'),updated=before.replace(match[1],Buffer.from(changed).toString('base64'));
      const recipe=r.index.rendering!.files.find(f=>f.name===name)!;
      assert.equal(updated.length,before.length);recipe.renderedSha256=legalHash(updated);
      for(const p of recipe.patches)p.renderedSha256=legalHash(updated.slice(p.renderedStart,p.renderedEnd));
      fs.writeFileSync(path.join(directory,name),updated);fs.writeFileSync(path.join(directory,'IMAGE_INDEX.json'),JSON.stringify(r.index));
      assert.notEqual(check(directory).status,0,'Changed geometry cannot be certified by updated presentation hashes');
    }
  }
});
