import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fetchBinarySource} from './source-cache.js';
import {parseSru,discoverVersions,selectBwbVersions} from './sru.js';
import {OfficialSources,loadSourceArchive} from './official-sources.js';
import {operationMetrics} from './operation-metrics.js';

const record=(id='BWBR0009616',from='2025-01-01')=>`<record><recordData><gzd><originalData><meta><bwbipm><geldigheidsperiode_startdatum>${from}</geldigheidsperiode_startdatum></bwbipm></meta></originalData><enrichedData><locatie_toestand>https://repository.officiele-overheidspublicaties.nl/bwb/${id}/2025-01-01_0/xml/${id}.xml</locatie_toestand></enrichedData></gzd></recordData></record>`;
const page=(records:string,total='1',next='')=>`<searchRetrieveResponse><numberOfRecords>${total}</numberOfRecords><records>${records}</records>${next?`<nextRecordPosition>${next}</nextRecordPosition>`:''}</searchRetrieveResponse>`;

test('SRU cannot silently drop malformed records or accept invalid pagination counters',()=>{
  for(const body of ['<record/>','<record><recordData><gzd/></recordData></record>'])assert.throws(()=>parseSru(page(body)),/Missing|Malformed/);
  for(const value of ['NaN','-1','1.5','Infinity'])assert.throws(()=>parseSru(page(record(),value)),/counters/);
  for(const value of ['0','-1','1.5','NaN'])assert.throws(()=>parseSru(page(record(),'1',value)),/counters/);
});
test('SRU rejects another act and contradictory observations of the same source state',async()=>{
  const source=(text:string,url:string)=>({bytes:Buffer.from(text),text,url,contentType:'application/xml'});
  await assert.rejects(discoverVersions('BWBR0009616',undefined,async url=>source(page(record('BWBR0002471')),url)),/identity/);
  await assert.rejects(discoverVersions('BWBR0009616',undefined,async url=>source(page(record()+record('BWBR0009616','2024-01-01'),'2'),url)),/Contradictory/);
});
test('SRU cannot mistake a repeated or out-of-order page for a complete catalog',async()=>{
  let calls=0;
  await assert.rejects(discoverVersions('BWBR0009616',undefined,async url=>{
    const text=page(calls++?record().replace('<record>','<record><recordPosition>1</recordPosition>'):
      Array.from({length:100},(_,i)=>record().replace('/2025-01-01_0/',`/2025-01-01_${i}/`).replace('<record>',`<record><recordPosition>${i+1}</recordPosition>`)).join(''),'101',calls===1?'101':'');
    return {text,bytes:Buffer.from(text),url,contentType:'application/xml'};
  }),/positions do not match requested page/);
  assert.equal(calls,2);
  assert.throws(()=>parseSru(page(record().replace('<record>','<record><recordPosition>-1</recordPosition>'))),/position/);
});
test('SRU retries repeated source payload even when its record positions advance correctly',async()=>{
  const retriesBefore=operationMetrics.snapshot().counters.sourceRetries;
  const archive=new OfficialSources('NL','BWBR0009616',{from:'2025-01-01',to:'2026-10-18',observedOn:'2026-10-18'});
  const fresh=record().replace('/2025-01-01_0/','/2025-01-01_1/');
  const requests:{start:number;unconditional:boolean|undefined}[]=[];
  const versions=await discoverVersions('BWBR0009616',archive,async(url,unconditional)=>{
    const start=Number(new URL(url).searchParams.get('startRecord'));requests.push({start,unconditional});
    const body=requests.length===1?record():requests.length===2?record():fresh;
    const text=page(body.replace('<record>',`<record><recordPosition>${start}</recordPosition>`),'2',start===1?'2':'');
    return {text,bytes:Buffer.from(text),url,contentType:'application/xml'};
  },async()=>{});
  assert.equal(versions.length,2);assert.deepEqual(requests,[{start:1,unconditional:false},{start:2,unconditional:false},{start:2,unconditional:true}]);
  assert.equal(operationMetrics.snapshot().counters.sourceRetries-retriesBefore,1,'Count the actual semantic page retry, not just HTTP transport retries');
  const native=archive.build('01_BWBR0009616.sources.zip'),loaded=loadSourceArchive(native.bytes,native.metadata,'NL','BWBR0009616');
  const rejected=loaded.index.entries.find((e:any)=>e.name==='sru/2-attempt-1.xml')!;
  assert.equal((rejected.metadata as any).accepted,false);assert.equal((rejected.metadata as any).rejection,'REPEATED_SOURCE_STATES');
  assert(Buffer.from(loaded.items[rejected.name]).includes(Buffer.from('/2025-01-01_0/')));
  assert.equal((loaded.index.discovery as any).discoveredStates,2);
});
test('persistently repeated SRU pages fail closed with every observed retry preserved',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'repeated-sru-')),previous=process.env.LAW_XML_DIAGNOSTICS_DIR;
  process.env.LAW_XML_DIAGNOSTICS_DIR=directory;t.after(()=>{if(previous===undefined)delete process.env.LAW_XML_DIAGNOSTICS_DIR;else process.env.LAW_XML_DIAGNOSTICS_DIR=previous;fs.rmSync(directory,{recursive:true,force:true});});
  const archive=new OfficialSources('NL','BWBR0009616',{from:'2025-01-01',to:'2026-10-18',observedOn:'2026-10-18'});let calls=0;
  await assert.rejects(discoverVersions('BWBR0009616',archive,async url=>{
    const start=Number(new URL(url).searchParams.get('startRecord'));calls++;
    const text=page(record().replace('<record>',`<record><recordPosition>${start}</recordPosition>`),'2',start===1?'2':'');
    return {text,bytes:Buffer.from(text),url,contentType:'application/xml'};
  },async()=>{}),/repeated source states across pagination/);
  assert.equal(calls,6);assert.equal(fs.readdirSync(directory).filter(name=>name.endsWith('.zip')).length,1);
  const native=archive.build('01_BWBR0009616.sources.zip'),loaded=loadSourceArchive(native.bytes,native.metadata,'NL','BWBR0009616');
  assert.equal(loaded.index.entries.length,6);assert.equal(loaded.index.discovery,undefined);
});
test('a reduced later SRU counter cannot certify coverage below an earlier declared count',async()=>{
  let calls=0;
  await assert.rejects(discoverVersions('BWBR0009616',undefined,async url=>{
    const text=calls++?page(record().replace('/2025-01-01_0/','/2025-01-01_1/'),'2'):page(record(),'3','2');
    return {text,bytes:Buffer.from(text),url,contentType:'application/xml'};
  },async()=>{}),/Incomplete SRU unique-state coverage/);
});
test('NL validity and visibility intervals reject malformed dates independently',()=>{
  const base={key:'one',toestandUrl:'https://example.org/state',validFrom:'2025-01-01',validTo:null};
  for(const change of [{validTo:'2024-12-31'},{visibleFrom:'2025-02-30'},{visibleTo:'invalid'},
    {visibleFrom:'2025-02-01',visibleTo:'2025-01-01'}])
    assert.throws(()=>selectBwbVersions([{...base,...change}],'2025-01-01','2025-01-02','2025-01-02'),/interval/);
  assert.throws(()=>selectBwbVersions([base],'2025-01-01','2025-01-02','2025-01-01'),/dates/);
});
test('a documentary date in the Toestand URL is not a substitute for a missing official g boundary',()=>{
  const missing=record().replace('<geldigheidsperiode_startdatum>2025-01-01</geldigheidsperiode_startdatum>','');
  const [version]=parseSru(page(missing)).records;
  assert.equal(version.validFrom,null);assert.equal(version.key,'2025-01-01_0');
  assert.throws(()=>selectBwbVersions([version],'2025-01-01','2025-01-02','2025-01-02'),/Missing\/invalid BWB state interval/);
});
test('source redirects are bounded and checked before contacting a disallowed host',async()=>{
  const requested:string[]=[];
  await assert.rejects(fetchBinarySource('https://official.example/source',{}, {allowedHosts:['official.example'],
    fetcher:async(input,options)=>{assert.equal(options?.redirect,'manual');requested.push(String(input));
      return new Response(null,{status:302,headers:{location:'https://internal.example/private'}});}}),/host/);
  assert.deepEqual(requested,['https://official.example/source']);
  let calls=0;
  await assert.rejects(fetchBinarySource('https://official.example/source',{}, {fetcher:async()=>{
    calls++;return new Response(null,{status:302,headers:{location:'/loop'}});}}),/excessive/);
  assert.equal(calls,6);
  for(const url of ['http://official.example/source','https://user:secret@official.example/source','https://official.example:8443/source'])
    await assert.rejects(fetchBinarySource(url,{}, {fetcher:async()=>{throw new Error('Must not request');}}),/protocol/);
});
test('a source transfer must be complete; conditional reuse records its real observation without inventing old dates',async t=>{
  const cacheDir=fs.mkdtempSync(path.join(os.tmpdir(),'source-time-'));t.after(()=>fs.rmSync(cacheDir,{recursive:true,force:true}));
  const url='https://official.example/source',bytes=Buffer.from('original official bytes');
  const first=await fetchBinarySource(url,{}, {cacheDir,fetcher:async()=>new Response(bytes,{headers:{etag:'v1'}})});
  const second=await fetchBinarySource(url,{}, {cacheDir,fetcher:async(_input,options)=>{
    assert.equal((options?.headers as Record<string,string>)['If-None-Match'],'v1');return new Response(null,{status:304});}});
  assert.deepEqual(second.bytes,bytes);assert.equal(second.observation!.method,'conditional-not-modified');
  assert.equal(second.observation!.retrievedAt,first.observation!.retrievedAt);
  assert(second.observation!.checkedAt>=first.observation!.checkedAt);
  const cacheFile=path.join(cacheDir,fs.readdirSync(cacheDir)[0]),legacy=JSON.parse(fs.readFileSync(cacheFile,'utf8'));
  delete legacy.retrievedAt;fs.writeFileSync(cacheFile,JSON.stringify(legacy));
  const third=await fetchBinarySource(url,{}, {cacheDir,fetcher:async()=>new Response(null,{status:304})});
  assert.equal(third.observation!.retrievedAt,null);
  await assert.rejects(fetchBinarySource(url,{}, {fetcher:async()=>new Response('partial',{status:206})}),/HTTP 206/);
});
test('official HTTP resource redirects use HTTPS transport and retain the original published location',async()=>{
  const calls:string[]=[],target='http://publications.europa.eu/resource/cellar/example/rdf/tree/full';
  const source=await fetchBinarySource('https://publications.europa.eu/resource/celex/32016R0679',{}, {
    allowedHosts:['publications.europa.eu'],fetcher:async url=>{
      calls.push(String(url));return calls.length===1?new Response(null,{status:303,headers:{location:target}}):new Response('<rdf/>');
    }});
  assert.equal(calls[1],target.replace('http:','https:'));assert(calls.every(url=>url.startsWith('https:')));
  assert.equal(source.observation!.redirects![0].location,target);assert.equal(source.url,calls[1]);
});
test('distinct source metadata cannot silently overwrite an archived observation of equal bytes',()=>{
  const url='https://official.example/source',archive=new OfficialSources('NL','BWBR0009616',{from:'2025-01-01',to:'2025-01-01',observedOn:'2025-01-01'});
  const source={bytes:Buffer.from('<toestand/>'),url,contentType:'application/xml'};
  archive.add('state.xml',source,url,'BWB-Toestand',{version:'one'});
  assert.throws(()=>archive.add('state.xml',source,url,'BWB-Toestand',{version:'two'}),/distinct archive entries/);
});
test('failed NL selection persists its exact discovery bytes and fails closed if that evidence cannot be stored',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'source-selection-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const previous=process.env.LAW_XML_DIAGNOSTICS_DIR;process.env.LAW_XML_DIAGNOSTICS_DIR=dir;
  t.after(()=>{if(previous===undefined)delete process.env.LAW_XML_DIAGNOSTICS_DIR;else process.env.LAW_XML_DIAGNOSTICS_DIR=previous;});
  const archive=new OfficialSources('NL','BWBR0009616',{from:'2025-01-01',to:'2026-10-18',observedOn:'2026-10-18'});
  const bytes=Buffer.from(page(record('BWBR0009616','2027-01-01'))),url='https://zoekservice.overheid.nl/sru/Search';
  archive.add('sru/1.xml',{bytes,url,contentType:'application/xml'},url,'SRU-2.0');
  const versions=parseSru(bytes.toString()).records;
  assert.throws(()=>selectBwbVersions(versions,'2025-01-01','2026-10-18','2026-10-18',archive),/No BWB state/);
  const recordFile=fs.readdirSync(dir).find(name=>name.endsWith('.selection.json'))!;
  const saved=JSON.parse(fs.readFileSync(path.join(dir,recordFile),'utf8'));
  assert.equal(saved.status,'INCOMPLETE_SOURCE_SELECTION');assert.equal(saved.code,'NL_SELECTION_FAILED');
  assert.equal(saved.range.observedOn,'2026-10-18');
  const restored=loadSourceArchive(fs.readFileSync(path.join(dir,saved.archive.file)),saved.archive,'NL','BWBR0009616');
  assert.deepEqual(Buffer.from(restored.items['sru/1.xml']),bytes);
  fs.writeFileSync(path.join(dir,saved.archive.file),'corrupt evidence');
  assert.throws(()=>selectBwbVersions(versions,'2025-01-01','2026-10-18','2026-10-18',archive),/evidence persistence failed/);
});
