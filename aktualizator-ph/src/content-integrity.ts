import { createHash } from 'node:crypto';
import { load } from 'cheerio';

export interface TextIntegrity { sha256: string; tokens: number }
export interface EuIntegrity { text: TextIntegrity; images: TextIntegrity }

// Ignore layout whitespace only. Case, punctuation, symbols and their order remain significant.
export function fingerprintText(text: string): TextIntegrity {
  const tokens = text.normalize('NFC').match(/[\p{L}\p{N}]+|[^\s]/gu) ?? [];
  return { sha256: createHash('sha256').update(tokens.join('\n')).digest('hex'), tokens: tokens.length };
}

export function htmlIntegrity(html: string): EuIntegrity {
  const $ = load(html);
  $('script,style,noscript').remove();
  const images = $('body img').toArray().map((e) => $(e).attr('src') ?? '');
  $('p,div,section,article,h1,h2,h3,h4,h5,h6,li,blockquote,hr,br,tr,td,th').each((_i, e) => {
    $(e).append('\n');
  });
  return { text: fingerprintText($('body').text()), images: fingerprintText(JSON.stringify(images)) };
}

export function assertIntegrity(expected: TextIntegrity, actual: TextIntegrity): void {
  if (!expected || !/^[a-f0-9]{64}$/.test(expected.sha256) || !Number.isInteger(expected.tokens)
      || expected.tokens < 0 || expected.sha256 !== actual.sha256 || expected.tokens !== actual.tokens) {
    throw new Error('Source/output content integrity mismatch.');
  }
}

export function assertEuIntegrity(expected: EuIntegrity, html: string): void {
  const actual = htmlIntegrity(html);
  assertIntegrity(expected?.text, actual.text);
  assertIntegrity(expected?.images, actual.images);
}

export const NL_START = '<!-- NL source text -->';
export const NL_END = '<!-- /NL source text -->';
export function nlOutputIntegrity(contents: string[]): TextIntegrity {
  const texts: string[] = [];
  for (const content of contents) {
    const parts = content.split(NL_START);
    for (const part of parts.slice(1)) {
      const end = part.indexOf(NL_END);
      if (end < 0 || part.indexOf(NL_END, end + NL_END.length) >= 0) {
        throw new Error('Invalid NL source text boundaries.');
      }
      texts.push(part.slice(0, end));
    }
    if (parts.length - 1 !== content.split(NL_END).length - 1) throw new Error('Invalid NL source text boundaries.');
  }
  if (!texts.length) throw new Error('Missing NL source text boundaries.');
  return fingerprintText(texts.join('\n'));
}
