import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {OfficialSources} from './official-sources.js';
import {EU_LANGUAGE_ORDER} from './eu-language.js';
import {finalizeEu,euIndex,euReport} from './eu-output.js';
import {writeCorpusManifest} from './legal-manifest-files.js';
import {completeBuiltOutput} from './publication-validation.js';
import {missingEuDocuments} from './eu-unavailable.js';
import type {MissingEuDocument} from './eu-unavailable.js';
import type {EuBuiltAct} from './eu-model.js';
import {discoverEuDocuments,selectEuDocuments,discoverEuCaseDocuments,EU_DISCOVERY_FALLBACK_ROLE,fetchEuText,EuDocumentUnavailable} from './eu-provider.js';
import {assertMissingEuEvidence} from './eu-unavailable.js';
import {loadSourceArchive} from './official-sources.js';
import {SourceHttpError} from './source-cache.js';
import {readEuCheckpointFiles,reusableEuCheckpointActs} from './eu-checkpoint.js';

test('an exhausted document creates an explicit notice and validated partial output instead of a link or invented text',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'missing-eu-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const id='32024R0001',url='https://publications.europa.eu/resource/celex/'+id;
  const missing:MissingEuDocument={profile:'eu-document-unavailable-v1',celex:id,document:{celex:id,include:'full-document',role:'original',metadata:{}},attempts:EU_LANGUAGE_ORDER.map(language=>({language,reason:'No complete validated official source.'}))};
  const archive=new OfficialSources('EU',id,{from:'2024-01-01',to:'2026-11-15',observedOn:'2026-11-15'});
  archive.add('unavailable/document.json',{bytes:Buffer.from(JSON.stringify(missing)),url,contentType:'application/json'},url,'CELLAR-document-unavailable',{celex:id});
  archive.warning('Required source unavailable.',{classification:'SOURCE_UNAVAILABLE',code:'DOCUMENT_UNAVAILABLE',documentId:id});
  const native=archive.build('01_32024R0001.sources.zip');fs.writeFileSync(path.join(dir,native.metadata.name),native.bytes);
  const act:EuBuiltAct={order:1,title:'Act',celex:id,documents:[],files:[],excludedDocuments:[],missingDocuments:[missing],sourceArchive:native.metadata};
  const checkpoint=readEuCheckpointFiles(dir,[act],[{order:1,title:'Act',celex:id,requiredVersions:[id],attachedDocuments:[],include:'full-document'}]);
  assert.deepEqual(checkpoint.get(native.metadata.name),native.bytes);
  assert.deepEqual(reusableEuCheckpointActs([act]),[],'A validated partial attempt must be retried on resume');
  const result=finalizeEu([act],()=>{throw new Error('No source text exists');});
  assert.equal(result.files.size,1);assert.match([...result.outputs.values()][0],/DOKUMENT NIEDOSTĘPNY/);
  const manifest={schemaVersion:2,validationVersion:2,jurisdiction:'EU',rangeFrom:'2024-01-01',rangeTo:'2026-11-15',generatedAt:'2026-11-15',language:'EN',officialSources:{originalBytes:true},acts:result.acts,normalization:result.normalization};
  for(const f of result.files.values())fs.writeFileSync(path.join(dir,f.name),f.content);
  writeCorpusManifest(dir,manifest);fs.writeFileSync(path.join(dir,'INDEX.md'),euIndex(manifest));
  completeBuiltOutput(dir,[{order:1,celex:id,requiredVersions:[id]}],r=>euReport(manifest,null,r));
  assert.match(fs.readFileSync(path.join(dir,'REPORT.md'),'utf8'),/Kompletność: NIEPEŁNA/);
  const previous=process.env.LAW_SOURCE_AUDIT;
  try{process.env.LAW_SOURCE_AUDIT='unconditional';completeBuiltOutput(dir,[{order:1,celex:id,requiredVersions:[id]}],r=>euReport(manifest,null,r));}
  finally{if(previous===undefined)delete process.env.LAW_SOURCE_AUDIT;else process.env.LAW_SOURCE_AUDIT=previous;}
  const changed=structuredClone(act);changed.missingDocuments![0].attempts.pop();
  assert.throws(()=>missingEuDocuments(changed),/Unproven/);
});
test('a case-catalog transport failure retains a partial-discovery proof and permits the selected document processing',async()=>{
  const id='62023CJ0019',archive=new OfficialSources('EU',id,{from:'2025-01-01',to:'2026-11-15',observedOn:'2026-11-15'});
  const result=await discoverEuCaseDocuments([{celex:id,include:'full-document',role:'original',metadata:{}}],'2026-11-15',archive,async()=>{throw new SourceHttpError(503);});
  assert.equal(result,undefined);
  const native=archive.build('01_case.sources.zip'),original=loadSourceArchive(native.bytes,native.metadata,'EU',id);
  assertMissingEuEvidence({documents:[],discoveryIncomplete:true},original.index,original.items);
});
test('empty or unavailable primary catalogs still select configured documents for all-language retrieval with retained incomplete-discovery proof',async()=>{
  const scope={order:1,title:'Act',celex:'32024R0001',include:'full-document' as const,requiredVersions:['02024R0001-20250101'],attachedDocuments:[]};
  for(const mode of ['empty','http-error']){
    const archive=new OfficialSources('EU',scope.celex,{from:'2025-01-01',to:'2026-11-15',observedOn:'2026-11-15'});
    const docs=await discoverEuDocuments(scope,archive,async url=>{
      if(mode==='http-error')throw new SourceHttpError(503);
      const text=JSON.stringify({results:{bindings:[]}});return {url,text,bytes:Buffer.from(text),contentType:'application/json'};
    });
    assert(docs.every(d=>d.role===EU_DISCOVERY_FALLBACK_ROLE));
    assert.equal(selectEuDocuments(docs,scope,'2025-01-01','2026-11-15','preferred').length,2);
    const native=archive.build('01_act.sources.zip'),original=loadSourceArchive(native.bytes,native.metadata,'EU',scope.celex);
    const act={documents:[],missingDocuments:[],discoveryIncomplete:true};
    assert.deepEqual(reusableEuCheckpointActs([act]),[],'Unavailable discovery must not be frozen as a complete checkpoint');
    assertMissingEuEvidence(act,original.index,original.items);
    assert.throws(()=>assertMissingEuEvidence({...act,discoveryIncomplete:false},original.index,original.items),/omitted/);
  }
});

test('a downloaded but rejected XHTML is not an absent document',async()=>{
  const invalid=Buffer.from('<html lang="en"><body>Access Denied</body></html>');
  const empty=Buffer.from(JSON.stringify({results:{bindings:[]}}));
  const fetcher=async(url:string)=>{
    const bytes=url.includes('/webapi/rdf/sparql')?empty:invalid;
    return {url,bytes,text:bytes.toString(),contentType:url.includes('/webapi/rdf/sparql')?'application/json':'text/html'};
  };
  const document={celex:'32024R0001',role:'original',include:'full-document',metadata:{}};
  await assert.rejects(fetchEuText(document,'EN',fetcher),error=>{
    assert(!(error instanceof EuDocumentUnavailable),'A rejected HTTP-200 source is not a missing official document');
    return true;
  });
});
