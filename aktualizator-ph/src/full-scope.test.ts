import test from 'node:test';
import assert from 'node:assert/strict';
import {buildNlModel} from './nl-model.js';
import {renderNlModel} from './render.js';
import {parseNlFinal} from './nl-final-parser.js';
import {discoverEuDocuments} from './eu-provider.js';
import type {ScopeAct,VersionSnapshot} from './types.js';
import type {EuAct} from './eu-provider.js';
import {assertFullNlSourceCoverage} from './nl-retrieval-scope.js';
import {nlActManifest} from './nl-output.js';
import {parseBwbXml} from './bwb-parser.js';

const act:ScopeAct & {retrievalScope:'full-act'}={order:1,title:'Whole act',bwbId:'BWBR0000001',
  include:{articles:['1'],structures:['hoofdstuk:1']},mustIncludeArticles:['1'],retrievalScope:'full-act'};
function snapshot(key:string,from:string,to:string|null,articles:string[]):VersionSnapshot{
  return {version:{key,validFrom:from,validTo:to,toestandUrl:`https://official.example/${key}`},statute:{
    bwbId:act.bwbId,title:act.title,provisions:articles.map(article=>({article,provisionRef:article,
      structurePath:article==='1'?'hoofdstuk:1':'hoofdstuk:2',content:`Complete provision ${article} from ${key}.`}))}};
}
test('NL selection of one article retrieves every article in the selected historical states',()=>{
  const sources=[snapshot('old','2024-01-01','2025-05-31',['1','2']),snapshot('new','2025-06-01',null,['1','2','3'])];
  const model=buildNlModel(act,sources,'2025-01-01','2026-11-13');
  assert.deepEqual(model.selectedArticles,['1','2','3']);
  assert.deepEqual(model.act.include,act.include);
  const restored=renderNlModel(model).chunks.flatMap(part=>parseNlFinal(part.content));
  assert.deepEqual(restored.map(a=>a.articleId),['1','2','3']);
  assert.deepEqual(restored[1].versions.map(v=>v.content),['Complete provision 2 from old.','Complete provision 2 from new.']);
  assert.equal(model.missingArticles.length,0);
});
test('NL full retrieval retains the configured selector checks and leaves legacy scope unchanged',()=>{
  const sources=[snapshot('new','2025-01-01',null,['1','2'])];
  assert.deepEqual(buildNlModel({...act,retrievalScope:undefined},sources,'2025-01-01','2026-11-13').selectedArticles,['1']);
  assert.deepEqual(buildNlModel({...act,include:{articles:['99']}},sources,'2025-01-01','2026-11-13').missingArticles,['99']);
});
test('full NL retrieval preserves distinct book references and refuses ambiguous source identities',()=>{
  const source=snapshot('new','2025-01-01',null,['1','1']);
  source.statute.provisions[0].provisionRef='1:1';source.statute.provisions[1].provisionRef='2:1';
  const model=buildNlModel({...act,include:{articles:['1:1']},mustIncludeArticles:['1:1']},[source],'2025-01-01','2026-11-13');
  assert.deepEqual(model.selectedArticles,['1:1','2:1']);
  source.statute.provisions[1].provisionRef='1:1';
  assert.throws(()=>buildNlModel(act,[source],'2025-01-01','2026-11-13'),/Ambiguous/);
});
test('independent full NL source coverage rejects a lost article even if remaining hashes are consistent',()=>{
  const xml=`<toestand bwb-id="${act.bwbId}"><wetgeving><intitule>Whole act</intitule><wettekst>
    <artikel nr="1"><al>First article.</al></artikel><artikel nr="2"><al>Additional article.</al></artikel>
    </wettekst></wetgeving></toestand>`;
  const source=snapshot('new','2025-01-01',null,[]);source.statute=parseBwbXml(xml);
  const configured={...act,include:{articles:['1']}};
  const rendered=renderNlModel(buildNlModel(configured,[source],'2025-01-01','2026-11-13'));
  const manifest=nlActManifest(rendered,1);
  const index={entries:[{name:'state.xml',kind:'BWB-Toestand',metadata:{version:source.version}}]};
  const items={'state.xml':Buffer.from(xml)};
  assertFullNlSourceCoverage(manifest,index,items,'2025-01-01','2026-11-13');
  const reduced=nlActManifest(renderNlModel(buildNlModel({...configured,retrievalScope:undefined},[source],'2025-01-01','2026-11-13')),1);
  assert.throws(()=>assertFullNlSourceCoverage({...reduced,retrievalScope:'full-act'},index,items,'2025-01-01','2026-11-13'),/coverage/);
});
test('a configured EU operative-part hit becomes a full document while retaining its selection reason',async()=>{
  const scope:EuAct & {retrievalScope:'full-act-and-case'}={order:1,title:'Directive',celex:'32022L2041',
    include:'full-document',requiredVersions:['32022L2041'],retrievalScope:'full-act-and-case',
    attachedDocuments:[{celex:'62023CJ0019',include:'operative-part'}]};
  const result=await discoverEuDocuments(scope,undefined,async url=>{
    const text=JSON.stringify({results:{bindings:[{id:{value:scope.celex},
      p:{value:'http://publications.europa.eu/ontology/cdm#work_date_document'},v:{value:'2022-10-19'}}]}});
    return {bytes:Buffer.from(text),text,url,contentType:'application/sparql-results+json'};
  });
  assert.equal(result.find(d=>d.celex==='62023CJ0019')?.include,'full-document');
  assert.equal((result.find(d=>d.celex==='62023CJ0019') as any)?.selectionInclude,'operative-part');
});
