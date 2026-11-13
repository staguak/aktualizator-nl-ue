import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fetchBinarySource,fetchSource} from './source-cache.js';
const url='https://official.example/original';
function directory(t:{after:(fn:()=>void)=>void}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'source-identity-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;
}
const validators={etag:'same-validator','last-modified':'Mon, 05 Oct 2026 10:00:00 GMT'};

test('HTTP validators do not follow a redirect to a different entity sharing the same ETag',async t=>{
  const cacheDir=directory(t);let target='old';const requests:{url:string;headers:Record<string,string>}[]=[];
  const fetcher=(async(input,init)=>{
    const current=String(input),headers=init!.headers as Record<string,string>;requests.push({url:current,headers});
    assert.equal(headers['If-None-Match'],undefined);assert.equal(headers['If-Modified-Since'],undefined);
    if(current===url)return new Response(null,{status:302,headers:{location:'/'+target}});
    return new Response(target+' original bytes',{headers:validators});
  }) as typeof fetch;
  const first=await fetchSource(url,{}, {cacheDir,fetcher});target='new';
  const corrected=await fetchSource(url,{}, {cacheDir,fetcher});
  assert.equal(first.url,'https://official.example/old');assert.equal(corrected.url,'https://official.example/new');
  assert.equal(first.text,'old original bytes');assert.equal(corrected.text,'new original bytes');
  assert.equal(corrected.observation!.status,200);assert.equal(requests.length,4);
});
test('a stable redirect revalidates only its exact final entity and retains original bytes and dates',async t=>{
  const cacheDir=directory(t);let seeded=false;const seen:{url:string;headers:Record<string,string>}[]=[];
  const fetcher=(async(input,init)=>{
    const current=String(input),headers=init!.headers as Record<string,string>;seen.push({url:current,headers});
    if(current===url){assert.equal(headers['If-None-Match'],undefined);assert.equal(headers['If-Modified-Since'],undefined);
      return new Response(null,{status:302,headers:{location:'/entity'}});}
    if(!seeded){seeded=true;return new Response(Buffer.from('official\r\nbytes'),{headers:validators});}
    assert.equal(headers['If-None-Match'],validators.etag);assert.equal(headers['If-Modified-Since'],validators['last-modified']);
    return new Response(null,{status:304});
  }) as typeof fetch;
  const first=await fetchSource(url,{}, {cacheDir,fetcher}),second=await fetchSource(url,{}, {cacheDir,fetcher});
  assert.deepEqual(second.bytes,first.bytes);assert.equal(second.url,first.url);
  assert.equal(second.observation!.status,304);assert.equal(second.observation!.retrievedAt,first.observation!.retrievedAt);
  assert.equal(seen.length,4);
});
test('an unsolicited 304 at a different redirected entity cannot certify old bytes or replace cache evidence',async t=>{
  const cacheDir=directory(t);
  await fetchSource(url,{}, {cacheDir,fetcher:async()=>new Response('old original',{headers:validators})});
  const file=path.join(cacheDir,fs.readdirSync(cacheDir)[0]),original=fs.readFileSync(file);
  await assert.rejects(fetchSource(url,{}, {cacheDir,fetcher:async(input,init)=>{
    const headers=init!.headers as Record<string,string>;
    if(String(input)===url){assert.equal(headers['If-None-Match'],validators.etag);return new Response(null,{status:302,headers:{location:'/new'}});}
    assert.equal(headers['If-None-Match'],undefined);assert.equal(headers['If-Modified-Since'],undefined);
    return new Response(null,{status:304});
  }}),/verified cache for the returned resource/);
  assert.deepEqual(fs.readFileSync(file),original);
});
test('cached provenance must satisfy the same HTTPS, credential, port and host boundary as a live response',async t=>{
  const cacheDir=directory(t),options={cacheDir,allowedHosts:['official.example']};
  await fetchSource(url,{}, {...options,fetcher:async()=>new Response('official',{headers:validators})});
  const file=path.join(cacheDir,fs.readdirSync(cacheDir)[0]),saved=JSON.parse(fs.readFileSync(file,'utf8'));
  for(const target of ['http://official.example/entity','https://user:secret@official.example/entity','https://official.example:444/entity','https://foreign.example/entity']){
    fs.writeFileSync(file,JSON.stringify({...saved,url:target}));
    await assert.rejects(fetchSource(url,{}, {...options,fetcher:async(_input,init)=>{
      assert.equal((init!.headers as Record<string,string>)['If-None-Match'],undefined);return new Response(null,{status:304});
    }}),/without a verified cache/);
  }
});
test('symlinked source cache ancestors or files cannot supply conditional bytes or receive writes',async t=>{
  const root=directory(t),outside=path.join(root,'outside'),cacheDir=path.join(outside,'cache'),link=path.join(root,'link');
  await fetchSource(url,{}, {cacheDir,fetcher:async()=>new Response('old cache',{headers:validators})});
  const file=path.join(cacheDir,fs.readdirSync(cacheDir)[0]),before=fs.readFileSync(file);fs.symlinkSync(outside,link,'dir');
  const fetcher:typeof fetch=async(_input,init)=>{
    assert.equal((init!.headers as Record<string,string>)['If-None-Match'],undefined);return new Response('fresh download');
  };
  assert.equal((await fetchSource(url,{}, {cacheDir:path.join(link,'cache'),fetcher})).text,'fresh download');
  assert.equal((await fetchSource(url,{}, {cacheDir:path.join(link,'missing'),fetcher})).text,'fresh download');
  assert(!fs.existsSync(path.join(outside,'missing')));assert.deepEqual(fs.readFileSync(file),before);
  const real=path.join(root,'real');fs.mkdirSync(real);const fileLink=path.join(real,path.basename(file));fs.symlinkSync(file,fileLink);
  assert.equal((await fetchSource(url,{}, {cacheDir:real,fetcher})).text,'fresh download');
  assert(fs.lstatSync(fileLink).isSymbolicLink());assert.deepEqual(fs.readFileSync(file),before);
});
test('a source cache redirected during network transfer cannot write through the replacement',async t=>{
  const root=directory(t),cacheDir=path.join(root,'cache'),outside=path.join(root,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'witness'),'preserve');
  const source=await fetchSource(url,{}, {cacheDir,fetcher:async()=>{fs.symlinkSync(outside,cacheDir,'dir');return new Response('fresh original');}});
  assert.equal(source.text,'fresh original');assert.deepEqual(fs.readdirSync(outside),['witness']);
});
test('an oversized source cache is ignored before parsing and replaced only by a fresh complete response',async t=>{
  const cacheDir=directory(t),maxBytes=8;
  await fetchSource(url,{}, {cacheDir,maxBytes,fetcher:async()=>new Response('old',{headers:validators})});
  const file=path.join(cacheDir,fs.readdirSync(cacheDir)[0]);fs.truncateSync(file,maxBytes*2+65_537);
  const result=await fetchSource(url,{}, {cacheDir,maxBytes,fetcher:async(_input,init)=>{
    assert.equal((init!.headers as Record<string,string>)['If-None-Match'],undefined);return new Response('new');
  }});
  assert.equal(result.text,'new');assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).base64,Buffer.from('new').toString('base64'));
});
test('optional HTTP cache mkdir, write, rename or cleanup failures never discard complete official bytes',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cache-storage-failure-')),remove=fs.rmSync.bind(fs);
  t.after(()=>remove(root,{recursive:true,force:true}));
  const bytes=Buffer.from([0xef,0xbb,0xbf,0x61,0x0d,0x0a]);
  for(const method of ['mkdirSync','writeFileSync','renameSync','rmSync'] as const){
    const cacheDir=path.join(root,method),original=fs[method].bind(fs);
    const mock=t.mock.method(fs,method,((...args:unknown[])=>{
      if(String(args[0]).startsWith(cacheDir))throw Object.assign(new Error('Injected optional cache storage failure'),{code:'EACCES'});
      return (original as (...values:unknown[])=>unknown)(...args);
    }) as typeof fs[typeof method]);
    try{
      const response=await fetchBinarySource(url,{}, {cacheDir,fetcher:async()=>new Response(bytes,{headers:validators})});
      assert.deepEqual(response.bytes,bytes);assert.equal(response.observation!.status,200);
      assert.equal(response.observation!.method,'downloaded');assert(response.observation!.retrievedAt);
    }finally{mock.mock.restore();}
  }
});

