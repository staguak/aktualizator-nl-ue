import test from 'node:test';
import assert from 'node:assert/strict';
import {assertEuSourceIdentity} from './eu-source-identity.js';
import type {CellarIndex} from './eu-provider.js';

const celex='32024R0001';
const sourceUrl='https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32024R0001';
const html=(title:string,head='')=>`<html><head><title>${title}</title>${head}</head><body><p>Official text</p></body></html>`;
const meta=(id:string)=>`<meta name="dc.identifier" content="${id}">`;

test('EUR-Lex XHTML identity accepts the same CELEX with all configured language suffixes',()=>{
  for(const ending of [' - EN','-PL',' - NL',' - fr',' - en',' - FR']){
    assert.doesNotThrow(()=>assertEuSourceIdentity(html('EUR-Lex - '+celex+ending),sourceUrl,celex),ending);
  }
  assert.doesNotThrow(()=>assertEuSourceIdentity(html(celex),sourceUrl,celex));
  assert.doesNotThrow(()=>assertEuSourceIdentity(html(sourceUrl+' - EN'),sourceUrl,celex));
});

test('identity verification rejects another CELEX even when matching metadata is present',()=>{
  assert.throws(()=>assertEuSourceIdentity(
    html('EUR-Lex - 32025R0002 - EN',meta(celex)),sourceUrl,celex),/identity mismatch/);
  assert.throws(()=>assertEuSourceIdentity(
    html('EUR-Lex - '+celex+' - NL',meta('32025R0002')),sourceUrl,celex),/identity mismatch/);
});

test('malformed XHTML title is not an independent CELEX identity',()=>{
  assert.throws(()=>assertEuSourceIdentity(html('EUR-Lex - unrelated page - EN'),sourceUrl,celex),
    /no independently confirmed document identity/);
  assert.doesNotThrow(()=>assertEuSourceIdentity(
    html('EUR-Lex - unrelated page - EN',meta(celex)),sourceUrl,celex));
});

test('long malformed language suffix does not bypass identity validation',()=>{
  const whitespace=' '.repeat(40_000);
  const bad=html('EUR-Lex - 32025R0002'+whitespace+'-PL',meta(celex));
  assert.throws(()=>assertEuSourceIdentity(bad,sourceUrl,celex),/identity mismatch/);
  const unknown=html('EUR-Lex - '+celex+whitespace+'-ZZ');
  assert.throws(()=>assertEuSourceIdentity(unknown,sourceUrl,celex),/no independently confirmed document identity/);
  const good=html('EUR-Lex - '+celex+whitespace+'-PL');
  assert.doesNotThrow(()=>assertEuSourceIdentity(good,sourceUrl,celex));
});

test('CELLAR item must remain bound to a permitted XHTML representation',()=>{
  const item='https://publications.europa.eu/resource/cellar/01234567-89ab-cdef-0123-456789abcdef/record.xht';
  const index={rows:[{item,format:'xhtml'}]} as CellarIndex;
  const page=html('Technical source',meta(celex));
  assert.doesNotThrow(()=>assertEuSourceIdentity(page,item,celex,index));
  assert.throws(()=>assertEuSourceIdentity(page,item,celex),/not bound/);
  const pdfOnly={rows:[{item,format:'pdf'}]} as CellarIndex;
  assert.throws(()=>assertEuSourceIdentity(page,item,celex,pdfOnly),/not bound/);
});

test('consolidated version retains its separate CELEX and documentary date',()=>{
  const layer='02024R0001-20240605';
  const url='https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A'+layer;
  const title='Consolidated TEXT: 32024R0001 — EN — 05.06.2024';
  assert.doesNotThrow(()=>assertEuSourceIdentity(html(title),url,layer));
  assert.throws(()=>assertEuSourceIdentity(html(title),sourceUrl,celex),/identity mismatch/);
});
