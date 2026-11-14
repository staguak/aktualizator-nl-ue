import test from 'node:test';
import assert from 'node:assert/strict';
import {load} from 'cheerio';
import {parseNlLegalStructure} from './nl-legal-structure.js';
import {indexLegalDocument,validateLegalDocument,legalPartName,legalHash} from './legal-structure.js';
import type {LegalContext} from './legal-structure.js';
const image='data:image/png;base64,iVBORw0KGgo=';
const source=`<toestand bwb-id="BWBR0000001" inwerkingtreding="2025-01-01"><wetgeving>
 <intitule>Complete test law</intitule><meta-data><jci>Metadata remains in the original.</jci></meta-data>
 <aanhef><al>We approve this law.</al></aanhef><wet-besluit><wettekst>
 <hoofdstuk nr="1" stam-id="chapter-one"><kop><label>Hoofdstuk</label> <nr>1</nr> <titel>General</titel></kop>
 <artikel nr="1" stam-id="article-one"><kop><label>Artikel</label> <nr>1</nr></kop><lid nr="1"><al>First <nadruk type="vet">complete</nadruk> provision <extref doc="https://official.example/other">with reference</extref>.</al></lid>
 <lid nr="2"><al>Second paragraph <nootref refid="note-one">(1)</nootref>.</al></lid><noot id="note-one"><al>Full footnote.</al></noot></artikel>
 <artikel nr="2" stam-id="article-two"><al>Entire additional article.</al></artikel></hoofdstuk>
 <bijlage id="annex-one"><kop><label>Bijlage</label> <nr>I</nr></kop><al>Annex text.</al>
 <table><tgroup cols="2"><colspec colname="c1"/><colspec colname="c2"/><tbody><row><entry namest="c1" nameend="c2" morerows="1">Combined cell</entry></row><row/></tbody></tgroup></table>
 <plaatje url="${image}" alt="original illustration"/></bijlage>
 </wettekst></wet-besluit><wetsluiting><al>Final official closing.</al></wetsluiting></wetgeving></toestand>`;
const context:LegalContext={corpus:'NL',documentId:'BWBR0000001',version:'2025-01-01',language:'NL',sourceUrl:'https://official.example/state.xml',sourceSha256:legalHash(source)};
test('a complete NL version retains preamble, chapter, articles, points, annex, table, note, image and closing',()=>{
  const draft=parseNlLegalStructure(source,context);
  const body=draft.chunks.map(p=>p.body).join(''),$=load(body);
  for(const phrase of ['Complete test law','We approve this law.','First complete provision with reference.','Entire additional article.','Annex text.','Combined cell','Full footnote.','Final official closing.'])assert($('body').text().includes(phrase),phrase);
  assert.equal(draft.units.filter(u=>u.kind==='article').length,2);assert.equal(draft.units.filter(u=>u.kind==='paragraph'&&u.sourceTag==='lid').length,2);
  assert(draft.units.some(u=>u.kind==='preamble'));assert(draft.units.some(u=>u.kind==='annex'));assert(draft.units.some(u=>u.kind==='table'));
  assert.equal($('img').attr('src'),image);assert.equal($('td').attr('colspan'),'2');assert.equal($('td').attr('rowspan'),'2');
  assert.equal($('a[href="https://official.example/other"]').text(),'with reference');assert($('a[href="#note-one"]').length);
  assert(draft.units.find(u=>u.kind==='article')?.officialIdentifiers.some(id=>id.value==='article-one'));
  const names=draft.chunks.map(p=>legalPartName('NL_state',p));
  const manifest=indexLegalDocument(draft,names,draft.chunks.map(p=>p.body));
  assert.equal(validateLegalDocument(manifest,name=>draft.chunks[names.indexOf(name)].body),body);
  const chapter=draft.units.find(u=>u.kind==='chapter')!,article=draft.units.find(u=>u.kind==='article')!;
  assert.equal(article.parentId,chapter.id);
  const articleFiles=new Set(manifest.units.filter(u=>u.kind==='article').map(u=>u.locations[0].file));assert.equal(articleFiles.size,1);
});
test('CALS explicit column positions and occupied row spans retain the original header association',()=>{
  const table='<table><tgroup cols="2"><colspec colname="c1"/><colspec colname="c2"/><thead><row><entry>Required</entry><entry>Forbidden</entry></row></thead><tbody>'+ 
    '<row><entry colname="c2">Substance X</entry></row><row><entry colname="c1" morerows="1">Shared</entry><entry colname="c2">Y</entry></row>'+ 
    '<row><entry colname="c2">Z</entry></row></tbody></tgroup></table>';
  const xml=`<toestand bwb-id="BWBR0000001"><wetgeving><bijlage>${table}</bijlage></wetgeving></toestand>`;
  const draft=parseNlLegalStructure(xml,context),$=load(draft.chunks.map(p=>p.body).join('')),rows=$('tbody tr');
  assert.equal(rows.eq(0).children('td').length,2);assert.equal(rows.eq(0).children('td').eq(0).text(),'');assert.equal(rows.eq(0).children('td').eq(1).text(),'Substance X');
  assert.equal(rows.eq(1).children('td').eq(0).attr('rowspan'),'2');assert.equal(rows.eq(2).children('td').length,1);assert.equal(rows.eq(2).text(),'Z');
  const invalid=xml.replace('colname="c2">Substance','colname="unknown">Substance');
  assert.throws(()=>parseNlLegalStructure(invalid,context),/CALS/);
});
test('long NL articles stay whole and source/version identities are distinct',()=>{
  const large=source.replace('Entire additional article.','Entire additional article. '+'legal text '.repeat(70000));
  const first=parseNlLegalStructure(large,{...context,sourceSha256:legalHash(large)});
  const original=parseNlLegalStructure(source,context);
  assert.equal(first.chunks.length,original.chunks.length);assert(first.chunks.some(p=>p.body.length>700000));
  assert(first.chunks.every(p=>!p.technicalSplit));
  const historical=parseNlLegalStructure(source,{...context,version:'2024-01-01'});
  assert.notEqual(historical.units.find(u=>u.kind==='article')!.id,original.units.find(u=>u.kind==='article')!.id);
});
test('significant preformatted text is unchanged and original identity/malformed input fail closed',()=>{
  const xml=source.replace('Entire additional article.','<pre>first  \n  second\t </pre>');
  const draft=parseNlLegalStructure(xml,{...context,sourceSha256:legalHash(xml)});
  assert.match(draft.chunks.map(p=>p.body).join(''),/first  \n  second\t /);
  assert.throws(()=>parseNlLegalStructure(source,{...context,documentId:'BWBR0000002'}),/identity/);
  assert.throws(()=>parseNlLegalStructure(source.slice(0,-12),context),/XML/);
});
