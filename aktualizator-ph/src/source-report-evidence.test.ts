import test from 'node:test';
import assert from 'node:assert/strict';
import {observeUnits} from './unit-observations.js';
import {sourceReportEvidence,compareSourceReportEvidence,validateSourceReportEvidence} from './source-report-evidence.js';
import {OfficialSources,loadSourceArchive,unpackOfficialZip} from './official-sources.js';
import {hash} from './release-store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function nl(xml:string,state='state1'){
  const snapshot=observeUnits(Buffer.from(xml),{jurisdiction:'NL',documentId:'BWBR0000001',url:'https://example.org/state'});
  return {kind:'BWB-Toestand',name:state+'.xml',sha256:hash(Buffer.from(xml)),requestedUrl:'https://example.org/'+state,url:'https://example.org/'+state,contentType:'application/xml',
    metadata:{unitHistoryProfile:snapshot.profile,unitHistorySource:snapshot.source,units:snapshot.units,unitCorrections:snapshot.corrections,version:{key:state}}};
}
const text=(value:string,attributes='')=>`<toestand bwb-id="BWBR0000001"><artikel stam-id="stable" ${attributes}>${value}</artikel></toestand>`;
const index=(entries:any[])=>({jurisdiction:'NL',identifier:'BWBR0000001',entries});
test('official work identity compares text and own metadata separately, without inheriting a document date',()=>{
  const before=sourceReportEvidence(index([nl(text('A','label-id="old"'))]));
  const after=sourceReportEvidence(index([nl(text('A','label-id="new"'))]));
  const delta=compareSourceReportEvidence(after,before);
  assert.equal(delta.metadataOnly,1);assert.equal(delta.changedTextVariants,0);assert.equal(delta.legalEffect,'UNRESOLVED');
  assert.equal(delta.identityKind,'DERIVED_TECHNICAL_SCOPED_KEY');
  const changed=compareSourceReportEvidence(sourceReportEvidence(index([nl(text('B','label-id="new"'))])),before);
  assert.equal(changed.changedTextVariants,1);assert.equal(changed.metadataOnly,0);
  const two=sourceReportEvidence(index([nl(text('A','label-id="old"')),nl(text('A','label-id="old"'),'state2')]));
  assert.equal(compareSourceReportEvidence(two,before).observationMultiplicityOnly,1);assert.equal(two.units[0][3],2);
});
test('own JCI, source order and parent identity changes remain metadata rather than inherited legal effects',()=>{
  const jci=(value:string)=>text(`A<meta-data><jcis><jci waarde="${value}"/></jcis></meta-data>`);
  const before=sourceReportEvidence(index([nl(jci('old'))])),after=sourceReportEvidence(index([nl(jci('new'))]));
  assert.equal(compareSourceReportEvidence(after,before).metadataOnly,1);assert.equal(compareSourceReportEvidence(after,before).changedTextVariants,0);
  const first='<artikel stam-id="a">A</artikel>',second='<bijlage stam-id="b">B</bijlage>';
  const wrap=(body:string)=>`<toestand bwb-id="BWBR0000001">${body}</toestand>`;
  assert.equal(compareSourceReportEvidence(sourceReportEvidence(index([nl(wrap(second+first))])),sourceReportEvidence(index([nl(wrap(first+second))]))).metadataOnly,2);
  const parent=(id:string)=>wrap(`<artikel stam-id="${id}"><lid stam-id="child">A</lid></artikel>`);
  const delta=compareSourceReportEvidence(sourceReportEvidence(index([nl(parent('new-parent'))])),sourceReportEvidence(index([nl(parent('old-parent'))])));
  assert.equal(delta.metadataOnly,1);assert.equal(delta.legalEffect,'UNRESOLVED');
});
test('ambiguous identifiers never become newly added or repealed units, including formerly unique observations',()=>{
  const unique=sourceReportEvidence(index([nl(text('A'))]));
  const duplicate='<toestand bwb-id="BWBR0000001"><artikel stam-id="stable">A</artikel><artikel stam-id="stable">B</artikel></toestand>';
  const uncertain=sourceReportEvidence(index([nl(text('A')),nl(duplicate,'state2')]));
  assert.equal(uncertain.units.length,0);assert.equal(uncertain.unresolvedObservations,3);
  const delta=compareSourceReportEvidence(uncertain,unique);
  assert.equal(delta.absentScopedIdentities,0);assert.equal(delta.newlyObservedScopedIdentities,0);assert.equal(delta.ambiguousIdentities,1);
});
test('swapping text between older source states is detected even when global variants and counts stay equal',()=>{
  const before=sourceReportEvidence(index([nl(text('A'),'g1'),nl(text('B'),'z1')]));
  const after=sourceReportEvidence(index([nl(text('B'),'g1'),nl(text('A'),'z1')]));
  const delta=compareSourceReportEvidence(after,before);
  assert.equal(delta.changedTextVariants,0);assert.equal(delta.unchanged,0);
  assert.equal(delta.changedObservationAssociations,1);assert.equal(delta.legalEffect,'UNRESOLVED');
});
test('own editorial correction facts preserve duplicate events and distinguish previously observed source documents',()=>{
  const original=sourceReportEvidence(index([nl(text('A'))]));
  const correction='<redactionele-correctie label-id="art1" oud-revisie-id="r1" nieuw-revisie-id="r2"/>';
  const once=sourceReportEvidence(index([nl(text('A'+correction))]));
  const twice=sourceReportEvidence(index([nl(text('A'+correction+correction))]));
  assert.equal(compareSourceReportEvidence(once,original).newCorrectionsInPreviouslyObservedDocuments,1);
  assert.equal(compareSourceReportEvidence(twice,once).newSourceCorrectionObservations,1);assert.equal(twice.corrections[0][2],2);
  const newState=sourceReportEvidence(index([nl(text('A'+correction),'new-state')]));
  assert.equal(compareSourceReportEvidence(newState,original).newCorrectionsInPreviouslyObservedDocuments,0);
});
test('EU identifiers remain within document/member scope; equal text and changed outer ZIP do not imply legal continuity',()=>{
  const eu=(documentId:string,container='a'.repeat(64))=>{
    const xml=Buffer.from('<ACT><ARTICLE IDENTIFIER="art1">Same</ARTICLE></ACT>');
    return {jurisdiction:'EU',identifier:documentId,entries:[{name:'content.zip',kind:'CELLAR-Formex4',sha256:container,url:'https://example.org/a',
      requestedUrl:'https://example.org/a',contentType:'application/zip',metadata:{celex:documentId,unitHistory:[observeUnits(xml,
        {jurisdiction:'EU',documentId,url:'https://example.org/a',member:'act.xml',containerSha256:container})]}}]};
  };
  const before=sourceReportEvidence(eu('32003L0088')),different=sourceReportEvidence(eu('32008L0104'));
  assert.notEqual(before.units[0][0],different.units[0][0]);assert.equal(compareSourceReportEvidence(different,before).newlyObservedScopedIdentities,1);
  const repacked=sourceReportEvidence(eu('32003L0088','c'.repeat(64)));
  assert.deepEqual(repacked.units,before.units);assert.equal(compareSourceReportEvidence(repacked,before).archivedRepresentations.changedBytes,1);
  assert.equal(compareSourceReportEvidence(repacked,before).changedTextVariants,0);
  const raw={jurisdiction:'EU',identifier:'32003L0088',entries:[{name:'text',kind:'CELLAR-XHTML',sha256:'a'.repeat(64),metadata:{celex:'32003L0088'}}]};
  assert.deepEqual(sourceReportEvidence(raw).unstructuredDocuments,['32003L0088']);
});
test('archived SHA256 and compact evidence are verified against original bytes and expanded observations',()=>{
  const a=new OfficialSources('NL','BWBR0000001',{from:'2025-01-01',to:'2026-10-20',observedOn:'2026-10-20'}),entry=nl(text('A'));
  a.add(entry.name,{bytes:Buffer.from(text('A')),url:entry.url,contentType:entry.contentType},entry.requestedUrl,entry.kind,entry.metadata);
  const native=a.build('01_BWBR0000001.sources.zip');const loaded=loadSourceArchive(native.bytes,native.metadata,'NL',a.identifier);
  assert.equal(loaded.index.entries[0].sha256,hash(Buffer.from(text('A'))));
  validateSourceReportEvidence(native.metadata.reportEvidence);
  const tampered=structuredClone(native.metadata);tampered.reportEvidence!.units[0][1]=['b'.repeat(64)];
  assert.throws(()=>loadSourceArchive(native.bytes,tampered,'NL',a.identifier),/report evidence differs/);
  const bad=structuredClone(native.metadata.reportEvidence!);bad.units.push(bad.units[0]);assert.throws(()=>validateSourceReportEvidence(bad),/comparison unit/);
});
test('unsupported report model cannot prevent preservation of the original source bytes as diagnostic-only evidence',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'report-infra-diagnostics-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const previous=process.env.LAW_XML_DIAGNOSTICS_DIR;process.env.LAW_XML_DIAGNOSTICS_DIR=dir;
  t.after(()=>{if(previous===undefined)delete process.env.LAW_XML_DIAGNOSTICS_DIR;else process.env.LAW_XML_DIAGNOSTICS_DIR=previous;});
  const xml=Buffer.from('<ACT><ARTICLE IDENTIFIER="a1">Official</ARTICLE></ACT>');
  const snapshot=observeUnits(xml,{jurisdiction:'EU',documentId:'32003L0088',url:'https://example.org/a',member:'act.xml'});
  const future={...snapshot,profile:'unsupported-future-profile'};
  const a=new OfficialSources('EU','32003L0088',{from:'2025-01-01',to:'2026-10-20',observedOn:'2026-10-20'});
  a.add('act.xml',{bytes:xml,url:'https://example.org/a',contentType:'application/xml'},'https://example.org/a','CELLAR-Formex4',
    {celex:'32003L0088',unitHistory:[future]});
  assert.throws(()=>a.build('01_32003L0088.sources.zip'),/unsupported source report model/);
  a.preserveDiagnostic('EU_SOURCE_FAILED');
  const record=JSON.parse(fs.readFileSync(path.join(dir,fs.readdirSync(dir).find(n=>n.endsWith('.selection.json'))!),'utf8'));
  assert.equal(record.archive.diagnosticOnly,true);assert.equal(record.archive.reportEvidence,undefined);
  const items=unpackOfficialZip(fs.readFileSync(path.join(dir,record.archive.file)));
  assert.deepEqual(Buffer.from(items['act.xml']),xml);assert.equal(JSON.parse(Buffer.from(items['manifest.json']).toString()).diagnosticOnly,true);
});
