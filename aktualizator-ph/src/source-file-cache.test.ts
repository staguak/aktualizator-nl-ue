import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fetchSourceFile,importSourceCache} from './source-cache.js';
import {OfficialSources,loadSourceArchive} from './official-sources.js';
import {incrementalPlan} from './incremental-plan.js';
import {warmPublicSources} from './public-incremental.js';

const url='https://publications.europa.eu/resource/example';
const headers={Accept:'application/rdf+xml'};
function temporary(t:import('node:test').TestContext){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'source-file-cache-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('a newer response cannot replace bytes still referenced by an earlier source',async t=>{
  const cacheDir=temporary(t);let calls=0;
  const fetcher=(async()=>new Response(++calls===1?'original':'changed',{headers:{ETag:'"'+calls+'"'}})) as typeof fetch;
  const first=await fetchSourceFile(url,headers,{cacheDir,fetcher});
  const second=await fetchSourceFile(url,headers,{cacheDir,fetcher});
  assert.equal(first.text,'original');assert.equal(second.text,'changed');
  assert.notEqual(first.filePath,second.filePath);
});
test('tampering with a verified file during revalidation cannot be accepted as a 304',async t=>{
  const cacheDir=temporary(t);
  const first=await fetchSourceFile(url,headers,{cacheDir,fetcher:(async()=>new Response('original',{headers:{ETag:'"one"'}})) as typeof fetch});
  await assert.rejects(()=>fetchSourceFile(url,headers,{cacheDir,fetcher:(async()=>{
    fs.writeFileSync(first.filePath!,'tampered');return new Response(null,{status:304});
  }) as typeof fetch}),/cache|changed|checksum/i);
});
test('unchanged sources transfer no body; changed, missing and corrupt entries are distinguished',async t=>{
  const cacheDir=temporary(t);
  const received:Headers[]=[];
  let body='first',status=200;
  const fetcher=(async(_url,options)=>{
    received.push(new Headers(options?.headers));
    return new Response(status===304?null:body,{status,headers:{ETag:'"one"','Last-Modified':'Fri, 13 Nov 2026 00:00:00 GMT'}});
  }) as typeof fetch;
  const first=await fetchSourceFile(url,headers,{cacheDir,fetcher});
  status=304;const unchanged=await fetchSourceFile(url,headers,{cacheDir,fetcher});
  assert.equal(unchanged.text,'first');assert.equal(received[1].get('If-None-Match'),'"one"');
  assert.equal(incrementalPlan().sources.at(-1)?.receivedBytes,0);
  status=200;body='other';const changed=await fetchSourceFile(url,headers,{cacheDir,fetcher});
  assert.equal(incrementalPlan().sources.at(-1)?.action,'CHANGED');assert.equal(first.text,'first');
  fs.unlinkSync(changed.filePath!);await fetchSourceFile(url,headers,{cacheDir,fetcher});
  assert.equal(incrementalPlan().sources.at(-1)?.action,'MISSING');assert.equal(received.at(-1)!.get('If-None-Match'),null);
  fs.writeFileSync(changed.filePath!,'wrong');await fetchSourceFile(url,headers,{cacheDir,fetcher});
  assert.equal(incrementalPlan().sources.at(-1)?.action,'CORRUPT');assert.equal(received.at(-1)!.get('If-Modified-Since'),null);
});
test('a restored source archive can seed a cold HTTP cache without certifying current freshness',async t=>{
  const original=temporary(t),restored=temporary(t);
  const source=await fetchSourceFile(url,headers,{cacheDir:original,fetcher:(async()=>new Response('original source',{headers:{ETag:'"original"'}})) as typeof fetch});
  const archive=new OfficialSources('EU','32024R0001',{from:'2025-01-01',to:'2026-11-14',observedOn:'2026-11-14'});
  archive.add('original.rdf.xml',source,url,'CELLAR-RDF-object');
  const native=archive.build('01_sources.sources.zip'),loaded=loadSourceArchive(native.bytes,native.metadata,'EU','32024R0001');
  const entry=loaded.index.entries[0];
  const app=temporary(t),checkpoint=path.join(app,'.checkpoint-ue');fs.mkdirSync(checkpoint);
  fs.writeFileSync(path.join(checkpoint,native.metadata.name),native.bytes);
  fs.writeFileSync(path.join(checkpoint,'state.json'),JSON.stringify({acts:[{celex:'32024R0001',sourceArchive:native.metadata}]}));
  assert.equal(warmPublicSources(app,restored).seeded,1);
  let checked=false;
  const current=await fetchSourceFile(url,headers,{cacheDir:restored,fetcher:(async(_url,options)=>{
    checked=true;assert.equal(new Headers(options?.headers).get('If-None-Match'),'"original"');return new Response(null,{status:304});
  }) as typeof fetch});
  assert(checked);assert.equal(current.text,'original source');assert.equal(current.observation?.status,304);
  assert.throws(()=>importSourceCache(restored,{...entry,cacheHint:{...entry.cacheHint,headers:{Authorization:'private'}}},loaded.items[entry.name]),/Unsafe/);
});
test('audit ignores validators, explicit limits abort streams, and symlinked sources cannot supply cached bytes',async t=>{
  const cacheDir=temporary(t),old=process.env.LAW_SOURCE_AUDIT;t.after(()=>{if(old===undefined)delete process.env.LAW_SOURCE_AUDIT;else process.env.LAW_SOURCE_AUDIT=old;});
  const first=await fetchSourceFile(url,headers,{cacheDir,fetcher:(async()=>new Response('source',{headers:{ETag:'"one"'}})) as typeof fetch});
  process.env.LAW_SOURCE_AUDIT='unconditional';
  await fetchSourceFile(url,headers,{cacheDir,fetcher:(async(_url,options)=>{assert.equal(new Headers(options?.headers).get('If-None-Match'),null);return new Response('source');}) as typeof fetch});
  assert.equal(incrementalPlan().sources.at(-1)?.action,'AUDIT');
  process.env.LAW_SOURCE_AUDIT='conditional';
  await assert.rejects(()=>fetchSourceFile(url,headers,{cacheDir,maxBytes:2,fetcher:(async()=>new Response('too long')) as typeof fetch}),/size/);
  const outside=path.join(cacheDir,'outside');fs.writeFileSync(outside,'source');fs.unlinkSync(first.filePath!);fs.symlinkSync(outside,first.filePath!);
  await assert.rejects(()=>fetchSourceFile(url,headers,{cacheDir,fetcher:(async(_url,options)=>{
    assert.equal(new Headers(options?.headers).get('If-None-Match'),null);return new Response(null,{status:304});
  }) as typeof fetch}),/304/);
  assert.equal(fs.readFileSync(outside,'utf8'),'source');
});
