import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {officialImage} from './package-images.js';
import {buildLegalImagePackage,validateLegalImagePackage} from './legal-images.js';
import {parseEuLegalStructure} from './eu-legal-structure.js';
import {indexLegalDocument,legalMarkdown,legalHash} from './legal-structure.js';

const jpeg=fs.readFileSync(new URL('./fixtures/01992L0058-native-image.jpg',import.meta.url));
const alias='http://publications.europa.eu/resource/celex/02006L0025-20190726.ENG.xhtml.FOR-CL2006L0025EN0040010.0001.0001.xml.jpg';
const canonical='https://publications.europa.eu/resource/cellar/example.0006.03/DOC_2';
function fixture(source:string,content='Entire article.'){
  const html=`<body><div class="eli-main-title">Full act</div><p>${content}</p><img src="${source}"></body>`;
  const draft=parseEuLegalStructure(html,{corpus:'EU',documentId:'02006L0025-20190726',version:'02006L0025-20190726',language:'EN',sourceUrl:'https://publications.europa.eu/act.xhtml',sourceSha256:legalHash(html)});
  const names=draft.chunks.map((_,i)=>`law-${i}.md`),doc=indexLegalDocument(draft,names,draft.chunks.map(p=>p.body));
  const files=new Map(names.map((n,i)=>[n,legalMarkdown('Law',doc,draft.chunks[i].body,[])]));
  return {doc,files};
}
test('CELLAR HTTP identities use HTTPS and a supported exact Accept through official redirects',async()=>{
  const seen:string[]=[];
  const response=await officialImage(alias,{fetcher:async(input,init)=>{
    const url=String(input);seen.push(url);assert.equal(new URL(url).protocol,'https:');
    assert.equal(new Headers(init?.headers).get('accept'),'image/jpeg');
    if(seen.length===1)return new Response(null,{status:303,headers:{location:canonical.replace('https:','http:')}});
    assert.equal(url,canonical);return new Response(jpeg,{headers:{'content-type':'image/jpeg;charset=UTF-8'}});
  }});
  assert.deepEqual(seen,[alias.replace('http:','https:'),canonical]);
  assert.deepEqual(response.bytes,jpeg);assert.equal(response.url,canonical);
});
test('package evidence preserves the original image URI and Markdown while recording canonical HTTPS bytes',async()=>{
  const {doc,files}=fixture(alias),before=[...files];
  const result=await buildLegalImagePackage([doc],n=>files.get(n)!,url=>officialImage(url,{fetcher:async(_input,init)=>{
    assert.equal(new Headers(init?.headers).get('accept'),'image/jpeg');
    return new Response(jpeg,{headers:{'content-type':'image/jpeg'}});
  }}));
  assert.deepEqual([...files],before);assert.equal(result.index.sources[0].requestUrl,alias);
  assert.equal(result.index.sources[0].responseUrl,alias.replace('http:','https:'));
  assert.equal(result.index.sources[0].key,legalHash(alias));
  assert.deepEqual([...result.assets.values()],[jpeg]);
  validateLegalImagePackage([doc],n=>files.get(n)!,result.index,n=>result.assets.get(n)!);
});
test('extensionless CELLAR items use generic Accept and preserve the native format',async()=>{
  const result=await officialImage(canonical,{fetcher:async(_input,init)=>{
    assert.equal(new Headers(init?.headers).get('accept'),'*/*');
    return new Response(jpeg,{headers:{'content-type':'application/octet-stream'}});
  }});
  assert.deepEqual(result.bytes,jpeg);
});
test('untrusted hosts, credentials, ports and protocols never reach the image transport',async()=>{
  let requests=0;
  for(const url of ['not a URL','https://publications.europa.eu.evil.example/a.jpg','http://example.europa.eu/a.jpg',
    'https://user:password@publications.europa.eu/a.jpg','https://publications.europa.eu:444/a.jpg',
    'http://publications.europa.eu:8080/a.jpg','file:///a.jpg','ftp://publications.europa.eu/a.jpg']){
    await assert.rejects(officialImage(url,{fetcher:async()=>{requests++;return new Response(jpeg);}}),/Untrusted official image URL/);
  }
  assert.equal(requests,0);
});
test('foreign-host and nonstandard-port redirects are rejected before following them',async()=>{
  for(const location of ['https://foreign.example/asset','https://publications.europa.eu:444/asset','file:///asset']){
    let requests=0;
    await assert.rejects(officialImage(alias,{fetcher:async()=>{requests++;return new Response(null,{status:302,headers:{location}});}}),/Unexpected source host or protocol/);
    assert.equal(requests,1);
  }
});
test('HTML with status 200 and corrupt image bytes cannot become official image evidence',async()=>{
  for(const [bytes,type] of [[Buffer.from('<html>Unavailable</html>'),'text/html'],[Buffer.from('broken JPEG'),'image/jpeg']] as const){
    await assert.rejects(officialImage(alias,{fetcher:async()=>new Response(bytes,{headers:{'content-type':type}})}),/Native image decode\/validation failed/);
  }
});
test('permanent errors and accepted-but-unfinished HTTP responses remain failures',async()=>{
  for(const status of [404,202])await assert.rejects(officialImage(alias,{fetcher:async()=>new Response('not an image',{status})}),error=>(error as {status:number}).status===status);
});
test('conditional image cache reuse retains exact bytes in both public and legacy cache modes',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'official-images-cache-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const prior=process.env.LAW_PUBLIC_INCREMENTAL,priorAudit=process.env.LAW_SOURCE_AUDIT;
  try{
    process.env.LAW_SOURCE_AUDIT='conditional';
    for(const incremental of ['0','1']){
      process.env.LAW_PUBLIC_INCREMENTAL=incremental;let calls=0;
      const options={cacheDir:path.join(root,incremental),fetcher:(async(_input,init)=>{
        const headers=new Headers(init?.headers);calls++;
        assert.equal(headers.get('accept'),'image/jpeg');
        if(calls===1){assert.equal(headers.get('if-none-match'),null);return new Response(jpeg,{headers:{etag:'native-jpeg','content-type':'image/jpeg'}});}
        assert.equal(headers.get('if-none-match'),'native-jpeg');return new Response(null,{status:304});
      }) as typeof fetch};
      const first=await officialImage(alias,options),second=await officialImage(alias,options);
      assert.deepEqual(second.bytes,first.bytes);assert.equal(second.observation!.status,304);assert.equal(calls,2);
    }
  }finally{
    if(prior===undefined)delete process.env.LAW_PUBLIC_INCREMENTAL;else process.env.LAW_PUBLIC_INCREMENTAL=prior;
    if(priorAudit===undefined)delete process.env.LAW_SOURCE_AUDIT;else process.env.LAW_SOURCE_AUDIT=priorAudit;
  }
});
test('the image size ceiling also applies to SVG in the public streaming cache',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'official-svg-limit-')),prior=process.env.LAW_PUBLIC_INCREMENTAL;
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  try{
    for(const incremental of ['0','1']){
      process.env.LAW_PUBLIC_INCREMENTAL=incremental;
      await assert.rejects(officialImage('https://publications.europa.eu/image.svg',{cacheDir:path.join(root,incremental),fetcher:async(_input,init)=>{
        assert.equal(new Headers(init?.headers).get('accept'),'image/svg+xml');
        return new Response('<svg xmlns="http://www.w3.org/2000/svg"/>',{headers:{'content-type':'image/svg+xml','content-length':'95000001'}});
      }}),/Invalid source response size/);
    }
  }finally{if(prior===undefined)delete process.env.LAW_PUBLIC_INCREMENTAL;else process.env.LAW_PUBLIC_INCREMENTAL=prior;}
});
