import { load } from 'cheerio';
import { assertEuIntegrity, htmlIntegrity } from './content-integrity.js';
import type { EuIntegrity } from './content-integrity.js';
import { splitEuTable } from './eu-tables.js';

export interface EuText { chunks: string[]; articleCount: number; textLength: number; integrity: EuIntegrity; sourceTitle?:string }

// Content comes from CELLAR's negotiated Dutch publication, never a summary page.
// Walk every text node once. Tables remain HTML in Markdown to retain their layout.
export function parseEuHtml(html: string, sourceUrl: string, include = 'full-document', language:'NL'|'EN'='NL'): EuText {
  if (/captcha|awswaf|verify you are human|Access Denied|enable javascript to continue|The requested document does not exist|errorDocumentView/i.test(html)) {
    throw new Error('EU source returned a challenge/error page.');
  }
  const $ = load(html);
  const body = $('body');
  body.find('script,style,noscript').remove();
  const minimumLength = include === 'corrigendum' ? 80 : 500;
  if (include === 'corrigendum' && !(language==='EN'?/corrigendum|corrigenda/i:/rectificatie|rectificaties/i).test(body.text())) {
    throw new Error('Expected an official corrigendum in the configured language.');
  }
  if (body.length !== 1 || body.text().trim().length < minimumLength ||
      !(language==='EN'?/article|treaty|judgment|directive|regulation|charter|decision/i:/artikel|verdrag|arrest|richtlijn|verordening|handvest|besluit/i).test(body.text())) {
    throw new Error('EU source is empty or is not a legal document in the configured language.');
  }
  const lang = $('html').attr('lang') ?? $('html').attr('xml:lang');
  if (lang && !(language==='EN'?/^en(?:g|-|$)/i:/^nl(?:d|-|$)/i).test(lang)) throw new Error('Unexpected EU publication language.');
  const sourceTitle=body.find('p.doc-ti,p.oj-doc-ti,p.title-doc').slice(0,3).map((_i,e)=>$(e).text().replace(/\s+/g,' ').trim()).get().join(' ') || $('title').text().trim();
  body.find('[href],[src]').each((_i, el) => {
    for (const attr of ['href', 'src']) {
      const value = $(el).attr(attr);
      if (value && !value.startsWith('#')) $(el).attr(attr, new URL(value, sourceUrl).href);
    }
  });
  let roots = body.contents().toArray();
  if (include === 'operative-part') {
    const intro = body.find('p').filter((_i, el) =>
      (language==='EN'?/^On those grounds,? the Court .*hereby(?: rules)?:$/i:/^Het Hof .*verklaart:$/i).test($(el).text().replace(/\s+/g, ' ').trim()));
    let disposition = intro.nextAll('p.C08Dispositif');
    if(language==='EN'&&intro.length===1&&disposition.length!==5){
      // CELLAR's current English judgment uses nested numbered tables rather
      // than EUR-Lex's historical C08Dispositif paragraphs. Preserve each table
      // and require the exact 1..5 sequence, excluding the signature table.
      const outer=intro.parents('table').last();
      const tables=outer.nextAll('table').filter((_i,e)=>$(e).find('p.coj-count.coj-bold').length===1);
      if(tables.length===5&&tables.toArray().every((e,i)=>$(e).find('p.coj-count.coj-bold').text().trim()===`${i+1}.`))disposition=tables;
    }
    if (intro.length !== 1 || disposition.length !== 5) {
      throw new Error('Required five-point operative part of C-19/23 not found.');
    }
    roots = [...intro.toArray(), ...disposition.toArray()];
  } else if (!['full-document', 'corrigendum'].includes(include)) throw new Error('Unsupported EU source selector.');
  const selectedHtml = roots.map((node) => $.html(node)).join('');
  const integrity = htmlIntegrity(selectedHtml);
  const blocks: string[] = [];
  // Leave room for filenames added to cross-part links during navigation repair.
  const targetChars = 76000;
  let buffer = '';
  const flush = () => { if (buffer.trim()) blocks.push(buffer.trim()); buffer = ''; };
  function walk(node: any): void {
    if (node.type === 'text') {
      buffer += node.data.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); return;
    }
    if (node.type === 'comment') return;
    const tag = node.name?.toLowerCase();
    if (tag === 'table') { flush(); blocks.push(...splitEuTable($.html(node), targetChars)); return; }
    if (tag === 'img') { buffer += $.html(node); return; }
    const block = /^(p|div|section|article|h[1-6]|li|blockquote|hr)$/.test(tag ?? '');
    if (block) flush();
    // Tables/images and real links already carry their original IDs. Every other
    // wrapper must retain its named destinations when rendered as ordinary text.
    if (tag !== 'a' || !$(node).attr('href')) {
      for (const attr of ['id', 'name']) {
        const id = $(node).attr(attr);
        if (id && (attr === 'id' || id !== $(node).attr('id'))) {
          buffer += `<a id="${id.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"></a>`;
        }
      }
    }
    if (tag === 'br') { buffer += '\n'; return; }
    if (tag === 'a' && $(node).attr('href')) {
      buffer += $.html(node);
    } else {
      const inline = /^(sup|sub|strong|b|em|i|del|ins|s|u)$/.test(tag ?? '');
      if (inline) buffer += `<${tag}>`;
      for (const child of node.children ?? []) walk(child);
      if (inline) buffer += `</${tag}>`;
    }
    if (block) flush();
  }
  for (const node of roots) walk(node);
  flush();
  const plain = (block: string) => load(block).text().replace(/\u00a0/g, ' ').trim();
  const isArticle = (block: string) => !/^<table\b/i.test(block) && /^(?:Artikel|Article)\s+\d+[a-z]?\s*$/i.test(plain(block));
  const articles = blocks.filter(isArticle);
  // Preserve complete articles. Preambles and annexes can split between blocks;
  // row-spanning table groups and other indivisible units may exceed the target.
  const units: {blocks: string[]; articles: number}[] = [];
  let article: typeof units[number] | undefined;
  for (const block of blocks) {
    if (isArticle(block)) {
      article = {blocks: [block], articles: 1}; units.push(article);
    } else if (!/^<table\b/i.test(block) && /^(?:[A-Z]\.\s*)?(?:\d+\.\s*)?(?:ANNEX|APPENDIX|DECLARATION|BIJLAGE|BĲLAGE|AANHANGSEL|PROTOCOL|VERKLARING(?:EN)?)(?:\s|$)/i.test(plain(block))) {
      article = undefined; units.push({blocks: [block], articles: 0});
    } else if (article) article.blocks.push(block);
    else units.push({blocks: [block], articles: 0});
  }
  const chunks: string[] = [];
  let chunk: string[] = [], chars = 0, count = 0;
  for (const unit of units) {
    const text = unit.blocks.join('\n\n');
    if (chunk.length && (chars + text.length + 2 > targetChars || count + unit.articles > 40)) {
      chunks.push(chunk.join('\n\n')); chunk = []; chars = 0; count = 0;
    }
    chunk.push(text); chars += text.length + 2; count += unit.articles;
  }
  if (chunk.length) chunks.push(chunk.join('\n\n'));
  const textLength = chunks.reduce((n, c) => n + c.length, 0);
  if (!chunks.length || textLength < minimumLength) throw new Error('EU text extraction was incomplete.');
  assertEuIntegrity(integrity, chunks.join('\n'));
  return { chunks, articleCount: articles.length, textLength, integrity,sourceTitle };
}
