import {auditUnitFields} from './independent-audit.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {zipSync} from 'fflate';
import {validateSourceXml,ensureXmlValidation,closeXmlValidation,SourceXmlRejected,XmlValidatorUnavailable,XmlValidationInfrastructureError} from './xml-validation.js';
import {validateFormexXml} from './xml-archive-validation.js';
import {discoverVersions} from './sru.js';
import {OfficialSources,unpackOfficialZip} from './official-sources.js';
import {hash} from './release-store.js';
import {observeWti,observeUnits} from './unit-observations.js';
import {validateCompletedBuildXml} from './completed-build-validation.js';
import {encode} from './release-store.js';

const ns='http://docs.oasis-open.org/ns/search-ws/sruResponse';
const schema='http://docs.oasis-open.org/search-ws/searchRetrieve/v1.0/os/schemas/sruResponse.xsd';
const xml=(value='0')=>Buffer.from(`<s:searchRetrieveResponse xmlns:s="${ns}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${ns} ${schema}"><s:numberOfRecords>${value}</s:numberOfRecords></s:searchRetrieveResponse>`);
const source=(bytes:Buffer)=>({bytes,text:bytes.toString(),url:'https://zoekservice.overheid.nl/sru/Search',contentType:'application/xml'});
function enabled(t:{after:(f:()=>void)=>void}){
  const previous=process.env.LAW_XML_VALIDATION,previousDir=process.env.LAW_XML_DIAGNOSTICS_DIR;process.env.LAW_XML_VALIDATION='required';
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xml-rejected-test-'));process.env.LAW_XML_DIAGNOSTICS_DIR=dir;
  t.after(()=>{closeXmlValidation();fs.rmSync(dir,{recursive:true,force:true});if(previousDir===undefined)delete process.env.LAW_XML_DIAGNOSTICS_DIR;else process.env.LAW_XML_DIAGNOSTICS_DIR=previousDir;if(previous===undefined)delete process.env.LAW_XML_VALIDATION;else process.env.LAW_XML_VALIDATION=previous;});
}
function checkEvidence(bytes:Buffer){
  const dir=process.env.LAW_XML_DIAGNOSTICS_DIR!,digest=hash(bytes);
  assert.deepEqual(fs.readFileSync(path.join(dir,digest+'.bin')),bytes);
  const names=fs.readdirSync(dir).filter(n=>n.startsWith(digest+'-'));
  assert(names.length);for(const n of names){const receipt=JSON.parse(fs.readFileSync(path.join(dir,n),'utf8'));assert.equal(receipt.sourceSha256,digest);assert.notEqual(receipt.status,'PASS');}
}
test('pinned Python helper frames parallel original byte payloads and checks each receipt',async t=>{
  enabled(t);const bytes=xml();
  const receipts=await Promise.all(Array.from({length:4},()=>validateSourceXml(source(bytes),'SRU-2.0')));
  for(const r of receipts){assert.equal(r?.status,'PASS');assert.equal(r?.sourceSha256,hash(bytes));assert.equal(r?.sourceBytes,bytes.length);}
});
test('native CORR passes pinned XSD and independent complete hierarchy audit rejects omissions and parent swaps',async t=>{
  enabled(t);const bytes=fs.readFileSync(new URL('fixtures/formex-corrigendum-native.xml',import.meta.url));
  const receipt=await validateSourceXml(source(bytes),'CELLAR-Formex4');assert.equal(receipt?.status,'PASS');
  const snapshot=observeUnits(bytes,{jurisdiction:'EU',documentId:'32025L2450R(01)',url:null});
  const verify=(value:unknown)=>auditUnitFields({bytes:bytes.toString('base64'),snapshot:value});
  const good=verify(snapshot);assert.equal(good.status,0,good.stderr);
  assert.notEqual(verify({...snapshot,units:snapshot.units.filter(unit=>unit.element!=='NEW.CORR')}).status,0);
  const changed=structuredClone(snapshot),old=changed.units.find(unit=>unit.element==='OLD.CORR')!,fresh=changed.units.find(unit=>unit.element==='NEW.CORR')!;
  changed.units.find(unit=>unit.parentId===fresh.technicalId)!.parentId=old.technicalId;
  assert.notEqual(verify(changed).status,0);
});
test('pinned WTI schema accepts mixed remarks whose parent and child evidence must all survive',async t=>{
  enabled(t);const bytes=fs.readFileSync(new URL('fixtures/wti-mixed-valid.xml',import.meta.url));
  const input={...source(bytes),url:'https://repository.officiele-overheidspublicaties.nl/bwb/BWBR0009616/BWBR0009616.WTI'};
  const receipt=await validateSourceXml(input,'BWB-WTI','BWBR0009616');assert.equal(receipt?.status,'PASS');
  const wti=observeWti(bytes,{jurisdiction:'NL',documentId:'BWBR0009616',url:input.url},{from:'2025-01-01',to:'2026-10-18'});
  const fields=wti.events[1].fields;
  assert(fields.some(field=>field.locator==='opmerkingen[1]/opmerking[1]/text()[1]'&&field.value==='Voor '));
  assert(fields.some(field=>field.locator==='opmerkingen[1]/opmerking[1]/al[1]/text()'&&field.value==='De tekst.'));
  assert(fields.some(field=>field.locator==='opmerkingen[1]/opmerking[1]/text()[2]'&&field.value===' Na.'));
  const checked=auditUnitFields({bytes:bytes.toString('base64'),wti});
  assert.equal(checked.status,0,checked.stderr);assert(wti.events.every(event=>event.legalEffect==='UNRESOLVED'));
});
test('bad XSD rejects discovery before parseSru can accept NaN and preserves the exact response',async t=>{
  enabled(t);const bytes=xml('not-a-number'),archive=new OfficialSources('NL','BWBR0000001',{from:'2025-01-01',to:'2026-10-17',observedOn:'2026-10-17'});
  let requests=0;
  await assert.rejects(discoverVersions('BWBR0000001',archive,async()=>{requests++;return source(bytes);}),SourceXmlRejected);
  assert.equal(requests,1);checkEvidence(bytes);
  assert.throws(()=>archive.build('01_BWBR0000001.sources.zip'),/Empty/);
});
test('unknown schema and external entity attempts fail closed while preserving original evidence',async t=>{
  enabled(t);
  for(const bytes of [xml().toString().replace(schema,'https://example.invalid/unknown.xsd'),
    '<!DOCTYPE work [<!ENTITY external SYSTEM "file:///nonexistent/secret">]><work label="BWBR0000001"/>'].map(x=>Buffer.from(x))){
    await assert.rejects(validateSourceXml(source(bytes),bytes.toString().includes('DOCTYPE')?'BWB-manifest':'SRU-2.0','BWBR0000001'),SourceXmlRejected);
    checkEvidence(bytes);
  }
});
test('RDF XML-only result never claims an XSD pass',async t=>{
  enabled(t);const bytes=Buffer.from('<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/>');
  const receipt=await validateSourceXml(source(bytes),'CELLAR-RDF-tree');
  assert.equal(receipt?.status,'NO_PINNED_SCHEMA');assert.equal(receipt?.schemaSha256,undefined);
});
test('rejected Formex preserves both XML member and complete downloaded package',async t=>{
  enabled(t);const member=Buffer.from('<ACT xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="https://example.invalid/future.xsd"/>');
  const bytes=Buffer.from(zipSync({'ACT.xml':member}));
  await assert.rejects(validateFormexXml(source(bytes)),SourceXmlRejected);checkEvidence(bytes);checkEvidence(member);
  // The same rejected bytes may be observed with different response metadata.
  // Both observations must survive without a false evidence conflict.
  await assert.rejects(validateFormexXml({...source(bytes),contentType:'application/zip'}),SourceXmlRejected);
  await assert.rejects(validateFormexXml(source(bytes)),SourceXmlRejected);checkEvidence(bytes);checkEvidence(member);
});
test('unavailable pinned runtime stops processing without reporting a source as corrupt',async t=>{
  enabled(t);closeXmlValidation();const previous=process.env.LAW_XML_PYTHON;
  process.env.LAW_XML_PYTHON='/nonexistent/updater-python';
  t.after(()=>{if(previous===undefined)delete process.env.LAW_XML_PYTHON;else process.env.LAW_XML_PYTHON=previous;});
  await assert.rejects(ensureXmlValidation(),error=>error instanceof XmlValidatorUnavailable&&error.reason==='PROCESS_START');
});

