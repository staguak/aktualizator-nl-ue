import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { parseEuHtml } from './eu-parser.js';
import { resolveEuNavigation, validateEuNavigation } from './eu-navigation.js';
import { splitEuTable } from './eu-tables.js';
import { assertEuIntegrity, assertIntegrity, fingerprintText, htmlIntegrity, nlOutputIntegrity } from './content-integrity.js';
import { parseBwbXml } from './bwb-parser.js';
import { renderAct } from './render.js';
import { validateOutput, validatePublicationSet } from './publication-validation.js';
import type { ScopeAct, VersionSnapshot } from './types.js';

const url = 'https://publications.europa.eu/resource/celex/32008L0104';
const euAct = {order: 1, celex: '32008L0104', requiredVersions: ['32008L0104']};
const nlAct: ScopeAct = {order: 1, bwbId: 'BWBRTEST', title: 'Testwet', include: {articles: ['1']}, mustIncludeArticles: ['1']};
const nlXml = `<toestand bwb-id="BWBRTEST" inwerkingtreding="2025-01-01"><wetgeving><intitule>Testwet</intitule><artikel nr="1"><al>Een <intref>werknemer</intref> krijgt <nadruk>niet</nadruk> minder dan 12,5%. A &lt; B.</al></artikel></wetgeving></toestand>`;
function nlSnapshot(xml = nlXml, date = '2025-01-01'): VersionSnapshot {
  return {version: {key: date, toestandUrl: 'https://wetten.overheid.nl/BWBRTEST/'+date, validFrom: date, validTo: null}, statute: parseBwbXml(xml)};
}

test('real EU source retains all named destinations and resolves every original local reference', () => {
  const html = fs.readFileSync(new URL('fixtures/32008L0104-nld.html', import.meta.url), 'utf8');
  const parsed = parseEuHtml(html, url);
  const names = parsed.chunks.map((_c, i) => `01_source__${i + 1}.md`);
  const resolved = resolveEuNavigation(parsed.chunks, names, url);
  assert.deepEqual(resolved.navigation.sourceFragmentIssues, []);
  assert.doesNotThrow(() => validateEuNavigation(resolved.chunks, names));
  assertEuIntegrity(parsed.integrity, resolved.chunks.join('\n'));
});

test('cross-part footnotes and return links reach correct files, including images inside links', () => {
  const html = `<html lang="nl"><body><p>Richtlijn <a href="#note">(1)</a></p>`+
    Array.from({length: 41}, (_, i) => `<p id="a${i}">Artikel ${i+1}</p><p>Volledige tekst &lt; 5,0%. ${'inhoud '.repeat(90)}</p>`).join('')+
    `<p>BIJLAGE</p><p id="note">Voetnoot <a href="#a0">terug</a> <a href="#a1"><img src="figure.png" alt="formula"></a></p></body></html>`;
  const parsed = parseEuHtml(html, url), names = parsed.chunks.map((_c, i) => `part_${i}.md`);
  assert.equal(parsed.chunks.length, 2);
  const resolved = resolveEuNavigation(parsed.chunks, names, url);
  assert.match(resolved.chunks[0], /href="part_1.md#note"/);
  assert.match(resolved.chunks[1], /href="part_0.md#a0"/);
  assert.equal(load(resolved.chunks.join('\n'))('img').length, 1);
  assert.deepEqual(resolved.navigation.sourceFragmentIssues, []);
  assertEuIntegrity(parsed.integrity, resolved.chunks.join('\n'));
});

test('inherited missing target is recorded and points to the official source without a fabricated anchor', () => {
  const parsed = parseEuHtml(`<html lang="nl"><body><p>Richtlijn ${'inhoud '.repeat(100)} <a href="#missing">(2)</a></p></body></html>`, url);
  const resolved = resolveEuNavigation(parsed.chunks, ['part.md'], url);
  assert.deepEqual(resolved.navigation.sourceFragmentIssues, ['#missing']);
  assert.match(resolved.chunks[0], /href="https:\/\/publications.europa.eu\/resource\/celex\/32008L0104#missing"/);
  assert.doesNotMatch(resolved.chunks[0], /id="missing"/);
});

