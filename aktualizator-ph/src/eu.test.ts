import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { load } from 'cheerio';
import { parseEuHtml } from './eu-parser.js';
import { selectEuDocuments, checkCelex } from './eu-provider.js';
import type { EuAct, EuDocument } from './eu-provider.js';
import { warsawDate } from './calendar.js';

const act: EuAct = { order: 1, title: 'Test', celex: '32006L0054', include: 'full-document',
  requiredVersions: ['32006L0054'], attachedDocuments: [] };
const doc = (celex: string, metadata: Record<string, string[]> = {}): EuDocument =>
  ({ celex, metadata, role: celex.startsWith('0') ? 'consolidated-documentary-version' : 'original', include: 'full-document' });

test('Warsaw day is shared by modules across UTC midnight and winter offset', () => {
  assert.equal(warsawDate(new Date('2026-10-05T22:15:00Z')), '2026-10-06');
  assert.equal(warsawDate(new Date('2026-12-05T23:15:00Z')), '2026-12-06');
});

test('version selection keeps baseline and every in-range consolidation, excludes future editions', () => {
  const selected = selectEuDocuments([
    doc('32006L0054'), doc('02006L0054-20060726'), doc('02006L0054-20200101'),
    doc('02006L0054-20250101'), doc('02006L0054-20260619'), doc('02006L0054-20270101'),
  ], act, '2025-01-01', '2026-10-05');
  assert.deepEqual(selected.map((d) => d.celex), ['02006L0054-20250101', '02006L0054-20260619', '32006L0054']);
});

test('required migration edition and historical case law remain in scope before range start', () => {
  const original:EuAct={order:1,title:'Example judgment',celex:'62021CJ0311',include:'full-document',requiredVersions:['62021CJ0311'],attachedDocuments:[]};
  assert.equal(selectEuDocuments([doc(original.celex, {work_date_document: ['2022-12-15']})], original,
    '2025-01-01', '2026-10-05').length, 1);
});

test('French/Czech consolidation is not selected as baseline for the Dutch original', () => {
  const selected = selectEuDocuments([doc('32006L0054'), doc('02006L0054-20190711', {
    available_language: ['http://publications.europa.eu/resource/authority/language/FRA'],
  })], act, '2025-01-01', '2026-10-05');
  assert.deepEqual(selected.map((d) => d.celex), ['32006L0054']);
});

test('required future source and connected document without a date fail closed', () => {
  assert.throws(() => selectEuDocuments([doc('02006L0054-20270101')],
    {...act, requiredVersions: ['02006L0054-20270101']}, '2025-01-01', '2026-10-05'));
  assert.throws(() => selectEuDocuments([doc('32024L1500')], act, '2025-01-01', '2026-10-05'));
});

test('old ancillary sources are bounded by the retained baseline, in-range amendments stay mandatory', () => {
  const selected = selectEuDocuments([
    doc('32006L0054'), doc('02006L0054-20190726'),
    doc('32006L0054R(01)', {work_date_document: ['2006-07-04']}),
    doc('32024L1500', {work_date_document: ['2024-05-14']}),
    doc('32025L2450', {work_date_document: ['2025-11-26']}),
  ], act, '2025-01-01', '2026-10-05');
  assert.deepEqual(selected.map((d) => d.celex), ['02006L0054-20190726', '32006L0054', '32024L1500', '32025L2450']);
});

test('short Dutch corrigendum is retained, generic website error page is rejected', () => {
  const text = 'Rectificatie van Richtlijn 2006/54/EG. Op bladzijde 4, artikel 1, wordt de Nederlandse tekst als volgt gecorrigeerd.';
  assert.equal(parseEuHtml(`<html lang="nl"><body><p>${text}</p></body></html>`, 'https://publications.europa.eu/', 'corrigendum').chunks.length, 1);
  assert.throws(() => parseEuHtml(`<html><body>Richtlijn The requested document does not exist ${text.repeat(10)}</body></html>`, 'https://eur-lex.europa.eu/'));
});

test('Dutch scope excludes a corrigendum officially available only in another language', () => {
  const selected = selectEuDocuments([
    doc('32006L0054'),
    doc('32006L0054R(01)', { available_language: ['http://publications.europa.eu/resource/authority/language/DEU'] }),
    doc('32006L0054R(02)', { available_language: ['http://publications.europa.eu/resource/authority/language/NLD'], work_date_document: ['2025-06-01'] }),
  ], act, '2025-01-01', '2026-10-05');
  assert.deepEqual(selected.map((d) => d.celex), ['32006L0054', '32006L0054R(02)']);
});

test('real CELLAR directive retains every substantive word, annex/footnote text and all 14 articles', () => {
  const html = fs.readFileSync(new URL('fixtures/32008L0104-nld.html', import.meta.url), 'utf8');
  const parsed = parseEuHtml(html, 'https://publications.europa.eu/resource/celex/32008L0104');
  assert.equal(parsed.articleCount, 14);
  const $ = load(html); $('script,style').remove();
  const words = new Set($('body').text().toLowerCase().match(/[\p{L}]{4,}/gu));
  const rendered = load(parsed.chunks.join('\n')).text().toLowerCase();
  for (const word of words) assert.ok(rendered.includes(word), `Lost source word: ${word}`);
  assert.match(parsed.chunks.join('\n'), /<table/);
  assert.match(parsed.chunks.join('\n'), /PB L 80/);
});

test('exact C-19/23 operative part includes all five points and rejects missing last point', () => {
  const html = fs.readFileSync(new URL('fixtures/62023CJ0019-dispositif-nld.html', import.meta.url), 'utf8');
  const parsed = parseEuHtml(html, 'https://publications.europa.eu/', 'operative-part');
  assert.match(parsed.chunks.join(''), /nietig verklaard/);
  assert.match(parsed.chunks.join(''), /5\)/);
  const $ = load(html); $('p.C08Dispositif').last().remove();
  assert.throws(() => parseEuHtml($.html(), 'https://publications.europa.eu/', 'operative-part'));
});

test('challenge, blank page, wrong language and unsupported national identifiers are rejected', () => {
  assert.throws(() => parseEuHtml('<html><body>Access Denied</body></html>', 'https://publications.europa.eu/'));
  assert.throws(() => parseEuHtml('<html><body></body></html>', 'https://publications.europa.eu/'));
  const html = `<html lang="en"><body>Artikel 1 ${'law text '.repeat(100)}</body></html>`;
  assert.throws(() => parseEuHtml(html, 'https://publications.europa.eu/'));
  assert.throws(() => checkCelex('BWBR0005290'));
  assert.throws(() => checkCelex('../secret'));
  checkCelex('12016E/TXT'); checkCelex('32006L0054R(01)'); checkCelex('32020D0807(01)');
  checkCelex('12016E/TXTR(01)'); checkCelex('62020CJ0426R(01)');
});

test('chunking keeps complete articles and final annex, even for a large source', () => {
  const html = '<html lang="nl"><body><p>Richtlijn</p>' + Array.from({length: 85}, (_, i) =>
    `<p>Artikel ${i + 1}</p><p>${'Volledige inhoud. '.repeat(100)}</p>`).join('') + '<p>BIJLAGE laatste tabel</p></body></html>';
  const parsed = parseEuHtml(html, 'https://publications.europa.eu/');
  assert.equal(parsed.articleCount, 85);
  assert.equal(parsed.chunks.length, 3);
  assert.match(parsed.chunks[2], /BIJLAGE laatste tabel$/);
  assert.ok(parsed.chunks.every((c) => !c.endsWith('Artikel')));
});
