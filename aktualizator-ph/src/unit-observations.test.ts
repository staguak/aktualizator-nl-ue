import test from 'node:test';
import assert from 'node:assert/strict';
import {observeUnits,linkOfficialUnitObservations,observeWti,correlateWtiUnits} from './unit-observations.js';
import {hash} from './release-store.js';
import fs from 'node:fs';
const source={jurisdiction:'NL' as const,documentId:'BWBR0009616',url:'https://official.example/state'};
const xml=(body:string,date='2025-01-01')=>Buffer.from(`<toestand bwb-id="BWBR0009616" inwerkingtreding="${date}"><wetgeving>${body}</wetgeving></toestand>`);
const article=(number='1',extra='',text='Officiële tekst.')=>`<artikel stam-id="official-123" inwerking="2024-01-01" ${extra}><kop><label>Artikel</label><nr>${number}</nr></kop><lid label-id="paragraph-2"><al>${text}</al><lijst><li><al>Lijsttekst</al></li></lijst></lid></artikel>`;

test('native Formex corrigendum retains old/new source hierarchy without inventing the corrected legal unit',()=>{
  const bytes=fs.readFileSync(new URL('fixtures/formex-corrigendum-native.xml',import.meta.url));
  const provenance=JSON.parse(fs.readFileSync(new URL('fixtures/formex-corrigendum-native.provenance.json',import.meta.url),'utf8'));
  assert.equal(hash(bytes),provenance.sha256);
  const snapshot=observeUnits(bytes,{jurisdiction:'EU',documentId:provenance.celex,url:provenance.url,
    member:provenance.member,containerSha256:provenance.containerSha256});
  assert.equal(snapshot.profile,'unit-correction-observations-v1');
  const get=(tag:string)=>snapshot.units.find(unit=>unit.element===tag)!;
  assert.equal(get('CORRECTION').parentId,get('CONTENTS.CORR').technicalId);
  assert.equal(get('CONTENTS.CORR').parentId,get('CORR').technicalId);
  for(const tag of ['DESCRIPTION','OLD.CORR','NEW.CORR'])assert.equal(get(tag).parentId,get('CORRECTION').technicalId);
  assert.equal(get('OLD.CORR').attributes['FOR.READ'],'YES');
  const paragraphs=snapshot.units.filter(unit=>unit.element==='P');assert.equal(paragraphs.length,5);
  assert.notEqual(paragraphs.at(-2)!.text.sha256,paragraphs.at(-1)!.text.sha256);
  assert.equal(get('DESCRIPTION').locator,'/CORR[1]/CONTENTS.CORR[1]/CORRECTION[1]/DESCRIPTION[1]');
  assert(snapshot.units.every(unit=>unit.legalDates==='UNRESOLVED'&&unit.legalStatus==='UNRESOLVED'&&unit.identityKind==='DERIVED_TECHNICAL'));
  assert.equal(snapshot.units.filter(unit=>unit.element==='ARTICLE'||unit.element==='ANNEX').length,0);
  assert.equal(linkOfficialUnitObservations([snapshot]).groups.length,0);
  assert.equal(linkOfficialUnitObservations([snapshot]).unresolved.length,snapshot.units.length);
  assert.equal(observeUnits(Buffer.from('<ACT><P>Ordinary body.</P></ACT>'),{jurisdiction:'EU',documentId:'32025L2450',url:null}).profile,'unit-observations-v3');
});

test('WTI preserves direct mixed text and child text separately with exact XPath semantics',()=>{
  const bytes=Buffer.from('<wetstechnische-informatie bwb-id="BWBR0009616"><wijzigingen><datum waarde="2025-01-01"><details>voor<betreft>wij<![CDATA[zig]]><nadruk>in</nadruk>g</betreft>staart<publicatie jaar="2025">bron</publicatie></details></datum></wijzigingen></wetstechnische-informatie>');
  const [event]=observeWti(bytes,source,{from:'2025-01-01',to:'2026-10-18'}).events;
  assert.deepEqual(event.nativeLabel,{value:'wijziging',locator:'string(betreft[1])'});
  assert.deepEqual(event.fields.map(field=>[field.locator,field.value]),[
    ['text()[1]','voor'],['text()[2]','staart'],['betreft[1]/text()[1]','wijzig'],['betreft[1]/text()[2]','g'],['betreft[1]/nadruk[1]/text()','in'],
    ['publicatie[1]/@jaar','2025'],['publicatie[1]/text()','bron'],
  ]);
  assert.equal(event.legalEffect,'UNRESOLVED');assert.equal(event.date!.value,'2025-01-01');
});

