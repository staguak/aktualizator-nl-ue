import test from 'node:test';
import fs from 'node:fs';
import {parseEuLegalStructure} from './eu-legal-structure.js';
import {legalHash,indexLegalDocument,validateLegalDocument} from './legal-structure.js';
import assert from 'node:assert/strict';
import {resolveEuNavigation} from './eu-navigation.js';

test('structural navigation rewrites only the requested href without moving logical anchors out of a table unit',()=>{
  const chunk='<table><tbody><tr><!-- legal-unit:unit --><a id="logical-cell"></a><td><a href="#note">Full recital.</a></td><!-- /legal-unit:unit --></tr></tbody></table>';
  const other='<p id="note">Complete note.</p>';
  const result=resolveEuNavigation([chunk,other],['body.md','note.md'],'https://official.example/act',true);
  assert.equal(result.chunks[0],chunk.replace('href="#note"','href="note.md#note"'));
  assert.equal(result.chunks[1],other);
});

test('the complete official table-based 1997 directive retains every indexed anchor through final navigation',()=>{
  const source=fs.readFileSync(new URL('./fixtures/01997L0081-19980525-eng.xhtml',import.meta.url),'utf8');
  const provenance=JSON.parse(fs.readFileSync(new URL('./fixtures/01997L0081-19980525-eng.provenance.json',import.meta.url),'utf8'));
  assert.equal(legalHash(source),provenance.sha256);
  const draft=parseEuLegalStructure(source,{corpus:'EU',documentId:provenance.celex,version:provenance.celex,language:'EN',sourceUrl:provenance.url,sourceSha256:provenance.sha256});
  const names=draft.chunks.map((_,i)=>`part_${i}.md`),resolved=resolveEuNavigation(draft.chunks.map(c=>c.body),names,provenance.url,true);
  const manifest=indexLegalDocument({...draft,sourceFragmentIssues:resolved.navigation.sourceFragmentIssues},names,resolved.chunks);
  assert.equal(validateLegalDocument(manifest,name=>resolved.chunks[names.indexOf(name)]),resolved.chunks.join(''));
});