test('validator infrastructure diagnostics keep an allowlisted reason without persisting arbitrary helper output',async t=>{
  enabled(t);const previous=process.env.LAW_XML_PYTHON;
  t.after(()=>{if(previous===undefined)delete process.env.LAW_XML_PYTHON;else process.env.LAW_XML_PYTHON=previous;});
  const fake=path.join(process.env.LAW_XML_DIAGNOSTICS_DIR!,'fake-python');
  fs.writeFileSync(fake,'#!/bin/sh\nprintf \'{"type":"fatal","code":"XML_VALIDATOR_UNAVAILABLE","private":"PRIVATE_HELPER_DIAGNOSTIC"}\\n\'\nprintf \'PRIVATE_HELPER_STDERR\\n\' >&2\nexit 1\n',{mode:0o755});
  process.env.LAW_XML_PYTHON=fake;const bytes=xml('207');
  await assert.rejects(validateSourceXml(source(bytes),'SRU-2.0'),error=>error instanceof XmlValidatorUnavailable&&error.reason==='HELPER_REJECTED');
  const records=fs.readdirSync(process.env.LAW_XML_DIAGNOSTICS_DIR!).filter(name=>name.startsWith(hash(bytes)+'-'));
  assert.equal(records.length,1);const raw=fs.readFileSync(path.join(process.env.LAW_XML_DIAGNOSTICS_DIR!,records[0]),'utf8');
  assert(!raw.includes('PRIVATE_HELPER'));const receipt=JSON.parse(raw);
  assert.equal(receipt.status,'VALIDATOR_FAILURE');assert.equal(receipt.infrastructureReason,'HELPER_REJECTED');
});
test('Formex validation infrastructure failure preserves its package without blaming source corruption',async t=>{
  enabled(t);const previous=process.env.LAW_XML_PYTHON;process.env.LAW_XML_PYTHON='/nonexistent/updater-python';
  t.after(()=>{if(previous===undefined)delete process.env.LAW_XML_PYTHON;else process.env.LAW_XML_PYTHON=previous;});
  const bytes=Buffer.from(zipSync({'law.xml':Buffer.from('<ACT/>')})),input={...source(bytes),contentType:'application/zip'};
  await assert.rejects(validateFormexXml(input),XmlValidationInfrastructureError);
  const prefix=hash(bytes)+'-',dir=process.env.LAW_XML_DIAGNOSTICS_DIR!;
  const records=fs.readdirSync(dir).filter(name=>name.startsWith(prefix)&&name.endsWith('.json')).map(name=>JSON.parse(fs.readFileSync(path.join(dir,name),'utf8')));
  assert(records.length);assert(records.every(record=>record.status==='VALIDATOR_FAILURE'));
  assert.deepEqual(fs.readFileSync(path.join(dir,hash(bytes)+'.bin')),bytes);
});
test('duplicate official ZIP names are rejected before unzip can silently overwrite a member',()=>{
  const bytes=Buffer.from(zipSync({'a.xml':Buffer.from('<a/>'),'b.xml':Buffer.from('<b/>')}));
  const duplicate=Buffer.from(bytes.toString('latin1').replaceAll('b.xml','a.xml'),'latin1');
  assert.throws(()=>unpackOfficialZip(duplicate),/Duplicate/);
});