test('editorial corrections preserve both revision assertions without inventing legal effects',()=>{
  const bytes=xml('<artikel label-id="a" revisie-id="new"><al>tekst</al></artikel>'+
    '<artikel label-id="b" revisie-id="same"/>'+
    '<redactionele-correcties><redactionele-correctie label-id="a" oud-revisie-id="old" nieuw-revisie-id="new"/>'+
    '<redactionele-correctie label-id="b" oud-revisie-id="same" nieuw-revisie-id="same"/>'+
    '<redactionele-correctie label-id="absent" oud-revisie-id="x" nieuw-revisie-id="y"/></redactionele-correcties>');
  const snapshot=observeUnits(bytes,source),[changed,equal,absent]=snapshot.corrections;
  assert.equal(snapshot.corrections.length,3);
  assert.equal(changed.locator,'/toestand[1]/wetgeving[1]/redactionele-correcties[1]/redactionele-correctie[1]');
  assert.equal(changed.fields.find(field=>field.name==='oud-revisie-id')!.value,'old');
  assert.deepEqual(changed.revisionMatchIndexes,{old:[],new:[0]});
  assert.deepEqual(equal.revisionMatchIndexes,{old:[0],new:[0]});
  assert.deepEqual(absent.labelMatches,[]);assert.deepEqual(absent.revisionMatchIndexes,{old:[],new:[]});
  const unit=snapshot.units.find(unit=>unit.attributes['label-id']==='a')!;
  assert.deepEqual(changed.labelMatches,[{unit:unit.technicalId,locator:unit.locator+'/@label-id'}]);
  assert.deepEqual(unit.officialIdentifiers.find(id=>id.name==='revisie-id'),
    {name:'revisie-id',value:'new',locator:'@revisie-id',scope:'source-document'});
  assert(snapshot.corrections.every(correction=>correction.legalEffect==='UNRESOLVED'));
  assert(snapshot.units.every(unit=>unit.legalDates==='UNRESOLVED'&&unit.legalStatus==='UNRESOLVED'));
  assert.equal(snapshot.source.sha256,hash(bytes));
});