test('preambles and annexes split between blocks while complete articles remain intact', () => {
  const html = `<html lang="nl"><body><p>Richtlijn</p>`+
    Array.from({length: 100}, (_, i) => `<p>Overweging ${i}: ${'tekst '.repeat(200)}</p>`).join('')+
    `<p>Artikel 1</p><p id="whole">${'norm '.repeat(10000)}</p><p>BIJLAGE I</p>`+
    Array.from({length: 100}, (_, i) => `<p>Bijlagepunt ${i}: ${'tekst '.repeat(200)}</p>`).join('')+'</body></html>';
  const parsed = parseEuHtml(html, url);
  assert.ok(parsed.chunks.length >= 4);
  assert.ok(parsed.chunks.every((chunk) => chunk.length <= 80000));
  assert.equal(parsed.chunks.filter((chunk) => chunk.includes('id="whole"')).length, 1);
  assertEuIntegrity(parsed.integrity, parsed.chunks.join('\n'));
});

test('large tables split without repeating captions/headers or cutting rowspans', () => {
  const html = '<table id="table"><caption>Tabel</caption><thead><tr><th>Kolom</th></tr></thead><tbody>'+
    Array.from({length: 24}, (_, i) => `<tr id="row${i}">${i===0?'<td rowspan="3">groep</td>':''}<td>${i}: ${'cel '.repeat(500)}</td></tr>`).join('')+
    '</tbody><tfoot><tr><td>Einde</td></tr></tfoot></table>';
  const parts = splitEuTable(html, 10000);
  assert.ok(parts.length > 1);
  const first = load(parts[0]);
  assert.ok(first('#row0').length && first('#row1').length && first('#row2').length);
  assert.equal(parts.filter((part) => load(part)('caption').length).length, 1);
  assert.equal(parts.filter((part) => load(part)('thead').length).length, 1);
  assert.equal(parts.filter((part) => load(part)('tfoot').length).length, 1);
  assert.equal(parts.reduce((n, part) => n + load(part)('#table').length, 0), 1);
  assertEuIntegrity(htmlIntegrity(html), parts.join('\n'));
});

test('rowspan zero makes the remaining row group indivisible', () => {
  const html = '<table><tbody><tr><td rowspan="0">groep</td><td>'+ 'cel '.repeat(2000)+'</td></tr><tr><td>'+ 'cel '.repeat(2000)+'</td></tr></tbody></table>';
  assert.equal(splitEuTable(html, 1000).length, 1);
});

test('table footer preceding its body retains original reading order instead of being moved', () => {
  const html='<table><tfoot><tr><td>Voet</td></tr></tfoot><tbody><tr><td>'+ 'cel '.repeat(2000)+'</td></tr><tr><td>'+ 'cel '.repeat(2000)+'</td></tr></tbody></table>';
  const parts=splitEuTable(html,1000);
  assert.equal(parts.length,1);
  assertEuIntegrity(htmlIntegrity(html),parts.join('\n'));
});

test('content validation detects punctuation, changed negation, reordered words and dropped images', () => {
  const html = '<p>Artikel 1: niet 12,5% &lt; 15.</p><img src="https://example.org/a.png">';
  const integrity = htmlIntegrity(html);
  for (const changed of [html.replace('niet ', ''), html.replace('12,5', '12.5'), html.replace('Artikel 1', '1 Artikel'), html.replace(/<img[^>]+>/, '')]) {
    assert.throws(() => assertEuIntegrity(integrity, changed));
  }
  assertIntegrity(fingerprintText('A < B.'), fingerprintText('A\n<  B.'));
  assert.throws(() => assertIntegrity(fingerprintText('A < B.'), fingerprintText('a < B.')));
});

test('NL mixed XML retains order, punctuation and symbols through state merging and rendering', () => {
  const changed = nlXml.replace('12,5%', '15%');
  const snapshots=[nlSnapshot(),nlSnapshot(nlXml,'2025-02-01'),nlSnapshot(changed,'2025-03-01')];
  snapshots[0].version.validTo='2025-01-31';snapshots[1].version.validTo='2025-02-28';
  const rendered = renderAct(nlAct, snapshots, '2025-01-01', '2026-10-06');
  assert.equal(rendered.states.length, 2);
  assert.equal(rendered.states[0].content, 'Een werknemer krijgt niet minder dan 12,5%. A < B.');
  assertIntegrity(rendered.integrity, nlOutputIntegrity(rendered.chunks.map((chunk) => chunk.content)));
  assert.throws(() => assertIntegrity(rendered.integrity, nlOutputIntegrity(rendered.chunks.map((chunk) => chunk.content.replace('niet ', '')))));
});