test('checkpoint restore cannot bypass required NL XML with an archive containing only discovery JSON',async t=>{
  enabled(t);const {validateCheckpointArchive}=await import('./xml-archive-validation.js');
  const archive=new OfficialSources('NL','BWBR0000001',{from:'2025-01-01',to:'2026-10-17',observedOn:'2026-10-17'});
  archive.add('discovery.json',{...source(Buffer.from('{}')),contentType:'application/json'},'https://zoekservice.overheid.nl/','discovery');
  const built=archive.build('01_BWBR0000001.sources.zip');
  await assert.rejects(validateCheckpointArchive(built.bytes,built.metadata,'NL','BWBR0000001'),/required Toestand/);
});
test('completed paired snapshot cannot bypass the pinned XML runtime or required Toestand before model replay',async t=>{
  enabled(t);
  const pair=new Map((['NL','EU'] as const).map(module=>{
    const id=module==='NL'?'BWBR0000001':'32008L0104';
    const archive=new OfficialSources(module,id,{from:'2025-01-01',to:'2026-10-17',observedOn:'2026-10-17'});
    archive.add('discovery.json',{...source(Buffer.from('{}')),contentType:'application/json'},'https://example.invalid/','discovery');
    const built=archive.build(`01_${id}.sources.zip`);
    return [module,new Map([['manifest.json',encode({schemaVersion:2,jurisdiction:module,acts:[{[module==='NL'?'bwbId':'celex']:id,sourceArchive:built.metadata}]})],
      [built.metadata.name,built.bytes]])];
  }));
  await assert.rejects(validateCompletedBuildXml(pair),/required Toestand/);
  process.env.LAW_XML_VALIDATION='off';
  await assert.rejects(validateCompletedBuildXml(pair),/requires pinned XML/);
});


test('failure to preserve rejected auxiliary bytes stops fallback rather than turning into a source warning',async t=>{
  enabled(t);const {fetchRdfNotice}=await import('./eu-provider.js');
  const blocked=path.join(process.env.LAW_XML_DIAGNOSTICS_DIR!,'blocked');fs.writeFileSync(blocked,'ordinary file');
  process.env.LAW_XML_DIAGNOSTICS_DIR=blocked;let requests=0;
  await assert.rejects(fetchRdfNotice('https://publications.europa.eu/resource/test',async()=>{
    requests++;return source(Buffer.from('<not-an-rdf-notice/>'));
  }),XmlValidationInfrastructureError);
  assert.equal(requests,1);
});
