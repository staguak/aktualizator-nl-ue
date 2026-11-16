import test from 'node:test';
import assert from 'node:assert/strict';
import {scanNlVersions} from './nl-final-parser.js';
import {observationXml} from './unit-observations.js';
import {assertEuSourceIdentity} from './eu-source-identity.js';

test('NL version scanner retains exact canonical source bytes and references',()=>{
  const body='### V=2025-01-01 – open\n\n<!-- NL source text -->\n<p>Legal text\nwith spacing</p>\n<!-- /NL source text -->\n\nŹródła: [^S1]\n';
  const versions=scanNlVersions(body);
  assert.deepEqual(versions.map(v=>v.slice(1)),[
    ['2025-01-01','open','<p>Legal text\nwith spacing</p>','[^S1]'],
  ]);
  assert.deepEqual(scanNlVersions(body.replace('<!-- /NL source text -->','<!-- bad -->')),[]);
});

test('XML tokenizer preserves comments, CDATA, PI, entities, and tag structure',()=>{
  const xml='<?xml version="1.0"?>\r\n<root a="x\t y\r\n z" b=\'p\tq\'>\n'+
    '<!-- attr="keep\tunchanged" -->\n<![CDATA[<x attr="a\tb">]]>\n'+
    '<child x="&#10;\t"/>text</root>';
  const actual=observationXml(xml);
  assert.ok(actual.includes('a="x  y  z"'));
  assert.ok(actual.includes("b='p q'"));
  assert.ok(actual.includes('<!-- attr="keep\tunchanged" -->'));
  assert.ok(actual.includes('<![CDATA[<x attr="a\tb">]]>'));
  assert.ok(actual.includes('x="&#10; "'));
  assert.ok(actual.includes('text</root>'));
});

test('EU consolidated titles bind unambiguously to original CELEX and version date',()=>{
  const expected='02020R0001-20200101';
  const html='<html><head><title>Consolidated TEXT: 32020R0001 — EN — 01.01.2020</title></head><body></body></html>';
  assert.doesNotThrow(()=>assertEuSourceIdentity(html,
    'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:'+expected, expected));
  assert.throws(()=>assertEuSourceIdentity(html,
    'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:'+expected, '02020R0002-20200101'),
    /identity mismatch/);
});
