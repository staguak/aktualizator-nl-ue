import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {expandEuCaseScope,assertEuCaseCoverage,assertEuCaseSource,CASE_ROW_LIMIT,euCaseQuery} from './eu-case-scope.js';
import {checkCelex,discoverEuCaseDocuments} from './eu-provider.js';
import {assertEuSourceIdentity} from './eu-source-identity.js';
import {OfficialSources,loadSourceArchive} from './official-sources.js';
import type {EuDocument} from './eu-provider.js';
import type {CaseFetcher} from './eu-case-scope.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const localPython=root+'.venv/bin/python';
const python=process.env.LAW_XML_PYTHON??(fs.existsSync(localPython)?localPython:'python3');
const uri=(n:number)=>`http://publications.europa.eu/resource/cellar/00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const cdm='http://publications.europa.eu/ontology/cdm#';
const seed:EuDocument={celex:'62023CJ0019',include:'full-document',selectionInclude:'operative-part',role:'required-corpus-judgment',metadata:{work_date_document:['2025-11-11']}};
const graph=`@prefix cdm: <${cdm}> .
 <${uri(1)}> a cdm:case_court; cdm:dossier_identifier "C-19/23" .
 <${uri(2)}> a cdm:case_court; cdm:dossier_identifier "C-20/23" .
 <${uri(3)}> a cdm:case_court; cdm:dossier_identifier "C-19/24" .
 <${uri(11)}> cdm:resource_legal_id_celex "62023CJ0019"; cdm:work_date_document "2025-11-11";
   cdm:work_part_of_dossier <${uri(1)}>, <${uri(2)}>; cdm:work_cites_work <${uri(14)}> .
 <${uri(12)}> cdm:resource_legal_id_celex "62023CC0019"; cdm:work_date_document "2025-01-14"; cdm:work_part_of_dossier <${uri(1)}> .
 <${uri(13)}> cdm:resource_legal_id_celex "62023CO0020"; cdm:work_date_document "2025-01-15" .
 <${uri(2)}> cdm:dossier_contains_work <${uri(13)}> .
 <${uri(14)}> cdm:resource_legal_id_celex "62024CJ0019"; cdm:work_date_document "2025-01-01"; cdm:work_part_of_dossier <${uri(3)}> .
 <${uri(15)}> cdm:resource_legal_id_celex "62023CA0019"; cdm:work_date_document "2027-01-01"; cdm:work_part_of_dossier <${uri(1)}> .
 <${uri(16)}> cdm:resource_legal_id_celex "62023CJ0019_RES"; cdm:work_date_document "2025-11-11"; cdm:work_part_of_dossier <${uri(1)}> .
 <${uri(21)}> cdm:expression_belongs_to_work <${uri(11)}>; cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/ENG> .
 <${uri(22)}> cdm:expression_belongs_to_work <${uri(12)}>; cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/POL> .
 <${uri(23)}> cdm:expression_belongs_to_work <${uri(13)}>; cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/NLD> .
 <${uri(26)}> cdm:expression_belongs_to_work <${uri(16)}>; cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/DEU> .`;

function graphFetcher(turtle=graph):CaseFetcher{
  return async url=>{
    const query=new URL(url).searchParams.get('query');
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'case-query-test-'));
    const input=path.join(directory,'input.json');fs.writeFileSync(input,JSON.stringify({graph:turtle,query}));
    const descriptor=fs.openSync(input,'r');
    try{
    const result=spawnSync(python,['-c',
      'import json,sys\nfrom rdflib import Graph\np=json.load(sys.stdin)\ng=Graph().parse(data=p["graph"],format="turtle")\nsys.stdout.buffer.write(g.query(p["query"]).serialize(format="json"))'],
      {stdio:[descriptor,'pipe','pipe'],encoding:'utf8',timeout:20000,maxBuffer:1000000});
    assert.equal(result.status,0,result.stderr);
    return {url,bytes:Buffer.from(result.stdout),text:result.stdout,contentType:'application/sparql-results+json'};
    }finally{fs.closeSync(descriptor);fs.rmSync(directory,{recursive:true,force:true});}
  };
}
test('real SPARQL traversal expands formal and joined cases, without following citations or a reused case number',async()=>{
  const result=(await expandEuCaseScope([seed],'2026-11-13',graphFetcher()))!;
  assert.deepEqual(result.documents.map(d=>d.celex),['62023CC0019','62023CJ0019','62023CO0020']);
  assert.equal(result.documents.find(d=>d.celex===seed.celex)?.selectionInclude,'operative-part');
  assert(result.documents.every(d=>d.include==='full-document'));
  assert.deepEqual(new Set(result.catalog.members.map(m=>m.caseId)),new Set(['C-19/23','C-20/23']));
  assert(result.catalog.members.some(m=>m.celex==='62023CA0019'&&m.status==='AFTER_RANGE'));
  assert(result.catalog.members.some(m=>m.celex==='62023CJ0019_RES'&&m.status==='NO_SUPPORTED_LANGUAGE'));
  assert(!result.catalog.members.some(m=>m.celex==='62024CJ0019'));
  const expected={celex:seed.celex,retrievalScope:'full-act-and-case',requiredVersions:[seed.celex]};
  const act={...expected,documents:result.documents,caseCatalog:result.catalog};
  assertEuCaseCoverage(act,expected);
  assert.throws(()=>assertEuCaseCoverage({...act,documents:act.documents.filter(d=>d.celex!=='62023CC0019')},expected),/Missing complete/);
  assert.throws(()=>assertEuCaseCoverage({...act,documents:act.documents.map(d=>({...d,include:'operative-part'}))},expected),/fragment/);
  assert.throws(()=>assertEuCaseCoverage({...act,caseCatalog:undefined},expected),/catalog/);
});
test('case discovery preserves its original response inside the official archive',async()=>{
  const archive=new OfficialSources('EU',seed.celex,{from:'2025-01-01',to:'2026-11-13',observedOn:'2026-11-13'});
  const expanded=await discoverEuCaseDocuments([seed],'2026-11-13',archive,graphFetcher());
  assert(expanded?.documents.some(d=>d.celex==='62023CC0019'));
  const native=archive.build('01_case.sources.zip');
  const {index,items}=loadSourceArchive(native.bytes,native.metadata,'EU',seed.celex);
  assert.equal(index.entries[0].name,'case-discovery.json');
  assert.equal(index.entries[0].kind,'CELLAR-case-catalog');
  assertEuCaseSource({caseCatalog:expanded!.catalog},index,items,'2026-11-13');
  const changed=structuredClone(expanded!.catalog);
  changed.members.filter(m=>m.celex==='62023CC0019').forEach(m=>{m.status='NO_SUPPORTED_LANGUAGE';});
  assert.throws(()=>assertEuCaseSource({caseCatalog:changed},index,items,'2026-11-13'),/differs from its original/);
});
test('missing formal membership, malformed responses and a saturated query are rejected',async()=>{
  for(const data of [{results:{bindings:[]}}, {results:{}}, {results:{bindings:Array(CASE_ROW_LIMIT).fill({})}}]){
    let preserved=false;
    await assert.rejects(()=>expandEuCaseScope([seed],'2026-11-13',async url=>{
      const text=JSON.stringify(data);return {text,bytes:Buffer.from(text),url,contentType:'application/json'};
    },()=>{preserved=true;}),/catalog|membership/);
    assert(preserved,'Rejected discovery must keep the actual response for diagnostics.');
  }
});
test('a member lacking CELEX is explicit and cannot pass whole-case coverage',async()=>{
  const result=(await expandEuCaseScope([seed],'2026-11-13',graphFetcher(graph+`\n<${uri(30)}> cdm:work_part_of_dossier <${uri(1)}> .`)))!;
  assert(result.catalog.members.some(m=>m.work===uri(30).replace('http:','https:')&&m.status==='NO_CELEX'));
  assert.throws(()=>assertEuCaseCoverage({celex:seed.celex,retrievalScope:'full-act-and-case',documents:result.documents,caseCatalog:result.catalog},
    {celex:seed.celex,retrievalScope:'full-act-and-case'}),/Unresolved/);
});
test('ordinary acts do not trigger a case search and source identity supports case opinions/notices/summaries',async()=>{
  assert.equal(await expandEuCaseScope([{...seed,celex:'32022L2041'}],'2026-11-13',async()=>{throw new Error('Unexpected network');}),undefined);
  for(const id of ['62023CC0019','62021CN0311','62020CJ0426_SUM','62023CO0020','62023CJ0019_RES']){
    checkCelex(id);
    assertEuSourceIdentity(`<html><head><title>EUR-Lex - ${id} - EN</title></head><body>Original</body></html>`,
      `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:${id}`,id);
  }
  assert.throws(()=>euCaseQuery(['62023CJ0019" } UNION { ?x ?y ?z } #']));
});
