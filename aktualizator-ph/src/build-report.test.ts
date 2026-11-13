import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReport,renderBuildReport} from './build-report.js';
import {sourceStructure} from './source-structure.js';
import {newContext} from './release-engine.js';
import {pendingValidation} from './validation-result.js';
import {operationMetrics} from './operation-metrics.js';

function eu(){return {jurisdiction:'EU',rangeFrom:'2025-01-01',rangeTo:'2026-10-20',generatedAt:'time1',language:'EN',
  normalization:{languageSets:{L01:['ENG']},languageAuthorityBase:'http://example.org/'},
  acts:[{celex:'32003L0088',documents:[{celex:'32003L0088',inputBodyHash:'original',sourceUrl:'https://example.org/a',
    metadata:{available_language_ref:'L01'}}]}]};}
test('build report uses measured cache/checkpoint work without claiming publication or complete discovery',()=>{
  const before=operationMetrics.snapshot().counters;
  operationMetrics.add('parserCacheHits',2);operationMetrics.add('actsCheckpointReused',1);
  const report=buildReport(eu(),null,pendingValidation(),{});
  assert.equal(report.reuse.verifiedParserCacheHits,before.parserCacheHits+2);
  assert.equal(report.reuse.verifiedCheckpointActs,before.actsCheckpointReused+1);
  assert.equal(report.reuse.status,'MEASURED_BUILD_PHASE');assert.match(report.reuse.scope,/not evidence of a complete source review/);
  assert.equal(report.publication.status,'NOT_COMMITTED_BY_BUILD');
});
test('report compares expanded source metadata, not language dictionary numbering or run time',()=>{
  const before=eu(),after=eu();after.generatedAt='time2';after.normalization.languageSets={L02:['ENG']} as any;
  after.acts[0].documents[0].metadata.available_language_ref='L02';
  const report=buildReport(after,before,pendingValidation(),{});
  assert.deepEqual(report.comparison.documents,{newDocuments:0,changedTextDocuments:0,metadataOnlyDocuments:0,absentDocuments:0,unchangedDocuments:1});
  after.acts[0].documents[0].sourceUrl='https://example.org/corrected';
  assert.equal(buildReport(after,before,pendingValidation(),{}).comparison.documents?.metadataOnlyDocuments,1);
  after.acts[0].documents[0].inputBodyHash='corrected';
  const changes=buildReport(after,before,pendingValidation(),{}).comparison.documents!;
  assert.equal(changes.changedTextDocuments,1);assert.equal(changes.metadataOnlyDocuments,0);
});
test('report preserves explicit technical identities, validates frozen bounds, never claims a commit',()=>{
  const manifest=eu(),context=newContext({mode:'update',baseId:'base',parentReleaseId:'parent',
    configSha256:'a'.repeat(64),codeRevision:'test',rangeFrom:manifest.rangeFrom,rangeTo:manifest.rangeTo,observedOn:manifest.rangeTo});
  Object.assign(manifest,{officialSources:{observedOn:context.observedOn}});
  const env={LAW_RELEASE_CONTEXT:JSON.stringify(context)};
  const report=buildReport(manifest,eu(),pendingValidation(),env);
  assert.equal(report.identity.releaseId,context.releaseId);
  assert.equal(report.comparison.baseline,'LAST_PREFLIGHTED_RELEASE');
  assert.equal(report.publication.status,'NOT_COMMITTED_BY_BUILD');assert.equal(report.backup.status,'NOT_CONFIRMED_BY_BUILD');
  assert.equal(report.criticalErrors,null);assert.equal(report.publication.commitEvidence,`checks/commits/${context.runId}.json`);
  assert.throws(()=>buildReport({...manifest,rangeTo:'2026-10-19'},null,pendingValidation(),env),/context mismatch/);
  assert.equal(buildReport(manifest,null,pendingValidation(),{}).identity.releaseId,null);
});
test('NL selected-article comparisons distinguish absence and text-version sets without inventing repeal',()=>{
  const before={jurisdiction:'NL',rangeFrom:'2025-01-01',rangeTo:'2026-10-20',acts:[{bwbId:'BWBR1',
    sourceStates:[{index:0,key:'state'}],articles:[{articleId:'1',versions:[{sourceStates:[0],contentHash:'old'}]},
      {articleId:'2',versions:[{sourceStates:[0],contentHash:'retained'}]}]}]};
  const after=structuredClone(before);after.acts[0].articles.pop();after.acts[0].articles[0].versions[0].contentHash='new';
  const report=buildReport(after,before,pendingValidation(),{});
  assert.deepEqual(report.comparison.selectedNlArticles,{added:0,changedTextVersionSequences:1,absent:1});
  assert.match(report.scope,/no inferred legal/);assert.match(report.comparison.nestedUnitDelta,/Only proven official identity scopes/);
  assert.equal(report.comparison.sourceUnits[0].status,'NO_COMPARABLE_PREDECESSOR_EVIDENCE');
});
test('source structure counts observations and own corrections without treating RDF as alternate text',()=>{
  const counts=sourceStructure({entries:[
    {kind:'CELLAR-WEMI-index',metadata:{celex:'A'}},
    {kind:'CELLAR-XHTML',metadata:{celex:'A'}},
    {kind:'CELLAR-Formex4',metadata:{celex:'A',unitHistory:[{root:'CORR',units:[1,2],corrections:[1]}]}},
    {kind:'BWB-Toestand',metadata:{units:[1,2,3],unitCorrections:[1,2]}},
  ]});
  assert.deepEqual(counts,{snapshots:2,unitObservations:5,editorialCorrections:3,corrigendumSnapshots:1,alternateRepresentations:1});
});
test('report source warnings cannot close the JSON fence',()=>{
  const manifest=eu();Object.assign(manifest.acts[0],{sourceArchive:{entryCount:1,warnings:['```\nforeign section']}});
  const text=renderBuildReport(manifest,null,pendingValidation());
  assert.equal(text.match(/^```/gm)?.length,2);
  const data=JSON.parse(text.split('```json\n')[1].split('\n```')[0]);
  assert.equal(data.warnings.messages[0],'```\nforeign section');
});
