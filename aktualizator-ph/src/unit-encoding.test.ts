import test from 'node:test';
import assert from 'node:assert/strict';
import {observeUnits,observeWti} from './unit-observations.js';
import {encodeUnitMetadata,decodeUnitMetadata} from './unit-encoding.js';
import {OfficialSources,loadSourceArchive} from './official-sources.js';

test('correction source profile roundtrips while legacy CORR remains unchanged and wrong contexts fail',()=>{
  const bytes=Buffer.from('<CORR><CONTENTS.CORR><CORRECTION><OLD.CORR FOR.READ="YES"><P>Old.</P></OLD.CORR><NEW.CORR FOR.READ="YES"><P>New.</P></NEW.CORR></CORRECTION></CONTENTS.CORR></CORR>');
  const url='https://publications.europa.eu/resource/cellar/test-correction';
  const snapshot=observeUnits(bytes,{jurisdiction:'EU',documentId:'32025L2450R(01)',url});
  const metadata={unitHistory:[snapshot]},packed=encodeUnitMetadata(metadata,'EU');
  decodeUnitMetadata(packed,'EU');
  const {unitEncoding,...decoded}=packed.unitHistory[0];assert.deepEqual(decoded,snapshot);
  const legacy={unitHistory:[{...snapshot,profile:'unit-observations-v3',units:[]}]};
  const old=encodeUnitMetadata(legacy,'EU');decodeUnitMetadata(old,'EU');
  assert.equal(old.unitHistory[0].profile,'unit-observations-v3');assert.deepEqual(old.unitHistory[0].units,[]);
  assert.throws(()=>encodeUnitMetadata(metadata,'NL'),/requires an EU CORR/);
  assert.throws(()=>decodeUnitMetadata({unitHistory:[{...snapshot,root:'ACT'}]},'EU'),/requires an EU CORR/);
  const archive=new OfficialSources('EU',snapshot.source.documentId,{from:'2025-01-01',to:'2026-10-20',observedOn:'2026-10-20'});
  archive.add('correction.xml',{bytes,url,contentType:'application/xml'},url,'test-native-correction',metadata);
  const built=archive.build('01_32025L2450R_01_.sources.zip');
  const restored=loadSourceArchive(built.bytes,built.metadata,'EU',snapshot.source.documentId);
  assert.deepEqual(restored.index.entries[0].metadata.unitHistory[0].units,snapshot.units);
  assert.deepEqual(Buffer.from(restored.items['correction.xml']),bytes);
});

test('revision identifiers roundtrip in profile 3 while profile 2 retains its historical meaning',()=>{
  const snapshot=observeUnits(Buffer.from('<toestand bwb-id="BWBR0009616"><artikel label-id="1" revisie-id="2"/></toestand>'),
    {jurisdiction:'NL',documentId:'BWBR0009616',url:null});
  const current={unitHistoryProfile:snapshot.profile,unitHistorySource:snapshot.source,units:snapshot.units,unitCorrections:snapshot.corrections};
  const packed=encodeUnitMetadata(current,'NL');decodeUnitMetadata(packed,'NL');assert.deepEqual(packed.units,current.units);
  const legacy={...current,unitHistoryProfile:'unit-observations-v2',units:snapshot.units.map(unit=>({...unit,
    officialIdentifiers:unit.officialIdentifiers.filter(id=>id.name!=='revisie-id')}))};
  const oldPacked=encodeUnitMetadata(legacy,'NL');decodeUnitMetadata(oldPacked,'NL');assert.deepEqual(oldPacked.units,legacy.units);
  assert.equal(oldPacked.units[0].fields.find((field:any)=>field.name==='revisie-id').value,'2');
  assert.equal(oldPacked.units[0].officialIdentifiers.some((id:any)=>id.name==='revisie-id'),false);
});

