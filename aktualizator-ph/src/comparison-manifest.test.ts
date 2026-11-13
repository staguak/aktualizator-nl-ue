import test from 'node:test';
import assert from 'node:assert/strict';
import {zipSync} from 'fflate';
import {comparisonManifest} from './comparison-manifest.js';
import {buildReport} from './build-report.js';
import {pendingValidation} from './validation-result.js';
import {OfficialSources,unpackOfficialZip} from './official-sources.js';
import {observeUnits} from './unit-observations.js';
import {newContext} from './release-engine.js';
import type {ReleaseManifest} from './release-engine.js';
import type {ReleaseStore} from './release-store.js';
import {encode,hash} from './release-store.js';
import {stableCompactJson,fileMetadata} from './output.js';

function fixture(legacy:boolean,kind:'base'|'release'='release'){
  const xml=Buffer.from('<toestand bwb-id="BWBR0000001"><artikel stam-id="stable">A</artikel></toestand>');
  const unit=observeUnits(xml,{jurisdiction:'NL',documentId:'BWBR0000001',url:'https://example.org/a'});
  const a=new OfficialSources('NL','BWBR0000001',{from:'2025-01-01',to:kind==='base'?'2025-01-01':'2026-10-20',observedOn:'2026-10-20'});
  a.add('state.xml',{bytes:xml,url:'https://example.org/a',contentType:'application/xml'},'https://example.org/a','BWB-Toestand',
    {unitHistoryProfile:unit.profile,unitHistorySource:unit.source,units:unit.units,unitCorrections:unit.corrections,version:{key:'state'}});
  const native=a.build('01_BWBR0000001.sources.zip');
  if(legacy){
    const items=unpackOfficialZip(native.bytes),index=JSON.parse(Buffer.from(items['manifest.json']).toString());
    delete index.sourceIssueProfile;delete index.sourceIssues;for(const entry of index.entries)delete entry.sha256;
    items['manifest.json']=Buffer.from(stableCompactJson(index));native.bytes=Buffer.from(zipSync(items));
    Object.assign(native.metadata,fileMetadata(native.metadata.name,native.bytes));delete native.metadata.reportEvidence;delete native.metadata.sourceIssueProfile;
  }
  const context=newContext({mode:kind==='base'?'initialize':'update',baseId:'base',parentReleaseId:kind==='base'?null:'before',codeRevision:'fixture',configSha256:'a'.repeat(64),
    rangeFrom:'2025-01-01',rangeTo:'2026-10-20',observedOn:'2026-10-20'}),prefix=kind==='base'?`base/${context.baseId}`:`releases/${context.releaseId}`;
  const entries=new Map<string,Buffer>([
    [`${prefix}/NL/manifest.json`,encode({jurisdiction:'NL',rangeFrom:context.rangeFrom,rangeTo:kind==='base'?context.rangeFrom:context.rangeTo,acts:[{order:1,bwbId:a.identifier,files:[],sourceArchive:native.metadata}]})],
    [`${prefix}/EU/manifest.json`,encode({jurisdiction:'EU',rangeFrom:context.rangeFrom,rangeTo:kind==='base'?context.rangeFrom:context.rangeTo,acts:[]})],
    [`${prefix}/NL/${native.metadata.name}`,native.bytes],
  ]);
  const manifest:ReleaseManifest={schemaVersion:1,context,kind,nlManifest:prefix+'/NL/manifest.json',euManifest:prefix+'/EU/manifest.json',
    files:[...entries].map(([key,bytes])=>({key,id:key,jurisdiction:key.includes('/NL/')?'NL':'EU',name:key.split('/').at(-1)!,
      size:bytes.length,md5:hash(bytes,'md5'),sha256:hash(bytes)}))};
  const reads:string[]=[];
  const store:ReleaseStore={read:async key=>{reads.push(key);return entries.get(key)??null;},stat:async()=>null,list:async()=>[],
    write:async()=>{throw new Error('Forbidden predecessor write');},remove:async()=>{throw new Error('Forbidden predecessor deletion');}};
  return {store,manifest,entries,reads,nativeKey:`${prefix}/NL/${native.metadata.name}`};
}
test('legacy comparison derives unit evidence from verified native bytes without modifying any old object',async()=>{
  const f=fixture(true),before=[...f.entries].map(([k,b])=>[k,Buffer.from(b)]);
  const local=await comparisonManifest(f.store,f.manifest,'NL');
  assert.equal(local.acts[0].sourceArchive.reportEvidence.units.length,1);assert.equal(local.sourceReportComparison.backfilled.length,1);
  assert.equal(local.sourceReportComparison.backfilled[0].sha256,hash(f.entries.get(f.nativeKey)!));
  assert.equal(f.reads.filter(k=>k===f.nativeKey).length,1);assert.deepEqual([...f.entries],before);
  const persisted=JSON.parse(f.entries.get(f.manifest.nlManifest)!.toString());assert.equal(persisted.acts[0].sourceArchive.reportEvidence,undefined);
});
test('published compact comparison indexes avoid repeated source downloads; corrupt old bytes fail before new work',async()=>{
  const ready=fixture(false);await comparisonManifest(ready.store,ready.manifest,'NL');assert(!ready.reads.includes(ready.nativeKey));
  const broken=fixture(true);broken.entries.set(broken.nativeKey,Buffer.from('corrupt'));
  await assert.rejects(comparisonManifest(broken.store,broken.manifest,'NL'),/archive changed/);
  const missing=fixture(true);missing.manifest.files=missing.manifest.files.filter(f=>f.key!==missing.nativeKey);
  await assert.rejects(comparisonManifest(missing.store,missing.manifest,'NL'),/Missing predecessor source/);
});

test('initial release compares against immutable base at range start, not against the future range end',async()=>{
  const f=fixture(true,'base');
  const comparison=await comparisonManifest(f.store,f.manifest,'NL');
  assert.equal(comparison.rangeTo,f.manifest.context.rangeFrom);
  assert.equal(comparison.sourceReportComparison.generationKind,'base');
  assert.equal(comparison.sourceReportComparison.baseId,f.manifest.context.baseId);
  assert.equal(comparison.sourceReportComparison.releaseId,null);
  const current={jurisdiction:'NL',rangeFrom:f.manifest.context.rangeFrom,rangeTo:f.manifest.context.rangeTo,officialSources:{observedOn:f.manifest.context.observedOn},acts:[]};
  const report=buildReport(current,comparison,pendingValidation(),{LAW_RELEASE_CONTEXT:JSON.stringify(f.manifest.context)});
  assert.equal(report.comparison.baseline,'IMMUTABLE_BASE_AT_RANGE_START');
  const incorrect=JSON.parse(f.entries.get(f.manifest.nlManifest)!.toString());incorrect.rangeTo=f.manifest.context.rangeTo;
  const bytes=encode(incorrect);f.entries.set(f.manifest.nlManifest,bytes);
  Object.assign(f.manifest.files.find(file=>file.key===f.manifest.nlManifest)!,{size:bytes.length,sha256:hash(bytes),md5:hash(bytes,'md5')});
  await assert.rejects(comparisonManifest(f.store,f.manifest,'NL'),/scope mismatch/);
});