function pair(t: {after: (fn: () => void) => void}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'law-pair-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const nl = path.join(root, 'NL'), eu = path.join(root, 'EU');fs.mkdirSync(nl);fs.mkdirSync(eu);
  const hash = (value: string, algorithm = 'md5') => createHash(algorithm).update(value).digest('hex');
  const rendered = renderAct(nlAct, [nlSnapshot()], '2025-01-01', '2026-10-06');
  const nlFiles = rendered.chunks.map((chunk) => {fs.writeFileSync(path.join(nl, chunk.fileName), chunk.content);return {name:chunk.fileName,md5:hash(chunk.content)};});
  const html = fs.readFileSync(new URL('fixtures/32008L0104-nld.html', import.meta.url), 'utf8');
  const parsed = parseEuHtml(html, url), names=parsed.chunks.map((_c,i)=>`01_source__${i+1}.md`);
  const resolved = resolveEuNavigation(parsed.chunks,names,url);
  const euFiles=resolved.chunks.map((chunk,i)=>{const content=`# Header\n\n<!-- Część ${i+1}/${names.length} -->\n\n${chunk}\n`;fs.writeFileSync(path.join(eu,names[i]),content);return {name:names[i],celex:euAct.celex,part:i+1,md5:hash(content)};});
  const nlManifest={schemaVersion:1,validationVersion:1,jurisdiction:'NL',rangeFrom:'2025-01-01',rangeTo:'2026-10-06',acts:[{order:1,bwbId:nlAct.bwbId,files:nlFiles,integrity:rendered.integrity}]};
  const euManifest={schemaVersion:1,validationVersion:1,jurisdiction:'EU',rangeFrom:'2025-01-01',rangeTo:'2026-10-06',acts:[{...euAct,files:euFiles,documents:[{celex:euAct.celex,sourceSha256:hash(html,'sha256'),integrity:parsed.integrity,textLength:resolved.chunks.reduce((n,c)=>n+c.length,0)}]}]};
  const save=()=>{fs.writeFileSync(path.join(nl,'manifest.json'),JSON.stringify(nlManifest));fs.writeFileSync(path.join(eu,'manifest.json'),JSON.stringify(euManifest));};
  for(const dir of [nl,eu])for(const name of ['INDEX.md','REPORT.md'])fs.writeFileSync(path.join(dir,name),'# Complete\n');save();
  const targets=[{jurisdiction:'NL' as const,dir:nl,acts:[nlAct]},{jurisdiction:'EU' as const,dir:eu,acts:[euAct]}];
  return {nl,eu,nlManifest,euManifest,save,targets,hash};
}

test('both NL and EU packages pass together; mixed dates and missing partner fail before publication', (t) => {
  const p=pair(t);assert.doesNotThrow(()=>validatePublicationSet(p.targets));
  p.euManifest.rangeTo='2026-10-05';p.save();assert.throws(()=>validatePublicationSet(p.targets));
  assert.throws(()=>validatePublicationSet(p.targets.slice(0,1)));
  p.euManifest.rangeTo='2026-02-30';p.nlManifest.rangeTo='2026-02-30';p.save();
  assert.throws(()=>validatePublicationSet(p.targets));
});

test('updated MD5 cannot bypass EU source-text or local-link validation', (t) => {
  const p=pair(t), file=p.euManifest.acts[0].files[0], target=path.join(p.eu,file.name), original=fs.readFileSync(target,'utf8');
  for(const changed of [original.replace('Artikel 1','Artikel 999'),original.replace(/href="#[^"]+"/,'href="#introduced-missing-target"')]){
    fs.writeFileSync(target,changed);file.md5=p.hash(changed);p.euManifest.acts[0].documents[0].textLength=changed.split(/<!-- Część \d+\/\d+ -->\n\n/)[1].slice(0,-1).length;p.save();
    assert.throws(()=>validatePublicationSet(p.targets));
  }
});

test('updated MD5 cannot bypass NL source-text validation or permit incomplete EU editions', (t) => {
  const p=pair(t),file=p.nlManifest.acts[0].files[0],target=path.join(p.nl,file.name),original=fs.readFileSync(target,'utf8');
  const changed=original.replace('niet ', '');fs.writeFileSync(target,changed);file.md5=p.hash(changed);p.save();
  assert.throws(()=>validatePublicationSet(p.targets));
  fs.writeFileSync(target,original);file.md5=p.hash(original);p.save();
  assert.throws(()=>validateOutput(p.eu,[{...euAct,requiredVersions:['32008L0104','02008L0104-20250101']}]));
  p.nlManifest.validationVersion=0;p.save();assert.throws(()=>validatePublicationSet(p.targets));
});