test('unit observations preserve hierarchy, source bytes, exact field locators and unresolved child dates',()=>{
  const bytes=xml(article()),snapshot=observeUnits(bytes,source),[a,p,item]=snapshot.units.filter(u=>['artikel','lid','li'].includes(u.element));
  assert.equal(a.parentId,snapshot.units.find(u=>u.element==='wetgeving')!.technicalId);
  assert.equal(snapshot.source.sha256,hash(bytes));assert.deepEqual(bytes,xml(article()));
  assert.equal(a.locator+'/'+a.fields.find(f=>f.name==='inwerking')!.locator,'/toestand[1]/wetgeving[1]/artikel[1]/@inwerking');
  assert.equal(p.parentId,a.technicalId);assert.equal(item.parentId,p.technicalId);assert.equal(p.attributes.inwerking,undefined);
  assert.equal(p.legalDates,'UNRESOLVED');assert.equal(a.legalStatus,'UNRESOLVED');assert.equal(a.identityKind,'DERIVED_TECHNICAL');
  assert.equal(a.officialIdentifiers.find(i=>i.name==='stam-id')!.scope,'work');
  assert.equal(p.officialIdentifiers[0].scope,'source-document');
  assert.equal(p.fields.some(f=>f.value==='2025-01-01'),false);
});
test('same official unit identity retains label/text changes and absence without inferring legal effects',()=>{
  const first=observeUnits(xml(article()),source),renumbered=observeUnits(xml(article('2','','Andere tekst.')),{...source,url:'https://official.example/next'});
  const absent=observeUnits(xml('<artikel stam-id="other"><al>Ander artikel</al></artikel>'),source);
  const linked=linkOfficialUnitObservations([first,renumbered,absent]),group=linked.groups.find(g=>g.identity[4]==='official-123')!;
  assert.equal(group.observations.length,2);assert.notDeepEqual(group.observations[0].label,group.observations[1].label);
  assert.deepEqual(group.otherObservations.map(o=>o.status),['NOT_OBSERVED']);
  assert.notEqual(first.units[0].text.sha256,renumbered.units[0].text.sha256);
  assert.equal(linked.unresolved.length,7); // Work containers, paragraphs and lists lack stable work-scoped IDs here.
});
test('duplicate official identities preserve ambiguity and never create a false stable match',()=>{
  const first=observeUnits(xml(article()),source),ambiguous=observeUnits(xml(article()+article('2')),source);
  const group=linkOfficialUnitObservations([first,ambiguous]).groups.find(g=>g.identity[4]==='official-123')!;
  assert.equal(group.observations.length,1);assert.equal(group.otherObservations[0].status,'AMBIGUOUS_IDENTITY');
  assert.equal(group.otherObservations[0].locators.length,2);
});
test('Formex identifiers and documentary layer dates remain document-scoped, not paragraph legal dates',()=>{
  const bytes=Buffer.from('<CONS.ACT><INFO.CONSLEG START.DATE="20250101"/><ARTICLE IDENTIFIER="001"><TI.ART>Article 1</TI.ART><PARAG IDENTIFIER="001.001"><ALINEA>English text.</ALINEA></PARAG></ARTICLE></CONS.ACT>');
  const snapshot=observeUnits(bytes,{jurisdiction:'EU',documentId:'02016R0679-20250101',url:'https://official.example/formex',member:'law.xml',containerSha256:'a'.repeat(64)});
  assert.equal(snapshot.documentaryLayers[0].attributes['START.DATE'],'20250101');
  assert(snapshot.units.every(u=>u.legalDates==='UNRESOLVED'&&u.officialIdentifiers.every(i=>i.scope==='source-document')));
  assert.equal(linkOfficialUnitObservations([snapshot,snapshot]).groups.length,0);
  assert.equal(snapshot.units[1].parentId,snapshot.units[0].technicalId);
});
test('history absence checks keep work, element and duplicate-identity scopes separate',()=>{
  const first=observeUnits(xml(article()),source),otherWork={...source,documentId:'BWBR0002638'};
  const second=observeUnits(Buffer.from(xml(article()).toString().replace('BWBR0009616',otherWork.documentId)),otherWork);
  const changed=observeUnits(xml('<lid stam-id="official-123"><al>Andere structuur.</al></lid>'+article()+article('2')),source);
  const linked=linkOfficialUnitObservations([first,second,changed]);
  const group=linked.groups.find(g=>g.identity[1]===source.documentId&&g.identity[2]==='artikel'&&g.identity[4]==='official-123')!;
  assert.deepEqual(group.observations.map(o=>o.snapshot),[0]);
  assert.deepEqual(group.otherObservations.map(o=>[o.snapshot,o.status,o.locators.length]),[[2,'AMBIGUOUS_IDENTITY',2]]);
  const foreign=linked.groups.find(g=>g.identity[1]===otherWork.documentId)!;
  assert.deepEqual(foreign.observations.map(o=>o.snapshot),[1]);assert.deepEqual(foreign.otherObservations,[]);
  const paragraph=linked.groups.find(g=>g.identity[1]===source.documentId&&g.identity[2]==='lid')!;
  assert.deepEqual(paragraph.otherObservations.map(o=>[o.snapshot,o.status,o.locators.length]),[[0,'NOT_OBSERVED',0]]);
});
test('many missing official identities require bounded source scans without inventing repeal',()=>{
  const count=1000,snapshots=['before','after'].map(prefix=>observeUnits(xml(Array.from({length:count},(_v,i)=>
    `<artikel stam-id="${prefix}-${i}"><al>Brontekst.</al></artikel>`).join('')),source));
  let identifierReads=0;const rows=snapshots.flatMap(snapshot=>snapshot.units);
  for(const unit of rows){const identifiers=unit.officialIdentifiers;Object.defineProperty(unit,'officialIdentifiers',{
    enumerable:true,get(){identifierReads++;return identifiers;}});}
  const result=linkOfficialUnitObservations(snapshots);
  assert.equal(result.groups.length,count*2);
  assert(result.groups.every(group=>group.otherObservations.length===1&&group.otherObservations[0].status==='NOT_OBSERVED'));
  assert(identifierReads<=rows.length*8,`Repeated whole-snapshot scans: ${identifierReads} identifier reads for ${rows.length} units`);
  assert(snapshots.every(snapshot=>snapshot.units.every(unit=>unit.legalStatus==='UNRESOLVED'&&unit.legalDates==='UNRESOLVED')));
});
test('unsafe XML or another work cannot be used to make unit observations',()=>{
  assert.throws(()=>observeUnits(xml(article()),{...source,documentId:'BWBR0000001'}),/identity/);
  assert.throws(()=>observeUnits(Buffer.from('<!DOCTYPE toestand><toestand bwb-id="BWBR0009616"/>'),source),/Unsafe/);
  assert.throws(()=>observeUnits(Buffer.from('<toestand>'),source),/invalid/);
});
test('WTI retains pending, future, work-level and unmatched unit assertions with their own evidence',()=>{
  const bytes=Buffer.from('<wetstechnische-informatie bwb-id="BWBR0009616"><wijzigingen><regeling><datum waarde="2025-01-01"><details><betreft>wijziging</betreft></details></datum></regeling>'+
    '<regelingelement label-id="paragraph-2" groep="lid" label="tweede lid"><datum waarde="2037-01-01"><details><betreft>Aanhangig</betreft><ontstaansbron><bron><dossiernummer>123</dossiernummer></bron></ontstaansbron></details></datum></regelingelement>'+
    '<regelingelement label-id="unmatched"><datum><details><betreft>onbekend</betreft></details></datum></regelingelement></wijzigingen></wetstechnische-informatie>');
  const history=observeWti(bytes,source,{from:'2025-01-01',to:'2026-10-17'}),snapshot=observeUnits(xml(article()),source);
  assert.deepEqual(history.events.map(e=>e.windowRelation),['WITHIN_WINDOW','AFTER_WINDOW','UNRESOLVED']);
  assert.equal(history.events[0].scope,'work');assert.equal(history.events[1].nativeLabel!.value,'Aanhangig');
  assert(history.events.every(e=>e.legalEffect==='UNRESOLVED'));
  assert.match(history.events[1].fields.find(f=>f.value==='123')!.locator,/ontstaansbron\[1\]\/bron\[1\]\/dossiernummer\[1\]\/text\(\)/);
  const correlations=correlateWtiUnits(history,[snapshot]);
  assert.deepEqual(correlations.map(c=>c.status),['UNRESOLVED','EXACT_SOURCE_LABEL_ID','UNRESOLVED']);
  assert.equal(correlations[1].matches[0].unit,snapshot.units.find(u=>u.element==='lid')!.technicalId);
  assert.equal(snapshot.units.find(u=>u.element==='lid')!.legalDates,'UNRESOLVED');
});
test('WTI XML newline normalization changes derived text only, retaining the exact source SHA-256',()=>{
  const bytes=Buffer.from('<wetstechnische-informatie bwb-id="BWBR0009616"><wijzigingen><regeling><datum><details><betreft>Regel\r\nregel</betreft></details></datum></regeling></wijzigingen></wetstechnische-informatie>');
  const history=observeWti(bytes,source,{from:'2025-01-01',to:'2026-10-17'});
  assert.equal(history.events[0].nativeLabel!.value,'Regel\nregel');assert.equal(history.source.sha256,hash(bytes));
  assert(bytes.includes(Buffer.from('\r\n')));
});
test('XML attribute whitespace follows XML rules while character references and CDATA text retain their values',()=>{
  const bytes=xml('<artikel label-id="a\tb\r\nc&#10;d"><al><![CDATA[<span title="a\tb">text</span>]]></al></artikel>');
  const snapshot=observeUnits(bytes,source),unit=snapshot.units.find(u=>u.element==='artikel')!;
  assert.equal(unit.attributes['label-id'],'a b c\nd');
  assert.equal(unit.text.sha256,hash(Buffer.from('<span title="a\tb">text</span>')));
  assert.equal(snapshot.source.sha256,hash(bytes));
  const wti=Buffer.from('<wetstechnische-informatie bwb-id="BWBR0009616"><wijzigingen><regelingelement label-id="a\tb&#10;c"><datum waarde="2025-01-01"><details><betreft>nieuw</betreft></details></datum></regelingelement></wijzigingen></wetstechnische-informatie>');
  assert.equal(observeWti(wti,source,{from:'2025-01-01',to:'2026-10-18'}).events[0].unitReference!.labelId,'a b\nc');
});
test('WTI state labels and version IDs retain their own datum context even when its date is absent',()=>{
  const bytes=Buffer.from('<wetstechnische-informatie bwb-id="BWBR0009616"><wijzigingen><regelingelement label-id="paragraph-2">'+
    '<datum waarde="2025-01-01" label="Artikel 1" versie-id="source-v1"><details><betreft>nieuw</betreft></details></datum>'+
    '<datum label="Artikel 2" versie-id="source-v2"><details><betreft>vernummering</betreft></details></datum>'+
    '</regelingelement></wijzigingen></wetstechnische-informatie>');
  const events=observeWti(bytes,source,{from:'2025-01-01',to:'2026-10-18'}).events;
  assert.deepEqual(events.map(e=>e.state!.attributes['versie-id']),['source-v1','source-v2']);
  assert.deepEqual(events.map(e=>e.state!.attributes.label),['Artikel 1','Artikel 2']);
  assert.equal(events[1].date,null);assert.equal(events[1].legalEffect,'UNRESOLVED');
  assert.match(events[1].state!.fields.find(f=>f.name==='versie-id')!.locator,/datum\[2\]\/@versie-id$/);
  assert.equal(events[1].unitReference!.label,null,'The state label is not silently assigned to a different parent field');
});
test('WTI version matches are explicit indexes and never silently replace broader label-only evidence',()=>{
  const first=observeUnits(xml(article('1','label-id="article-1" versie-id="v1"')),source);
  const second=observeUnits(xml(article('2','label-id="article-1" versie-id="v2"')),source);
  const history=observeWti(Buffer.from('<wetstechnische-informatie bwb-id="BWBR0009616"><wijzigingen><regelingelement label-id="article-1"><datum versie-id="v2"><details><betreft>vernummering</betreft></details></datum><datum versie-id="unobserved"><details><betreft>nieuw</betreft></details></datum></regelingelement></wijzigingen></wetstechnische-informatie>'),source,{from:'2025-01-01',to:'2026-10-18'});
  const results=correlateWtiUnits(history,[first,second]);
  assert.equal(results[0].matches.length,2);assert.deepEqual(results[0].versionMatchIndexes,[1]);
  assert.equal(results[1].matches.length,2);assert.deepEqual(results[1].versionMatchIndexes,[]);
  assert(history.events.every(event=>event.legalEffect==='UNRESOLVED'));
});
test('WTI references to document structure resolve to actual nodes rather than inline cross-references',()=>{
  const snapshot=observeUnits(xml('<hoofdstuk label-id="chapter" versie-id="v1"><kop><nr>1</nr></kop>'+article()+
    '<intref label-id="chapter">verwijzing</intref></hoofdstuk>'),source);
  const chapter=snapshot.units.find(unit=>unit.element==='hoofdstuk')!,provision=snapshot.units.find(unit=>unit.element==='artikel')!;
  assert.equal(provision.parentId,chapter.technicalId);assert.equal(snapshot.units.some(unit=>unit.element==='intref'),false);
  const wti=observeWti(Buffer.from('<wetstechnische-informatie bwb-id="BWBR0009616"><wijzigingen><regelingelement label-id="chapter"><datum versie-id="v1"><details><betreft>vernummering</betreft></details></datum></regelingelement></wijzigingen></wetstechnische-informatie>'),source,{from:'2025-01-01',to:'2026-10-18'});
  const [match]=correlateWtiUnits(wti,[snapshot]);assert.equal(match.matches.length,1);
  assert.equal(match.matches[0].unit,chapter.technicalId);assert.deepEqual(match.versionMatchIndexes,[0]);
});
test('qualified XML attributes retain source prefixes while namespace declarations are not attribute assertions',()=>{
  const bytes=Buffer.from('<toestand bwb-id="BWBR0009616"><wetgeving xml:lang="nl" xmlns:p="urn:source" p:status="observed"><artikel stam-id="1"/></wetgeving></toestand>');
  const snapshot=observeUnits(bytes,source),work=snapshot.units.find(unit=>unit.element==='wetgeving')!;
  assert.equal(work.attributes['xml:lang'],'nl');assert.equal(work.attributes['p:status'],'observed');
  assert.equal(work.attributes['xmlns:p'],undefined);assert.equal(work.fields.some(field=>field.locator==='@xmlns:p'),false);
  assert.equal(snapshot.units.find(unit=>unit.element==='artikel')!.attributes['xml:lang'],undefined);
  assert.equal(snapshot.source.sha256,hash(bytes));
});
