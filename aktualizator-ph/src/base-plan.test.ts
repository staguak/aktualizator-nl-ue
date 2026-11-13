import test from 'node:test';import assert from 'node:assert/strict';
import {baselineEuAct,baselineNlScope,baselineNlUnits} from './base-plan.js';
import type {EuAct,EuDocument} from './eu-provider.js';
const act:EuAct={celex:'32024R1689',order:1,title:'test',include:'full-document',requiredVersions:['32024R1689','02024R1689-20260727'],attachedDocuments:[]};
const docs:EuDocument[]=[{celex:act.celex,role:'original',include:'full-document',metadata:{work_date_document:['2024-06-13']}},
  {celex:'02024R1689-20260727',role:'consolidated',include:'full-document',metadata:{}}];
test('base excludes future required consolidation while full configured scope remains unchanged',()=>{
  const result=baselineEuAct(act,docs,'2025-01-01');assert.deepEqual(result.act!.requiredVersions,['32024R1689']);
  assert.deepEqual(result.excluded,['02024R1689-20260727']);assert.equal(act.requiredVersions.length,2);
});
test('later original is absent from documentary base; no status of repeal inferred',()=>{
  const result=baselineEuAct({...act,celex:'32025L2450'},[{celex:'32025L2450',role:'original',include:'full-document',metadata:{work_date_document:['2025-11-26']}}],'2025-01-01');
  assert.equal(result.act,null);
});
test('undated base evidence fails closed',()=>assert.throws(()=>baselineEuAct(act,[],'2025-01-01'),/evidence/));
test('a later requested article is explicitly omitted only from source-confirmed initial scope',()=>{
  const act={bwbId:'BWBR0002638',order:1,title:'minimum wage',include:{articles:['6','6a']},mustIncludeArticles:['6','6a']};
  const result=baselineNlUnits(act,[{bwbId:act.bwbId,title:'minimum wage',provisions:[{article:'6',provisionRef:'art6',content:'official text',structurePath:'wet'}]}]);
  assert.deepEqual(result.act.include.articles,['6']);assert.deepEqual(result.evidence.missing,['6a']);
  assert.deepEqual(act.include.articles,['6','6a']);assert.throws(()=>baselineNlUnits(act,[]));
});
test('BWB baseline keeps official intervals and rejects ambiguous overlap',()=>{
  const c={schemaVersion:1,source:{title:'test',derivedAt:'2026-10-11'},acts:[{order:1,title:'test',bwbId:'BWBR001',include:{articles:['1']},mustIncludeArticles:[]}]};
  const v={key:'a',toestandUrl:'https://example.invalid/a',validFrom:'2024-01-01',validTo:null};
  assert.equal(baselineNlScope(c,new Map([['BWBR001',[v]]]),'2025-01-01','2026-10-11').config.acts.length,1);
  assert.throws(()=>baselineNlScope(c,new Map([['BWBR001',[v,{...v,key:'b'}]]]),'2025-01-01','2026-10-11'),/overlapping/);
});
test('an incomplete BWB catalog cannot silently remove a configured act from immutable base',()=>{
  const act={order:1,title:'required',bwbId:'BWBR0009616',include:{articles:['1']},mustIncludeArticles:['1']};
  const scope={schemaVersion:1,source:{title:'test',derivedAt:'2026-10-18'},acts:[act,{...act,order:2,bwbId:'BWBR0002471'}]};
  const known={key:'known',toestandUrl:'https://official.example/known',validFrom:'2025-01-01',validTo:null};
  for(const absent of [{...known,validTo:'2024-12-31',validFrom:'2024-01-01'},
    {...known,validFrom:'2027-01-01'},{...known,visibleTo:'2025-01-01'}]){
    assert.throws(()=>baselineNlScope(scope,new Map([[act.bwbId,[known]],['BWBR0002471',[absent]]]),'2025-01-01','2026-10-18'),/cannot narrow/);
    assert.equal(scope.acts.length,2);
  }
});
