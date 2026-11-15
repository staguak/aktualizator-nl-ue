import test from 'node:test';
import assert from 'node:assert/strict';
import {zipSync} from 'fflate';
import {formexInfo,OfficialSources,loadSourceArchive} from './official-sources.js';
import {auditUnitFields,auditFormexPackage} from './independent-audit.js';
import {hash} from './release-store.js';

const pack=(files:Record<string,string>)=>Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([n,v])=>[n,Buffer.from(v)]))));
const consolidated=(language='EN')=>`<CONS.ACT><INFO.CONSLEG CONSLEG.REF="2019L1152" START.DATE="20190711"/><CONS.DOC><BIB.INSTANCE><LG.DOC>${language}</LG.DOC></BIB.INSTANCE><ARTICLE IDENTIFIER="1"><TI.ART>Article 1</TI.ART><PARAG><ALINEA>Full text.</ALINEA></PARAG></ARTICLE></CONS.DOC></CONS.ACT>`;
test('consolidated language comes from its own bibliography, including CL names followed by digits',()=>{
  const info=formexInfo(pack({'CL2019L1152EN0000020.0001.xml':consolidated()}),'02019L1152-20190711',null,'EN');
  assert.equal(info.root,'CONS.ACT');assert.equal(info.documents[0].languageEvidence[0].value,'EN');
});
test('filename and quoted-language hints cannot override a mismatched own document language or layer',()=>{
  const bytes=pack({'CL2019L1152EN0000020.0001.xml':consolidated('FR').replace('</ARTICLE>','<QUOT.S><BIB.INSTANCE><LG.DOC>EN</LG.DOC></BIB.INSTANCE></QUOT.S></ARTICLE>')});
  assert.throws(()=>formexInfo(bytes,'02019L1152-20190711',null,'EN'),/language/i);
  assert.throws(()=>formexInfo(pack({'CL2019L1152EN0000020.0001.xml':consolidated()}),'02019L1152-20250101',null,'EN'),/layer/i);
});
for(const root of ['CJT','CASE','CONCLUSION','JUDGMENT'])test(`${root} preserves its own document type, hierarchy, numbered paragraphs and tables`,()=>{
  const celex=root==='CONCLUSION'?'62023CC0019':root==='CJT'?'62023CA0019':root==='CASE'?'62023CJ0019_RES':'62023CJ0019';
  const bytes=pack({[`ECR_${celex}_EN_01.xml`]:`<${root}><BIB.CASE><NO.CELEX>${celex}</NO.CELEX><LG.DOC>EN</LG.DOC></BIB.CASE><CONTENTS><GR.SEQ><NP.ECR IDENTIFIER="p1"><NO.P>1</NO.P><TXT>Paragraph one.</TXT></NP.ECR><TBL><ROW><CELL><P>Table text.</P></CELL></ROW></TBL></GR.SEQ></CONTENTS></${root}>`});
  const info=formexInfo(bytes,celex,null,'EN'),s=info.unitHistory[0];
  assert.equal(info.root,root);assert.equal(s.root,root);assert.equal(s.profile,'unit-formex-observations-v1');
  assert(s.units.some(u=>u.element==='NP.ECR'));assert(s.units.some(u=>u.element==='TBL'));
  assert(s.units.some(u=>u.element==='CELL'));assert.equal(s.units[0].element,root);
  const archive=new OfficialSources('EU',celex,{from:'2025-01-01',to:'2026-11-15',observedOn:'2026-11-15'});
  archive.add('document.fmx4.zip',{bytes,url:'https://publications.europa.eu/resource/example',contentType:'application/zip'},'https://publications.europa.eu/resource/example','CELLAR-Formex4',info);
  const built=archive.build('01_'+celex+'.sources.zip');
  const restored=loadSourceArchive(built.bytes,built.metadata,'EU',celex).index.entries[0].metadata;
  assert.deepEqual(restored.unitHistory.map(({unitEncoding:_encoding,...snapshot}:any)=>snapshot),info.unitHistory);
});
test('a different explicit CELEX in a judicial bibliography is rejected',()=>{
  assert.throws(()=>formexInfo(pack({'ECR_62023CJ0019_EN_01.xml':'<JUDGMENT><BIB.JUDGMENT><NO.CELEX>62020CJ0426</NO.CELEX></BIB.JUDGMENT><P>Text</P></JUDGMENT>'}),'62023CJ0019',null,'EN'),/identity/i);
});
test('a court notice from another case cannot qualify using an expected language filename',()=>{
  assert.throws(()=>formexInfo(pack({'C_202600132EN.xml':'<CJT><BIB.INSTANCE><NO.CASE>C-426/20</NO.CASE><LG.DOC>EN</LG.DOC></BIB.INSTANCE><P>Notice</P></CJT>'}),'62023CA0019',null,'EN'),/case identity/i);
});
const annexFiles=()=>({
  'main.xml':'<ACT><BIB.INSTANCE><DOCUMENT.REF FILE="main.doc.xml"/><LG.DOC>EN</LG.DOC></BIB.INSTANCE><ARTICLE IDENTIFIER="1"><PARAG>Act.</PARAG></ARTICLE></ACT>',
  'main.doc.xml':'<DOC><FMX><DOC.MAIN.PUB><REF.PHYS TYPE="DOC.XML" FILE="main.xml"/></DOC.MAIN.PUB><DOC.SUB.PUB TYPE="ANNEX"><REF.PHYS TYPE="DOC.XML" FILE="annex-z.xml"/></DOC.SUB.PUB><DOC.SUB.PUB TYPE="ANNEX"><REF.PHYS TYPE="DOC.XML" FILE="annex-a.xml"/></DOC.SUB.PUB></FMX></DOC>',
  'annex-a.xml':'<ANNEX IDENTIFIER="II"><BIB.INSTANCE><DOCUMENT.REF FILE="main.doc.xml"/><LG.DOC>EN</LG.DOC></BIB.INSTANCE><P>Second annex.</P></ANNEX>',
  'annex-z.xml':'<ANNEX IDENTIFIER="I"><BIB.INSTANCE><DOCUMENT.REF FILE="main.doc.xml"/><LG.DOC>EN</LG.DOC></BIB.INSTANCE><TBL><ROW><CELL><P>First annex.</P></CELL></ROW></TBL></ANNEX>'
});
test('separate annexes follow official DOC order and retain owner, member, locator and original hash',()=>{
  const files=annexFiles(),bytes=pack(files),info=formexInfo(bytes,'32019L1152',null,'EN');
  assert.deepEqual(info.unitHistory.map(s=>s.source.member),['main.xml','annex-z.xml','annex-a.xml']);
  assert.deepEqual(info.attachments.map(a=>a.member),['annex-z.xml','annex-a.xml']);
  assert(info.attachments.every(a=>a.parentMember==='main.xml'&&a.catalogueMember==='main.doc.xml'&&a.locator.endsWith('/@FILE')));
  assert.equal(info.attachments[0].sha256,hash(Buffer.from(files['annex-z.xml'])));
  const annex=info.unitHistory[1];assert(annex.units.some(u=>u.element==='ANNEX'));assert(annex.units.some(u=>u.element==='TBL'));
  const check=auditUnitFields({bytes:Buffer.from(files['annex-z.xml']).toString('base64'),snapshot:annex});
  assert.equal(check.status,0,check.stderr);
  const damaged=structuredClone(annex);damaged.units=damaged.units.filter(u=>u.element!=='CELL');
  assert.notEqual(auditUnitFields({bytes:Buffer.from(files['annex-z.xml']).toString('base64'),snapshot:damaged}).status,0);
  const metadata={...info,celex:'32019L1152',language:'EN'};
  const checked=auditFormexPackage({bytes:bytes.toString('base64'),metadata});assert.equal(checked.status,0,checked.stderr);
  const changed=structuredClone(metadata);changed.attachments[0].locator=changed.attachments[1].locator;
  assert.notEqual(auditFormexPackage({bytes:bytes.toString('base64'),metadata:changed}).status,0);
});
test('nested included annexes and GENERAL fragments are indexed once while every inclusion occurrence is retained',()=>{
  const files=annexFiles();
  files['annex-z.xml']=files['annex-z.xml'].replace('</ANNEX>','<INCL.ELEMENT TYPE="FORMEX.DOC" FILEREF="fragment.xml"/><INCL.ELEMENT TYPE="FORMEX.DOC" FILEREF="fragment.xml"/></ANNEX>');
  const bytes=pack({...files,'fragment.xml':'<GENERAL><P>Included original.</P></GENERAL>'}),info=formexInfo(bytes,'32019L1152',null,'EN');
  assert.equal(info.fragments.length,1);assert.equal(info.fragments[0].references.length,2);
  assert.equal(info.fragments[0].parentMember,'annex-z.xml');
  assert.deepEqual(info.unitHistory.map(s=>s.source.member),['main.xml','annex-z.xml','fragment.xml','annex-a.xml']);
  const good=auditFormexPackage({bytes:bytes.toString('base64'),metadata:{...info,celex:'32019L1152',language:'EN'}});assert.equal(good.status,0,good.stderr);
  const changed=structuredClone(info);changed.fragments[0].references.pop();
  assert.notEqual(auditFormexPackage({bytes:bytes.toString('base64'),metadata:{...changed,celex:'32019L1152',language:'EN'}}).status,0);
  const cycle={...files,'fragment.xml':'<GENERAL><INCL.ELEMENT TYPE="FORMEX.DOC" FILEREF="annex-z.xml"/></GENERAL>'};
  assert.throws(()=>formexInfo(pack(cycle),'32019L1152',null,'EN'),/Cyclic/);
});
test('DOC.MAIN.PUB identifies the main GENERAL document even when an associated GENERAL is first in the ZIP',()=>{
  const bytes=pack({'associated.xml':'<GENERAL><P>Associated text.</P></GENERAL>',
    'main.doc.xml':'<DOC><FMX><DOC.MAIN.PUB><REF.PHYS TYPE="DOC.XML" FILE="main.xml"/></DOC.MAIN.PUB><DOC.SUB.PUB TYPE="ASSOCIATION"><REF.PHYS TYPE="DOC.XML" FILE="associated.xml"/></DOC.SUB.PUB></FMX></DOC>',
    'main.xml':'<GENERAL><BIB.INSTANCE><DOCUMENT.REF FILE="main.doc.xml"/><LG.DOC>EN</LG.DOC></BIB.INSTANCE><P>Main text.</P></GENERAL>'});
  const info=formexInfo(bytes,'12012P/TXT',null,'EN');
  assert.deepEqual(info.documents.map(d=>d.member),['main.xml']);
  assert.deepEqual(info.unitHistory.map(s=>s.source.member),['main.xml','associated.xml']);
  const checked=auditFormexPackage({bytes:bytes.toString('base64'),metadata:{...info,celex:'12012P/TXT',language:'EN'}});assert.equal(checked.status,0,checked.stderr);
});
test('an orphan annex, an unlisted annex and an omitted referenced annex cannot qualify as a complete package',()=>{
  assert.throws(()=>formexInfo(pack({'only.xml':'<ANNEX><P>Orphan</P></ANNEX>'}),'32019L1152'),/document/i);
  const missing=annexFiles();delete (missing as Record<string,string>)['annex-z.xml'];
  assert.throws(()=>formexInfo(pack(missing),'32019L1152'),/missing|annex/i);
  const unlisted=annexFiles();unlisted['main.doc.xml']=unlisted['main.doc.xml'].replace('<DOC.SUB.PUB TYPE="ANNEX"><REF.PHYS TYPE="DOC.XML" FILE="annex-z.xml"/></DOC.SUB.PUB>','');
  assert.throws(()=>formexInfo(pack(unlisted),'32019L1152'),/annex/i);
});
