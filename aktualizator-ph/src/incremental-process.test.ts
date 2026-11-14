import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=fileURLToPath(new URL('../',import.meta.url));
const venv=path.join(root,'.venv/bin/python');
const python=process.env.LAW_XML_PYTHON??(fs.existsSync(venv)?venv:'python3');
const child=`
import fs from 'node:fs';import path from 'node:path';
import {fetchSource} from './src/source-cache.ts';
import {validateSourceXml,closeXmlValidation} from './src/xml-validation.ts';
import {parseNlSource} from './src/parsed-source-cache.ts';
import {incrementalNlModel,incrementalEuNormalization,incrementalEuNavigation} from './src/incremental-model.ts';
import {operationMetrics} from './src/operation-metrics.ts';
import {incrementalPlan} from './src/incremental-plan.ts';
import {OfficialSources} from './src/official-sources.ts';
import {warmPublicSources} from './src/public-incremental.ts';
const [directory,phase,to]=process.argv.slice(1),changed=phase==='changed'||phase==='audit';
const warm=phase==='audit'?null:warmPublicSources(directory,process.env.LAW_SOURCE_CACHE_DIR);
const xml='<s:searchRetrieveResponse xmlns:s="http://docs.oasis-open.org/ns/search-ws/sruResponse" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://docs.oasis-open.org/ns/search-ws/sruResponse http://docs.oasis-open.org/search-ws/searchRetrieve/v1.0/os/schemas/sruResponse.xsd"><s:numberOfRecords>'+(changed?'4':'3')+'</s:numberOfRecords></s:searchRetrieveResponse>';
let calls=0;
const source=await fetchSource('https://zoekservice.overheid.nl/sru/Search',{Accept:'application/xml'},{cacheDir:process.env.LAW_SOURCE_CACHE_DIR,
 fetcher:async(_url,options)=>{calls++;const conditional=new Headers(options.headers).has('If-None-Match');
  return new Response(conditional&&!changed?null:xml,{status:conditional&&!changed?304:200,headers:{ETag:changed?'"two"':'"one"','Content-Type':'application/xml'}});}});
const receipt=await validateSourceXml(source,'SRU-2.0');
if(phase==='first'){
 const archive=new OfficialSources('NL','BWBR0000001',{from:'2025-01-01',to,observedOn:to});
 archive.add('discovery.xml',source,'https://zoekservice.overheid.nl/sru/Search','SRU-2.0');
 const original=archive.build('01_discovery.sources.zip');
 const progress=path.join(directory,'.checkpoint');fs.mkdirSync(path.join(progress,'output'),{recursive:true});
 fs.writeFileSync(path.join(progress,'output',original.metadata.name),original.bytes);
 fs.writeFileSync(path.join(progress,'state.json'),JSON.stringify({completedActs:[{bwbId:'BWBR0000001',sourceArchive:original.metadata}]}));
}
const content=changed?'Bravo':'Alpha';
const raw='<toestand bwb-id="BWBR0000001"><wetgeving><intitule>Test</intitule><artikel nr="1"><al>'+content+'</al></artikel></wetgeving></toestand>';
const statute=parseNlSource({bytes:Buffer.from(raw),text:raw,url:'https://repository.officiele-overheidspublicaties.nl/bwb/test',contentType:'application/xml'});
const model=incrementalNlModel(process.cwd(),{order:1,title:'Test',bwbId:'BWBR0000001',include:{articles:['1']},mustIncludeArticles:['1'],retrievalScope:'full-act'},
 [{version:{key:'first',validFrom:'2024-01-01',validTo:null,toestandUrl:'https://repository.officiele-overheidspublicaties.nl/bwb/test'},statute}],'2025-01-01',to);
const normalized=incrementalEuNormalization('<p id="article_1">Article 1 '+content+'</p>');
const eu=incrementalEuNavigation([normalized.body],['law.md'],'https://publications.europa.eu/resource/test');
closeXmlValidation();
fs.writeFileSync(path.join(directory,'process-result.json'),JSON.stringify({receipt:receipt.status,rangeTo:model.rangeTo,content:model.states[0].content,eu:eu.chunks,
 counters:operationMetrics.snapshot().counters,plan:incrementalPlan(),calls,warm}));
`;
test('fresh processes restore cache/checkpoints, reuse unchanged sources and rebuild changed or audited data',t=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'incremental-process-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const first=path.join(temporary,'first'),restored=path.join(temporary,'restored');fs.mkdirSync(first);
  function run(directory:string,phase:string,to:string){
    fs.rmSync(path.join(directory,'process-result.json'),{force:true});
    const env:NodeJS.ProcessEnv={...process.env,LAW_PUBLIC_INCREMENTAL:'1',LAW_CACHE_SHARDS:'8',LAW_SOURCE_CACHE_DIR:path.join(directory,'.source-cache'),
      LAW_XML_SOURCE_ROOT:path.join(directory,'.source-cache'),LAW_XML_DIAGNOSTICS_DIR:path.join(directory,'.diagnostics'),
      LAW_XML_VALIDATION:'required',LAW_XML_PYTHON:python,LAW_SOURCE_AUDIT:phase==='audit'?'unconditional':'conditional'};
    delete env.GOOGLE_DRIVE_OAUTH_JSON;
    const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',child,directory,phase,to],
      {cwd:root,env,stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:30000,maxBuffer:1000000});
    assert.equal(result.status,0,result.stderr);assert.ifError(result.error);
    return JSON.parse(fs.readFileSync(path.join(directory,'process-result.json'),'utf8'));
  }
  const initial=run(first,'first','2026-11-13');
  assert.equal(initial.receipt,'PASS');assert(initial.counters.sourceReceivedEntityBytes>0);
  assert.equal(initial.counters.xmlComputed,1);assert.equal(initial.counters.parserComputed,1);assert.equal(initial.counters.modelComputed,3);
  const checkpoint=fs.readFileSync(path.join(first,'.checkpoint','state.json'));
  fs.mkdirSync(path.join(first,'output'));fs.writeFileSync(path.join(first,'output','proof'),'protected good base');
  const packed=spawnSync(python,['-c',
    'import sys\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\nfrom public_releases import pack_runtime_state,restore_state\np=Path(sys.argv[4])\npack_runtime_state(Path(sys.argv[2]),[".checkpoint","output"],p)\nrestore_state(p,Path(sys.argv[3]))',
    path.join(root,'scripts'),first,restored,path.join(temporary,'state.zip')],{stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:20000});
  assert.equal(packed.status,0,packed.stderr);assert.ifError(packed.error);
  assert.deepEqual(fs.readFileSync(path.join(restored,'.checkpoint','state.json')),checkpoint);
  const next=run(restored,'unchanged','2026-11-14');
  assert.equal(next.warm.seeded,1);
  assert.equal(next.calls,1);assert.equal(next.counters.sourceReceivedEntityBytes,0);
  assert.equal(next.counters.sourceNotModified,1);assert.equal(next.counters.xmlComputed,0);assert.equal(next.counters.xmlCacheHits,1);
  assert.equal(next.counters.parserComputed,0);assert.equal(next.counters.parserCacheHits,1);assert.equal(next.counters.modelComputed,0);assert.equal(next.counters.modelCacheHits,3);
  assert.equal(next.rangeTo,'2026-11-14');assert.equal(next.content,'Alpha');assert.deepEqual(next.eu,initial.eu);
  const changed=run(restored,'changed','2026-11-14');
  assert.equal(changed.plan.sources[0].action,'CHANGED');assert(changed.counters.sourceReceivedEntityBytes>0);
  assert.equal(changed.content,'Bravo');assert.equal(changed.counters.xmlComputed,1);assert.equal(changed.counters.parserComputed,1);assert.equal(changed.counters.modelComputed,3);
  const audit=run(restored,'audit','2026-11-14');
  assert.equal(audit.plan.sources[0].action,'AUDIT');assert(audit.counters.sourceReceivedEntityBytes>0);
  assert.equal(audit.counters.xmlComputed,1);assert.equal(audit.counters.xmlCacheHits,0);assert.equal(audit.counters.parserComputed,1);assert.equal(audit.counters.modelCacheHits,0);
  for(const shard of fs.readdirSync(path.join(restored,'.source-cache','validated'))){
    const dir=path.join(restored,'.source-cache','validated',shard);
    for(const file of fs.readdirSync(dir))fs.writeFileSync(path.join(dir,file),'{');
  }
  const repaired=run(restored,'unchanged','2026-11-14');
  assert.equal(repaired.counters.sourceReceivedEntityBytes,0);assert.equal(repaired.counters.xmlCacheHits,0);assert.equal(repaired.counters.xmlComputed,1);
  assert.equal(fs.readFileSync(path.join(restored,'output','proof'),'utf8'),'protected good base');
});
test('the public RDF provider streams an original exceeding the former 64 MB frame limit',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'public-large-rdf-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const script=`
    import fs from 'node:fs';import path from 'node:path';
    import {fetchRdfNotice} from './src/eu-provider.ts';import {closeXmlValidation} from './src/xml-validation.ts';
    const prefix=Buffer.from('<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:cdm="http://publications.europa.eu/ontology/cdm#"><rdf:Description rdf:about="https://publications.europa.eu/resource/celex/32024R0001"><cdm:resource_legal_id_celex>32024R0001</cdm:resource_legal_id_celex></rdf:Description>');
    const padding=Buffer.alloc(1024*1024,32);let phase=0,remaining=64000001;
    globalThis.fetch=async()=>new Response(new ReadableStream({pull(controller){
      if(!phase++){controller.enqueue(prefix);return;}
      if(remaining){const size=Math.min(remaining,padding.length);controller.enqueue(padding.subarray(0,size));remaining-=size;return;}
      controller.enqueue(Buffer.from('</rdf:RDF>'));controller.close();
    }}),{headers:{'Content-Type':'application/rdf+xml',ETag:'"large"'}});
    const value=await fetchRdfNotice('https://publications.europa.eu/resource/celex/32024R0001',undefined,'EN','32024R0001');
    closeXmlValidation();
    fs.writeFileSync(path.join(process.argv[1],'rdf-result.json'),JSON.stringify({size:value.source.size,file:!!value.source.filePath,
      kind:value.kind,mode:value.xmlValidation?.validationMode,graph:value.xmlValidation?.rdfGraph?.status}));
  `;
  const env:NodeJS.ProcessEnv={...process.env,LAW_PUBLIC_INCREMENTAL:'1',LAW_XML_VALIDATION:'required',LAW_SOURCE_AUDIT:'conditional',LAW_XML_PYTHON:python,
    LAW_SOURCE_CACHE_DIR:path.join(directory,'.source-cache'),LAW_XML_SOURCE_ROOT:path.join(directory,'.source-cache'),LAW_XML_DIAGNOSTICS_DIR:path.join(directory,'.diagnostics')};
  delete env.GOOGLE_DRIVE_OAUTH_JSON;
  const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script,directory],
    {cwd:root,env,stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:40000,maxBuffer:1000000});
  assert.equal(result.status,0,result.stderr);assert.ifError(result.error);
  const proof=JSON.parse(fs.readFileSync(path.join(directory,'rdf-result.json'),'utf8'));
  assert(proof.size>64000000);assert.equal(proof.file,true);assert.equal(proof.kind,'CELLAR-RDF-tree');
  assert.equal(proof.mode,'STREAMING_FILE');assert.equal(proof.graph,'PASS');
});
