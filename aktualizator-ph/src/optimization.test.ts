import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fetchSource} from './source-cache.js';
import {runPool} from './concurrency.js';
import {retryDrive,transientDriveError} from './drive-retry.js';
import {createEuSourceLoader} from './eu-provider.js';
import {euLayoutBytes,euContent,extractEuBody} from './eu-normalize.js';
import {htmlIntegrity} from './content-integrity.js';
import {buildModules} from './build-runner.js';
import {renderAct} from './render.js';
import {finalizeEu} from './eu-output.js';
import type {ScopeAct,VersionSnapshot} from './types.js';
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function temporary(t:{after:(fn:()=>void)=>void}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'updater-opt-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('pool bounds active work, stops scheduling on failure and drains active workers',async()=>{
 let active=0,max=0,settled=0;const started:number[]=[];
 await assert.rejects(()=>runPool([0,1,2,3,4,5,6,7],3,async i=>{
  started.push(i);active++;max=Math.max(max,active);
  try{await wait(i===1?1:15);if(i===1)throw new Error('failed');}finally{active--;settled++;}
 }));
 assert.equal(max,3);assert.deepEqual(started,[0,1,2]);assert.equal(active,0);assert.equal(settled,3);
});
test('source cache revalidates every call and accepts only a verified conditional 304',async t=>{
 const cacheDir=temporary(t),seen:any[]=[];let n=0;
 const fetcher=(async(_url:any,init:any)=>{seen.push(init.headers);return n++===0?new Response('eerste bron',{headers:{etag:'"v1"'}}):new Response(null,{status:304});}) as typeof fetch;
 const first=await fetchSource('https://example.org/act',{Accept:'text/html'},{cacheDir,fetcher});
 const revalidated=await fetchSource('https://example.org/act',{Accept:'text/html'},{cacheDir,fetcher});
 assert.deepEqual({...revalidated,observation:undefined},{...first,observation:undefined});
 assert.equal(revalidated.observation!.status,304);assert.equal(first.observation!.status,200);
 assert.equal(revalidated.observation!.retrievedAt,first.observation!.retrievedAt);
 assert.equal(seen.length,2);assert.equal(seen[1]['If-None-Match'],'"v1"');
 const updated=await fetchSource('https://example.org/act',{Accept:'text/html'},{cacheDir,fetcher:(async()=>new Response('gecorrigeerde bron',{headers:{etag:'"v2"'}})) as typeof fetch});
 assert.equal(updated.text,'gecorrigeerde bron');
 await assert.rejects(()=>fetchSource('https://example.org/act',{Accept:'text/html'},{cacheDir,fetcher:(async()=>new Response('error',{status:503})) as typeof fetch}));
});
test('corrupt cache, absent validators, request variants and redirect hosts cannot reuse stale data',async t=>{
 const cacheDir=temporary(t),url='https://example.org/act';
 await fetchSource(url,{Accept:'text/html'},{cacheDir,fetcher:(async()=>new Response('old',{headers:{etag:'v1'}})) as typeof fetch});
 const file=path.join(cacheDir,fs.readdirSync(cacheDir)[0]),value=JSON.parse(fs.readFileSync(file,'utf8'));value.base64=Buffer.from('corruption').toString('base64');fs.writeFileSync(file,JSON.stringify(value));
 let conditional:any;
 await fetchSource(url,{Accept:'text/html'},{cacheDir,fetcher:(async(_u:any,init:any)=>{conditional=init.headers;return new Response('fresh');}) as typeof fetch});
 assert.equal(conditional['If-None-Match'],undefined);
 await assert.rejects(()=>fetchSource(url,{Accept:'text/html'},{cacheDir,fetcher:(async()=>new Response(null,{status:304})) as typeof fetch}));
 await assert.rejects(()=>fetchSource(url,{Accept:'application/xml'},{cacheDir,fetcher:(async()=>new Response(null,{status:304})) as typeof fetch}));
 const response=new Response('source');Object.defineProperty(response,'url',{value:'https://untrusted.org/redirect'});
 await assert.rejects(()=>fetchSource(url,{}, {cacheDir,allowedHosts:['example.org'],fetcher:(async()=>response) as typeof fetch}));
 assert.equal(fs.readdirSync(cacheDir).length,1);
});
test('Last-Modified conditional responses and parallel writes preserve complete source entries',async t=>{
 const cacheDir=temporary(t),url='https://example.org/modified';
 await fetchSource(url,{}, {cacheDir,fetcher:(async()=>new Response('one',{headers:{'last-modified':'Mon, 05 Oct 2026 10:00:00 GMT'}})) as typeof fetch});
 const response=await fetchSource(url,{}, {cacheDir,fetcher:(async(_u:any,init:any)=>{assert.equal(init.headers['If-Modified-Since'],'Mon, 05 Oct 2026 10:00:00 GMT');return new Response(null,{status:304});}) as typeof fetch});assert.equal(response.text,'one');
 await Promise.all([1,2].map(i=>fetchSource(url,{}, {cacheDir,fetcher:(async()=>new Response('complete '+i)) as typeof fetch})));
 assert.equal(fs.readdirSync(cacheDir).length,1);assert.match(Buffer.from(JSON.parse(fs.readFileSync(path.join(cacheDir,fs.readdirSync(cacheDir)[0]),'utf8')).base64,'base64').toString('utf8'),/^complete [12]$/);
});
test('one shared source load per CELEX/include and failed loads remain retryable',async()=>{
 let calls=0,fail=false;const body='<p>tekst</p>',parsed={chunks:[body],articleCount:1,textLength:body.length,integrity:htmlIntegrity(body)};
 const loader=createEuSourceLoader(async()=>{calls++;await wait(1);if(fail){fail=false;throw new Error('network');}return {html:body,sourceUrl:'https://example.org/act',parsed};});
 const doc={celex:'32008L0104',include:'full-document',metadata:{},role:'original'};
 const [a,b]=await Promise.all([loader(doc),loader(doc)]);assert.equal(calls,1);assert.equal(a,b);
 fail=true;await assert.rejects(()=>loader({...doc,include:'operative-part'}));
 await loader({...doc,include:'operative-part'});assert.equal(calls,3);
});
test('Drive retries transient limits without retrying permission or validation errors',async()=>{
 let attempts=0;const delays:number[]=[];
 assert.equal(await retryDrive(async()=>{if(attempts++<2)throw {response:{status:429}};return 'ok';},async ms=>{delays.push(ms);}), 'ok');
 assert.equal(attempts,3);assert.equal(delays.length,2);assert.ok(delays[1]>delays[0]);
 assert.equal(transientDriveError({response:{status:403,data:{error:{errors:[{reason:'userRateLimitExceeded'}]}}}}),true);
 assert.equal(transientDriveError({response:{status:403}}),false);
 attempts=0;await assert.rejects(()=>retryDrive(async()=>{attempts++;throw new Error('validation');},async()=>{}));assert.equal(attempts,1);
});
test('byte accounting uses exactly the final header and legal delimiters',()=>{
 for(const celex of ['32008L0104','02008L0104-20250101'])for(const body of ['<p>ąć</p>\n','  <table><tr><td>tekst</td></tr></table>\n']){
  const output=euContent('Titel ą',celex,1,2,body,'https://example.org/act');
  assert.equal(euLayoutBytes('Titel ą',celex,1,2,'https://example.org/act'),Buffer.byteLength(output)-Buffer.byteLength(extractEuBody(output)));
 }
});
test('a sensitive element in one part preserves itself while safe indentation in another part is optimized',()=>{
 const chunks=['<p>tekst</p>\n  <div>blok</div>','<pre>a  b</pre>'],celex='32008L0104';
 const built={order:1,title:'Test',celex,excludedDocuments:[],documents:[{celex,include:'full-document',role:'original',metadata:{},sourceUrl:'https://example.org/act',sourceSha256:'a'.repeat(64),articleCount:1,textLength:0,integrity:htmlIntegrity(chunks.join('\n'))}],files:chunks.map((_c,i)=>({name:`01_part${i+1}.md`,celex,part:i+1,md5:'a'.repeat(32)}))};
 const final=finalizeEu([built],name=>chunks[name.includes('part1')?0:1]);
 assert.deepEqual(final.acts[0].documents[0].htmlNormalization,['verified','sensitive-skip']);
 assert.match(extractEuBody(final.outputs.get('01_part1.md')!),/\n<div>/);
 assert.equal(extractEuBody(final.outputs.get('01_part2.md')!),'<pre>a  b</pre>');
});
test('parallel builds share dates and await a healthy sibling before returning failure',async t=>{
 const dir=temporary(t),gate=path.join(dir,'gate'),done=path.join(dir,'done'),good=path.join(dir,'good.mjs'),bad=path.join(dir,'bad.mjs');
 fs.writeFileSync(good,`import fs from 'node:fs'; if(!process.env.LAW_RANGE_TO||!process.env.LAW_GENERATED_AT)process.exit(3); fs.writeFileSync(${JSON.stringify(gate)},'started'); await new Promise(r=>setTimeout(r,150)); fs.writeFileSync(${JSON.stringify(done)},process.env.LAW_RANGE_TO);`);
 fs.writeFileSync(bad,`import fs from 'node:fs'; let i=0; while(!fs.existsSync(${JSON.stringify(gate)})&&i++<100)await new Promise(r=>setTimeout(r,10)); if(!fs.existsSync(${JSON.stringify(gate)}))process.exit(4); process.exit(1);`);
 await assert.rejects(()=>buildModules([bad,good],{...process.env,LAW_RANGE_TO:'2026-10-07',LAW_GENERATED_AT:'2026-10-07T18:40:00Z'}));
 assert.equal(fs.readFileSync(done,'utf8'),'2026-10-07');
});
test('NL size prediction preserves boundaries when sorted local source IDs cross S9/S10',()=>{
 const articles=Array.from({length:20},(_,i)=>String(i+1));
 const act:ScopeAct={order:1,title:'Test',bwbId:'BWBR0000001',include:{articles},mustIncludeArticles:articles};
 const snapshots:VersionSnapshot[]=Array.from({length:12},(_,i)=>({version:{key:String(i),toestandUrl:`https://example.org/${String(i).padStart(2,'0')}.xml`,validFrom:`2025-${String(i+1).padStart(2,'0')}-01`,validTo:null},statute:{bwbId:act.bwbId,title:act.title,provisions:articles.map(article=>({article,provisionRef:article,structurePath:'',content:'ą'.repeat(1900)}))}}));
 const result=renderAct(act,snapshots,'2025-01-01','2026-10-07');assert.ok(result.chunks.length>1);
 assert.ok(result.chunks.every(c=>Buffer.byteLength(c.content)<=50_000));assert.match(result.chunks[0].content,/\[\^S10\]/);
 assert.equal(result.chunks.flatMap(c=>c.articles).length,20);
});
