import test from 'node:test';
import assert from 'node:assert/strict';
import {LEGAL_PROFILE,legalIdentity,unitStart,unitEnd,indexLegalDocument,validateLegalDocument,planLegalChunks,legalPartName,legalMarkdown,extractLegalBody} from './legal-structure.js';
import type {LegalContext,LegalDraft,LegalUnit} from './legal-structure.js';
const context:LegalContext={corpus:'NL',documentId:'BWBR0000001',version:'2025-01-01',language:'NL',sourceUrl:'https://official.example/act',sourceSha256:'a'.repeat(64)};
function fixture(version=context.version){
  const scope={...context,version};
  const root:LegalUnit={...legalIdentity(scope,'/act[1]','version'),parentId:null,kind:'version',label:'Act',order:1,sourceLocator:'/act[1]',sourceTag:'act',attributes:{},officialIdentifiers:[]};
  const article:LegalUnit={...legalIdentity(scope,'/act[1]/article[1]','article'),parentId:root.id,kind:'article',label:'Article 1',order:2,sourceLocator:'/act[1]/article[1]',sourceTag:'article',attributes:{},officialIdentifiers:[]};
  const marker=(u:LegalUnit,text:string)=>unitStart(u.anchor)+`<a id="${u.anchor}"></a>`+text+unitEnd(u.anchor);
  const body=marker(root,marker(article,'<p>Complete legal text.</p>'));
  const draft:LegalDraft={...scope,profile:LEGAL_PROFILE,units:[root,article],chunks:[{key:'article-one',body,technicalSplit:false}]};
  return {draft,body};
}
test('a version is reconstructed exactly and a logical unit is independent of its physical file',()=>{
  const {draft,body}=fixture();
  const first=indexLegalDocument(draft,['chapter.md'],[body]),renamed=indexLegalDocument(draft,['renamed.md'],[body]);
  assert.equal(validateLegalDocument(first,()=>body),body);
  assert.equal(first.units[1].id,renamed.units[1].id);assert.notDeepEqual(first.units[1].locations,renamed.units[1].locations);
  assert.equal(extractLegalBody(legalMarkdown('Act',context,body,['Act','Article 1'])),body);
  const historical=fixture('2024-01-01');
  assert.notEqual(historical.draft.units[1].id,draft.units[1].id);
  assert.equal(historical.draft.units[1].anchor,draft.units[1].anchor,'Physical aliases can share identical content without collapsing logical versions.');
});
test('natural groups determine parts regardless of the former character targets',()=>{
  const first='A'.repeat(700000),second='B'.repeat(100);
  const chunks=planLegalChunks(first+second,[{start:0,key:'chapter-one'},{start:first.length,key:'annex-one'}],[]);
  assert.deepEqual(chunks.map(p=>p.body),[first,second]);
  assert(chunks.every(p=>!p.technicalSplit));
  assert.equal(legalPartName('NL_act_v1',chunks[1]),legalPartName('NL_act_v1',{...chunks[1],body:'different length'}));
});
test('technical exceptions use supplied internal boundaries and never truncate an indivisible table',()=>{
  const body='article-one'.repeat(10);
  const chunks=planLegalChunks(body,[{start:0,key:'article'}],[22,44,66,88],25);
  assert.equal(chunks.map(p=>p.body).join(''),body);assert(chunks.every(p=>p.technicalSplit));
  assert.throws(()=>planLegalChunks(body,[{start:0,key:'table'}],[],25),/safe internal/);
});
test('missing, duplicated, reordered or misattributed units and altered ranges are rejected',()=>{
  const {draft,body}=fixture();const manifest=indexLegalDocument(draft,['act.md'],[body]);
  assert.throws(()=>validateLegalDocument(manifest,()=>body.replace('Complete','Incomplete')),/part changed/);
  assert.throws(()=>indexLegalDocument({...draft,units:[...draft.units,draft.units[1]]},['act.md'],[body]),/identity|order/);
  assert.throws(()=>indexLegalDocument({...draft,units:[draft.units[0]]},['act.md'],[body]),/Unindexed/);
  const cycle=structuredClone(draft);cycle.units[1].parentId=cycle.units[1].id;
  assert.throws(()=>indexLegalDocument(cycle,['act.md'],[body]),/hierarchy/);
  const wrongVersion={...manifest,version:'2024-01-01'};assert.throws(()=>validateLegalDocument(wrongVersion,()=>body),/identity/);
  const badRange=structuredClone(manifest);badRange.units[1].start++;
  assert.throws(()=>validateLegalDocument(badRange,()=>body),/index differs/);
});
