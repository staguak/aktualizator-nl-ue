import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {OfficialSources,loadSourceArchive} from './official-sources.js';
import {SOURCE_CLASSES,validateSourceIssues,sourceAvailability,sourceFindingCounts} from './source-availability.js';
import {loadValidatedFiles} from './validation-context.js';
import {stableJson,fileMetadata} from './output.js';
import {buildReport} from './build-report.js';
import {pendingValidation} from './validation-result.js';

function archive(){
  const a=new OfficialSources('EU','32003L0088',{from:'2025-01-01',to:'2026-10-20',observedOn:'2026-10-20'});
  a.add('text.xhtml',{bytes:Buffer.from('<html>Official</html>'),url:'https://example.org/text',contentType:'application/xhtml+xml'},
    'https://example.org/text','CELLAR-XHTML',{celex:'32003L0088',language:'EN'});return a;
}
test('successful official search without an optional representation is an observed absence, not an inaccessible source',()=>{
  const a=archive();a.warning('No indexed optional representation',{classification:'NOT_OBSERVED',code:'FORMEX_NOT_PUBLISHED',representation:'Formex',documentId:a.identifier});
  const built=a.build('01_32003L0088.sources.zip'),assessment=sourceAvailability(loadSourceArchive(built.bytes,built.metadata,'EU',a.identifier).index);
  const report=buildReport({jurisdiction:'EU',rangeFrom:'2025-01-01',rangeTo:'2026-10-20',acts:[]},null,
    {...pendingValidation(),status:'PASS',sourceAvailability:[assessment]},{});
  assert.equal(report.sourceAvailability?.[0].content,'COMPLETE');
  assert.equal(assessment.issues[0].classification,'NOT_OBSERVED');
});
test('typed issues distinguish unavailable Formex and incomplete metadata while preserving required text fallback',()=>{
  assert.deepEqual(SOURCE_CLASSES,['COMPLETE','COMPLETE_FALLBACK','METADATA_INCOMPLETE','HISTORY_INCOMPLETE','SOURCE_UNAVAILABLE','CRITICAL','NOT_OBSERVED','REPRESENTATION_REJECTED']);
  const a=archive();a.warning('No Formex',{classification:'SOURCE_UNAVAILABLE',code:'FORMEX_NOT_PUBLISHED',representation:'Formex',documentId:a.identifier});
  a.warning('No complete RDF tree',{classification:'METADATA_INCOMPLETE',code:'RDF_NOTICE_FALLBACK',representation:'RDF',documentId:a.identifier});
  const built=a.build('01_32003L0088.sources.zip'),loaded=loadSourceArchive(built.bytes,built.metadata,'EU',a.identifier);
  const assessment=sourceAvailability(loaded.index);assert(assessment.hasOfficialTextFallback);
  assert.equal(assessment.issues.length,2);assert.deepEqual(assessment.legacyWarnings,[]);
  const empty={jurisdiction:'EU',rangeFrom:'2025-01-01',rangeTo:'2026-10-20',acts:[]};
  const report=buildReport(empty,null,{...pendingValidation(),status:'PASS',sourceAvailability:[assessment]},{});
  assert.equal(report.sourceAvailability?.[0].content,'COMPLETE_FALLBACK');
  assert.equal(report.sourceAvailability?.[0].issues.find(i=>i.code==='FORMEX_NOT_PUBLISHED')?.classification,'SOURCE_UNAVAILABLE');
  loaded.index.entries[0].metadata.language='FRA';
  const wrongLanguage=sourceAvailability(loaded.index);assert(!wrongLanguage.hasOfficialTextFallback);
  assert.equal(buildReport(empty,null,{...pendingValidation(),status:'PASS',sourceAvailability:[wrongLanguage]},{}).sourceAvailability?.[0].content,'VALIDATED_CONTENT_ONLY');
});
test('unknown profiles/classes, orphaned warnings, foreign document IDs and injected issue fields fail closed',()=>{
  const issue={classification:'METADATA_INCOMPLETE',code:'MISSING_METADATA',message:'missing'};
  validateSourceIssues([issue],['missing']);
  for(const bad of [{...issue,classification:'COMPLETE'},{...issue,classification:'invented'},{...issue,code:'bad code'},
    {...issue,rawSdk:{token:'PRIVATE'}},{...issue,message:'not the warning'}])assert.throws(()=>validateSourceIssues([bad],['missing']));
  assert.throws(()=>validateSourceIssues([],['missing']),/Unclassified/);
  assert.throws(()=>validateSourceIssues([issue,issue],['missing']),/Duplicate/);
  const index={identifier:'A',warnings:['missing'],entries:[],sourceIssueProfile:'source-issues-v1',sourceIssues:[{...issue,documentId:'B'}]};
  assert.throws(()=>sourceAvailability(index),/identity mismatch/);
  assert.throws(()=>sourceAvailability({...index,sourceIssueProfile:'future-v2'}),/Unknown/);
});
test('legacy warnings remain unclassified and cannot be silently promoted to complete source coverage',()=>{
  const legacy=sourceAvailability({identifier:'A',entries:[],warnings:['historical warning']});
  assert.equal(legacy.profile,'LEGACY_UNCLASSIFIED');assert.deepEqual(legacy.legacyWarnings,['historical warning']);assert(!legacy.hasOfficialTextFallback);
  const report=buildReport({jurisdiction:'EU',rangeFrom:'2025-01-01',rangeTo:'2026-10-20',acts:[]},null,
    {...pendingValidation(),status:'PASS',sourceAvailability:[legacy]},{});
  assert.equal(report.sourceAvailability?.[0].content,'VALIDATED_CONTENT_ONLY');
  assert.throws(()=>sourceAvailability({identifier:'A',entries:[],warnings:[],sourceIssues:[]}),/lack a profile/);
});
test('unclassified historical warnings remain legacy, and mixing known/unknown classes cannot drop facts',()=>{
  const a=archive();a.warning('unknown historical warning');const built=a.build('01_32003L0088.sources.zip');
  assert.equal(built.metadata.sourceIssueProfile,undefined);
  assert.equal(sourceAvailability(loadSourceArchive(built.bytes,built.metadata,'EU',a.identifier).index).profile,'LEGACY_UNCLASSIFIED');
  a.warning('known',{classification:'METADATA_INCOMPLETE',code:'KNOWN_ISSUE'});
  assert.throws(()=>a.build('01_32003L0088.sources.zip'),/mix typed and unclassified/);
});
test('critical source issues remain diagnostically readable but cannot pass the publication loader',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'critical-source-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const a=archive();a.warning('Required relation missing',{classification:'CRITICAL',code:'REQUIRED_SOURCE_MISSING',documentId:a.identifier});
  const built=a.build('01_32003L0088.sources.zip');assert.equal(loadSourceArchive(built.bytes,built.metadata,'EU',a.identifier).index.sourceIssues[0].classification,'CRITICAL');
  const name='01_32003L0088__01.md',bytes=Buffer.from('Text\n');
  const manifest={schemaVersion:2,jurisdiction:'EU',rangeFrom:a.range.from,rangeTo:a.range.to,officialSources:{originalBytes:true},
    acts:[{order:1,celex:a.identifier,files:[fileMetadata(name,bytes)],sourceArchive:built.metadata}]};
  for(const [file,content] of [['manifest.json',Buffer.from(stableJson(manifest))],['INDEX.md',Buffer.from('index\n')],
    ['REPORT.md',Buffer.from('report\n')],[name,bytes],[built.metadata.name,built.bytes]] as const)fs.writeFileSync(path.join(dir,file),content);
  assert.throws(()=>loadValidatedFiles(dir,[{order:1,celex:a.identifier}]),/Critical source issue/);
});
test('EU failed-source evidence preserves native bytes and critical classification, rejecting symlinked evidence directories',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'eu-source-diagnostics-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const before=process.env.LAW_XML_DIAGNOSTICS_DIR;
  t.after(()=>{if(before===undefined)delete process.env.LAW_XML_DIAGNOSTICS_DIR;else process.env.LAW_XML_DIAGNOSTICS_DIR=before;});
  const dir=path.join(root,'evidence');process.env.LAW_XML_DIAGNOSTICS_DIR=dir;
  const a=archive();a.preserveDiagnostic('EU_SOURCE_FAILED');
  const file=fs.readdirSync(dir).find(n=>n.endsWith('.selection.json'))!,record=JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'));
  assert.equal(record.sourceIssues[0].classification,'CRITICAL');assert.equal(record.code,'EU_SOURCE_FAILED');
  assert.equal(record.status,'INCOMPLETE_SOURCE_PROCESSING');
  const loaded=loadSourceArchive(fs.readFileSync(path.join(dir,record.archive.file)),record.archive,'EU',a.identifier);
  assert.equal(Buffer.from(loaded.items['text.xhtml']).toString(),'<html>Official</html>');
  assert.throws(()=>a.preserveDiagnostic('NL_DISCOVERY_FAILED'),/jurisdiction mismatch/);
  const outside=path.join(root,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'witness'),'preserve');
  const link=path.join(root,'link');fs.symlinkSync(outside,link);process.env.LAW_XML_DIAGNOSTICS_DIR=link;
  assert.throws(()=>a.preserveDiagnostic('EU_SOURCE_FAILED'),/evidence persistence failed/);
  assert.deepEqual(fs.readdirSync(outside),['witness']);
});
test('diagnostic-only archives cannot be published even when their syntax, checksums and selected text are intact',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'diagnostic-publication-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const a=archive(),built=a.build('01_32003L0088.sources.zip',{diagnosticOnly:true}),name='01_32003L0088__01.md',bytes=Buffer.from('Text\n');
  const manifest={schemaVersion:2,jurisdiction:'EU',rangeFrom:a.range.from,rangeTo:a.range.to,officialSources:{originalBytes:true},
    acts:[{order:1,celex:a.identifier,files:[fileMetadata(name,bytes)],sourceArchive:built.metadata}]};
  for(const [file,content] of [['manifest.json',Buffer.from(stableJson(manifest))],['INDEX.md',Buffer.from('index\n')],
    ['REPORT.md',Buffer.from('report\n')],[name,bytes],[built.metadata.name,built.bytes]] as const)fs.writeFileSync(path.join(dir,file),content);
  assert.throws(()=>loadValidatedFiles(dir,[{order:1,celex:a.identifier}]),/Diagnostic-only source archive/);
});

test('finding counts distinguish retrieval, rejected bytes and successful empty searches without rewriting historical classifications',()=>{
  const legacy=sourceAvailability({identifier:'A',entries:[],warnings:['unclassified historical detail']});
  const typed={identifier:'A',profile:'source-issues-v1' as const,legacyWarnings:[],hasOfficialTextFallback:false,issues:[
    {code:'FORMEX_REJECTED',classification:'SOURCE_UNAVAILABLE' as const,message:'historical rejected bytes'},
    {code:'FORMEX_NOT_PUBLISHED',classification:'SOURCE_UNAVAILABLE' as const,message:'historical empty search'},
    {code:'FORMEX_RETRIEVAL_FAILED',classification:'SOURCE_UNAVAILABLE' as const,message:'download failed'},
    {code:'OTHER_AVAILABILITY',classification:'SOURCE_UNAVAILABLE' as const,message:'cannot infer stage'},
  ]};
  const before=JSON.stringify(typed);
  assert.deepEqual(sourceFindingCounts([typed,legacy]),{notObserved:1,retrievalFailures:1,rejectedRepresentations:1,unclassifiedAvailabilityIssues:2});
  assert.equal(JSON.stringify(typed),before);
});