test('factored unit and WTI evidence roundtrips every assertion without changing native bytes',()=>{
  const source={jurisdiction:'NL' as const,documentId:'BWBR0009616',url:'https://official.example/state'};
  const bytes=Buffer.from('<toestand bwb-id="BWBR0009616"><wetgeving><artikel stam-id="123" label-id="456" inwerking="2025-01-01"><kop><nr>1</nr></kop><lid><al>Officiële tekst.</al></lid></artikel></wetgeving></toestand>');
  const snapshot=observeUnits(bytes,source),wti=observeWti(Buffer.from('<wetstechnische-informatie bwb-id="BWBR0009616"><wijzigingen><regeling><datum waarde="2037-01-01"><details><betreft>Aanhangig</betreft></details></datum></regeling></wijzigingen></wetstechnische-informatie>'),source,{from:'2025-01-01',to:'2026-10-17'});
  const metadata={units:snapshot.units,unitHistorySource:snapshot.source,unitHistoryProfile:snapshot.profile,wtiHistory:wti};
  const packed=encodeUnitMetadata(metadata,'NL');
  assert.equal(packed.units[0].fields,undefined);assert.equal(packed.wtiHistory.events[0].legalEffect,undefined);
  assert.equal(packed.units[0].technicalId,undefined);assert.equal(packed.units[0].parentIndex,null);
  assert.equal(packed.units[1].parentIndex,0);
  assert.equal(packed.wtiHistory.stateEncoding,'direct-state-attributes-v1');
  assert.equal(packed.wtiHistory.events[0].state,undefined);
  decodeUnitMetadata(packed,'NL');assert.deepEqual(packed.units,snapshot.units);assert.deepEqual(packed.wtiHistory.events,wti.events);
  const archive=new OfficialSources('NL',source.documentId,{from:'2025-01-01',to:'2026-10-17',observedOn:'2026-10-17'});
  archive.add('toestand/state.xml',{bytes,url:source.url,contentType:'application/xml'},source.url,'BWB-Toestand',metadata);
  const built=archive.build('01_BWBR0009616.sources.zip'),loaded=loadSourceArchive(built.bytes,built.metadata,'NL',source.documentId);
  assert.deepEqual(loaded.index.entries[0].metadata.units,snapshot.units);
  assert.deepEqual(Buffer.from(loaded.items['toestand/state.xml']),bytes);
  assert.equal(built.metadata.catalogFormat,'canonical-compact-json-v1');
});
test('encoding refuses to drop a changed classification or a newly established legal fact',()=>{
  const snapshot=observeUnits(Buffer.from('<toestand bwb-id="BWBR0009616"><artikel stam-id="1"/></toestand>'),
    {jurisdiction:'NL',documentId:'BWBR0009616',url:null}),unit=snapshot.units[0];
  const metadata={units:[{...unit,legalDates:'newly-established-value'}],unitHistoryProfile:'unit-observations-v2',unitHistorySource:snapshot.source};
  assert.throws(()=>encodeUnitMetadata(metadata,'NL'),/lose source observations/);
  assert.throws(()=>decodeUnitMetadata({unitEncoding:'unknown',units:[]},'NL'),/Unknown/);
  const encoded=encodeUnitMetadata({...metadata,units:[unit]},'NL');
  encoded.units[0].legalStatus='purported-established-status';
  assert.throws(()=>decodeUnitMetadata(encoded,'NL'),/Conflicting fact/);
});
test('WTI state factoring preserves own labels/versions and refuses unsupported extra assertions',()=>{
  const source={jurisdiction:'NL' as const,documentId:'BWBR0009616',url:null};
  const wti=observeWti(Buffer.from('<wetstechnische-informatie bwb-id="BWBR0009616"><wijzigingen><regelingelement label-id="1"><datum label="Artikel 2" versie-id="2"><details><betreft>vernummering</betreft></details></datum></regelingelement></wijzigingen></wetstechnische-informatie>'),source,{from:'2025-01-01',to:'2026-10-18'});
  const packed=encodeUnitMetadata({wtiHistory:wti},'NL');decodeUnitMetadata(packed,'NL');
  assert.deepEqual(packed.wtiHistory.events,wti.events);
  (wti.events[0].state as any).newOfficialFact='must not disappear';
  assert.throws(()=>encodeUnitMetadata({wtiHistory:wti},'NL'),/lose source observations/);
});
test('technical locator factoring refuses invalid parents or extra facts and retains legacy decoding',()=>{
  const snapshot=observeUnits(Buffer.from('<toestand bwb-id="BWBR0009616"><artikel stam-id="1"><lid><al>tekst</al></lid></artikel></toestand>'),
    {jurisdiction:'NL',documentId:'BWBR0009616',url:null});
  const metadata={unitHistoryProfile:snapshot.profile,unitHistorySource:snapshot.source,units:snapshot.units};
  const packed=encodeUnitMetadata(metadata,'NL');packed.units[1].parentIndex=1;
  assert.throws(()=>decodeUnitMetadata(packed,'NL'),/parent index/);
  const extra=structuredClone(metadata);(extra.units[0] as any).parentIndex='official fact that must remain';
  assert.throws(()=>encodeUnitMetadata(extra,'NL'),/lose source observations/);
  const legacy={...metadata,unitEncoding:'direct-attributes-v1',units:snapshot.units.map(unit=>{
    const {fields,officialIdentifiers,identityKind,legalStatus,legalDates,text,...rest}=unit;
    return {...rest,text:{sha256:text.sha256}};
  })};
  decodeUnitMetadata(legacy,'NL');assert.deepEqual(legacy.units,snapshot.units);
});
