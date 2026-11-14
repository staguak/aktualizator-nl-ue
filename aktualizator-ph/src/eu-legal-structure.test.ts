import test from 'node:test';
import assert from 'node:assert/strict';
import {load} from 'cheerio';
import {parseEuLegalStructure} from './eu-legal-structure.js';
import {parseEuHtml} from './eu-parser.js';
import {indexLegalDocument,validateLegalDocument,legalHash,legalIndexRows} from './legal-structure.js';

const context={corpus:'EU' as const,documentId:'32024R0001',version:'32024R0001',language:'EN',sourceUrl:'https://publications.europa.eu/example.xhtml',sourceSha256:'a'.repeat(64)};
test('successive annexes stay siblings, complete articles stay together in their chapter, and the version reconstructs exactly',()=>{
  const html='<html lang="en"><head><title>Regulation</title></head><body><p>Regulation title</p><p>Whereas:</p><p>(1) Recital.</p>'+
    '<p>CHAPTER I</p><p class="oj-ti-art">Article 1</p><p>First paragraph.</p><p class="oj-ti-art">Article 2</p><p>'+ 'Legal content. '.repeat(55000)+'</p>'+
    '<p>ANNEX I</p><p>First annex.</p><table><tr><td rowspan="2">Table.</td><td>A</td></tr><tr><td>B</td></tr></table>'+
    '<p>ANNEX II</p><p>Second annex.</p><p>ANNEX III</p><p>Third annex.</p></body></html>';
  const draft=parseEuLegalStructure(html,{...context,sourceSha256:legalHash(html)}),annexes=draft.units.filter(u=>u.kind==='annex');
  assert.equal(annexes.length,3);assert(annexes.every(u=>u.parentId===draft.units[0].id));
  const articles=draft.units.filter(u=>u.kind==='article');assert.deepEqual(articles.map(a=>a.reference),['1','2']);
  const chapter=draft.units.find(u=>u.kind==='chapter')!;assert(articles.every(a=>a.parentId===chapter.id));
  const manifest=indexLegalDocument(draft,draft.chunks.map((_,i)=>`p${i}.md`),draft.chunks.map(c=>c.body));
  assert.equal(manifest.units.find(u=>u.id===articles[0].id)!.locations[0].file,manifest.units.find(u=>u.id===articles[1].id)!.locations[0].file);
  assert(manifest.parts.some(p=>p.characters>700000));
  assert.equal(validateLegalDocument(manifest,name=>draft.chunks[Number(name.slice(1,-3))].body),draft.chunks.map(c=>c.body).join(''));
  assert.equal(draft.units.filter(u=>u.kind==='table').length,1);
});
test('CSS whitespace selectors retain their containing elements and original preformatted bytes',()=>{
  for(const [selector,attrs]of [['#kept','id="kept"'],['div[data-literal]','data-literal="yes"'],['div','class="ordinary"']]){
    const html=`<head><style>${selector}{white-space:pre}</style></head><body><div ${attrs}>first  second\n third</div></body>`;
    const draft=parseEuLegalStructure(html,context),$=load(draft.chunks.map(p=>p.body).join(''));
    assert.equal($(selector).text(),'first  second\n third');
  }
});
test('older court numbered paragraphs are primary indexed units alongside modern table paragraphs',()=>{
  const html='<body><p class="C01Pointnumerote"><a name="point1">1</a> First full court paragraph.</p>'+
    '<p class="C01Pointnumerote"><a name="point2">2</a> Second full court paragraph.</p></body>';
  const draft=parseEuLegalStructure(html,{...context,documentId:'62023CJ0019',version:'62023CJ0019'});
  assert.deepEqual(draft.units.filter(u=>u.reference).map(u=>u.reference),['1','2']);
  assert.equal(legalIndexRows(indexLegalDocument(draft,['case.md'],draft.chunks.map(p=>p.body))).length,2);
});
test('ordered lists retain source numbering instead of silently renumbering legal conditions',()=>{
  const html='<body><p>Article 1</p><ol type="a" start="3" reversed><li value="5">Condition</li><li>Exception</li></ol></body>';
  const draft=parseEuLegalStructure(html,context),$=load(draft.chunks.map(p=>p.body).join(''));
  assert.equal($('ol').attr('type'),'a');assert.equal($('ol').attr('start'),'3');assert($('ol').is('[reversed]'));assert.equal($('li').first().attr('value'),'5');
});
test('ELI article title and paragraph IDs do not create duplicate articles',()=>{
  const html='<body><div class="eli-subdivision" id="art_1"><p>Artikel 1</p><div class="eli-title" id="art_1.tit_1"><p>Purpose</p></div><div id="art_1.par_1"><p>1. Full paragraph.</p></div></div>'+
    '<div class="eli-subdivision" id="art_2"><p>Artikel 2</p><p>Other full article.</p></div></body>';
  const draft=parseEuLegalStructure(html,{...context,language:'NL'});
  assert.deepEqual(draft.units.filter(u=>u.kind==='article').map(u=>u.reference),['1','2']);
});
test('numbered court paragraphs include their whole table and quoted recitals do not become a case preamble',()=>{
  const html='<body><p>Judgment</p><table><tr><td><p class="coj-count" id="point1">1.</p></td><td><p>First complete court paragraph.</p><p>(1) Quoted recital.</p></td></tr></table>'+
    '<table><tr><td><p class="coj-count" id="point2">2.</p></td><td><p>Second complete court paragraph.</p></td></tr></table></body>';
  const draft=parseEuLegalStructure(html,{...context,documentId:'62023CJ0019',version:'62023CJ0019'});
  const points=draft.units.filter(u=>u.reference);assert.deepEqual(points.map(p=>p.reference),['1','2']);
  assert.equal(draft.units.filter(u=>u.kind==='preamble'||u.kind==='recital').length,0);
  assert.equal(draft.units.filter(u=>u.kind==='table').length,2);
  const manifest=indexLegalDocument(draft,draft.chunks.map((_,i)=>`p${i}.md`),draft.chunks.map(c=>c.body));
  assert(manifest.units.find(u=>u.id===points[0].id)!.locations.length===1);
  assert.equal(legalIndexRows(manifest).length,2);
});
test('public parser uses the structural profile while retaining language and source-page rejection',()=>{
  const html='<html lang="en"><body><p>Regulation</p><p>Article 1</p><p>'+ 'Full legal text. '.repeat(100)+'</p></body></html>';
  const parsed=parseEuHtml(html,context.sourceUrl,'full-document','EN',context);
  assert.equal(parsed.legalDraft?.profile,'legal-structure-v1');assert.equal(parsed.articleCount,1);
  assert.throws(()=>parseEuHtml(html,context.sourceUrl,'full-document','PL',context),/language/);
  assert.throws(()=>parseEuHtml('<body>Access Denied</body>',context.sourceUrl,'full-document','EN',context),/challenge/);
});