test('unused HTTP error and oversized response bodies are cancelled without replacing permanent status',async()=>{
  for(const mode of ['permanent','oversized','cancel-failure']){
    let cancelled=0;
    const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(Buffer.from('unused response'));},
      cancel(){cancelled++;if(mode==='cancel-failure')throw new Error('PRIVATE_CLEANUP_ERROR');}});
    const response=new Response(body,{status:mode==='oversized'?200:403,headers:mode==='oversized'?{'content-length':'1000'}:{}});
    await assert.rejects(fetchBinarySource(url,{}, {maxBytes:10,fetcher:async()=>response}),error=>{
      assert(!String(error).includes('PRIVATE_CLEANUP_ERROR'));
      return mode==='oversized'?/response size/.test(String(error)):(error as any).status===403;
    });
    assert.equal(cancelled,1,'Unused body must release its transport resources');
  }
});

test('an unresponsive unused-body cancellation is bounded and keeps its original HTTP failure',async()=>{
  const body=new ReadableStream<Uint8Array>({cancel(){return new Promise<void>(()=>{});}});
  const response=new Response(body,{status:403});
  const started=performance.now();
  await assert.rejects(fetchBinarySource(url,{}, {fetcher:async()=>response}),error=>(error as any).status===403);
  assert(performance.now()-started<5000,'Body cleanup must have a finite deadline');
});

test('redirect cleanup failure does not bypass destination controls or lose the verified final response',async()=>{
  for(const allowed of [true,false]){
    let requests=0;
    const fetcher=async()=>{
      requests++;
      if(requests===1)return new Response(new ReadableStream({cancel(){throw new Error('unused cleanup failure');}}),
        {status:303,headers:{location:allowed?'https://official.example/final':'https://unapproved.example/final'}});
      return new Response('official bytes');
    };
    const operation=fetchBinarySource(url,{}, {allowedHosts:['official.example'],fetcher});
    if(allowed){const result=await operation;assert.equal(result.bytes.toString(),'official bytes');assert.equal(requests,2);}
    else{await assert.rejects(operation,/Unexpected source host/);assert.equal(requests,1);}
  }
});
