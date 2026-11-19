import assert from 'node:assert/strict';
import test from 'node:test';
import type {EuDocument} from './eu-provider.js';
import {runPublicBuildPhases} from './public-build-phases.js';
import {publicEuLanguages,unsupportedEuLanguages} from './eu-language.js';
import {territorialApplicability,assessPublicEuDocument,territorialObservation} from './eu-applicability.js';
import {officialDateObservation} from './eu-dates.js';

test('public bootstrap verifies the baseline before update; an existing base runs only update',async()=>{
  const calls:string[]=[];
  const build=async(phase:string,date:string)=>{calls.push(phase+':'+date);return date;};
  const dates=['2025-01-01','2026-11-19'] as const;
  assert.deepEqual(await runPublicBuildPhases(true,...dates,build),{base:dates[0],update:dates[1]});
  assert.deepEqual(calls,['BASE:2025-01-01','UPDATE:2026-11-19']);
  calls.length=0;
  assert.deepEqual(await runPublicBuildPhases(false,...dates,build),{update:dates[1]});
  assert.deepEqual(calls,['UPDATE:2026-11-19']);
  await assert.rejects(runPublicBuildPhases(true,dates[0],dates[0],build),/later/);
  await assert.rejects(runPublicBuildPhases(true,...dates,async phase=>{
    if(phase==='UPDATE')throw new Error('second phase failed');
    return 'verified base';
  }),/second phase failed/);
});

test('the language policy derives its order from active country modules and requires official proof for a skip',()=>{
  const base='http://publications.europa.eu/resource/authority/language/';
  assert.deepEqual(publicEuLanguages([]),['EN','FR']);
  assert.deepEqual(publicEuLanguages(['NL']),['EN','FR','NL']);
  assert.equal(unsupportedEuLanguages([base+'RON'],publicEuLanguages(['NL'])),true);
  assert.equal(unsupportedEuLanguages([base+'RON',base+'ENG'],publicEuLanguages(['NL'])),false);
  assert.equal(unsupportedEuLanguages([],publicEuLanguages(['NL'])),false);
  assert.equal(unsupportedEuLanguages(['https://example.org/RON'],publicEuLanguages(['NL'])),false);
});

test('territorial coverage requires a source and a locator and is independent of language',()=>{
  const evidence={source:'https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=CELEX:32026D1108',locator:'Article establishing addressees'};
  assert.equal(territorialApplicability(['NL']).status,'APPLICABILITY_UNKNOWN');
  assert.equal(territorialApplicability([],{...evidence,scope:'UNION'}).status,'APPLICABILITY_CONFIRMED');
  assert.equal(territorialApplicability(['NL'],{...evidence,scope:'COUNTRIES',countries:['RO']}).status,'APPLICABILITY_EXCLUDED');
  assert.equal(territorialApplicability(['NL'],{...evidence,scope:'COUNTRIES',countries:['RO','NL']}).status,'APPLICABILITY_CONFIRMED');
});

test('CELLAR addressees distinguish a Dutch decision from a foreign addressee with unresolved effects',()=>{
  const uri='http://publications.europa.eu/resource/authority/fd_050/';
  const predicate='http://publications.europa.eu/ontology/cdm#resource_legal_addresses_institution';
  const row=(country:string)=>territorialObservation(predicate,uri+country,
    'https://publications.europa.eu/webapi/rdf/sparql','a'.repeat(64))!;
  assert.equal(assessPublicEuDocument('32026D1108',['NL'],[row('RO')]).status,'APPLICABILITY_UNKNOWN');
  assert.equal(assessPublicEuDocument('32025D2591',['NL'],[row('PL'),row('RO')]).status,'APPLICABILITY_UNKNOWN');
  const included=assessPublicEuDocument('32025D2591',['NL'],[row('RO'),row('NL')]);
  assert.equal(included.status,'APPLICABILITY_CONFIRMED');
  assert.equal(included.unitApplicability,'APPLICABILITY_UNKNOWN');
  assert.equal(assessPublicEuDocument('32025D2591',[],[row('NL')]).status,'APPLICABILITY_UNKNOWN');
});

test('official notification date retains its predicate and literal type without inventing an adoption date',()=>{
  const predicate='http://publications.europa.eu/ontology/cdm#resource_legal_date_notification';
  const value={value:'2025-02-03',type:'typed-literal',datatype:'http://www.w3.org/2001/XMLSchema#date'};
  const result=officialDateObservation(predicate,value,{celex:'32025D2591'},'https://publications.europa.eu/webapi/rdf/sparql','a'.repeat(64));
  assert.equal(result?.predicate,predicate);
  assert.equal(result?.originalValue,value.value);
  assert.equal(result?.datatype,value.datatype);
  assert.equal(result?.normalizedValue,value.value);
  assert.equal(Object.hasOwn(result??{},'adoptionDate'),false);
});


test('public selection retains the configured original alongside the older and new consolidations',async()=>{
  const {selectEuDocuments}=await import('./eu-provider.js');
  const celex='32006L0054';
  const act={order:1,title:'Directive',celex,include:'full-document' as const,requiredVersions:[],attachedDocuments:[]};
  const documents:EuDocument[]=[
    {celex,metadata:{work_date_document:['2006-07-05']},role:'original',include:'full-document'},
    {celex:'02006L0054-20060726',metadata:{},role:'consolidated',include:'full-document'},
    {celex:'02006L0054-20260619',metadata:{},role:'consolidated',include:'full-document'},
  ];
  process.env.LAW_PUBLIC_EU_MODULES='NL';
  try{
    const ids=(to:string)=>selectEuDocuments(documents,act,'2025-01-01',to,'preferred').map(doc=>doc.celex);
    assert.deepEqual(ids('2026-06-18'),['02006L0054-20060726',celex]);
    assert.deepEqual(ids('2026-06-19'),['02006L0054-20060726','02006L0054-20260619',celex]);
  }finally{delete process.env.LAW_PUBLIC_EU_MODULES;}
});
