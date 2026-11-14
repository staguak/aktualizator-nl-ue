import { createHash } from 'node:crypto';
import { load } from 'cheerio';

export interface TextIntegrity { sha256: string; tokens: number }
export interface EuIntegrity { text: TextIntegrity; images: TextIntegrity }
export interface EuImageOccurrence {
  index:number;source:string;target:string;sha256:string;size:number;contentType:string;
}
export interface EuImageProof extends Omit<EuImageOccurrence,'source'> {sourceSha256:string}
export function compactEuImageProof(occurrences:EuImageOccurrence[]):EuImageProof[]{
  return occurrences.map(({source,...occurrence})=>({...occurrence,sourceSha256:createHash('sha256').update(source).digest('hex')}));
}

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

/** Keep the original text/reference checks and additionally verify an exact,
 * complete sidecar index. Extracting images never changes Markdown references. */
export function assertEuAssetIntegrity(expected:EuIntegrity,html:string,occurrences:EuImageOccurrence[],readAsset:(name:string)=>Uint8Array):void {
  const $=load(html),images=$('body img').toArray(),seen=new Set<number>();
  if(occurrences.length!==images.length)throw new Error('Extracted EU image index is incomplete.');
  for(const occurrence of occurrences){
    if(!Number.isSafeInteger(occurrence.index)||occurrence.index<0||occurrence.index>=images.length||seen.has(occurrence.index)||
      typeof occurrence.source!=='string'||!occurrence.source||
      !/^images\/[a-f0-9]{64}\.[a-z0-9]+$/.test(occurrence.target)||!/^image\/[a-z0-9.+-]+$/.test(occurrence.contentType)||
      !/^[a-f0-9]{64}$/.test(occurrence.sha256)||!Number.isSafeInteger(occurrence.size)||occurrence.size<1||
      !occurrence.target.startsWith('images/'+occurrence.sha256+'.'))throw new Error('Invalid extracted EU image occurrence.');
    const image=images[occurrence.index];
    if($(image).attr('src')!==occurrence.source)throw new Error('Original EU image reference mismatch.');
    const bytes=readAsset(occurrence.target);
    if(bytes.byteLength!==occurrence.size||createHash('sha256').update(bytes).digest('hex')!==occurrence.sha256)
      throw new Error('Extracted EU image binary integrity mismatch.');
    seen.add(occurrence.index);
  }
  assertEuIntegrity(expected,html);
}
/** Persist compact source-reference hashes, not another copy of Base64. The
 * original retained markup is authoritative when replaying this proof. */
export function assertEuAssetProof(originalHtml:string,derivedHtml:string,proof:EuImageProof[],readAsset:(name:string)=>Uint8Array):void{
  if(originalHtml!==derivedHtml)throw new Error('Validated Markdown must remain unchanged during image extraction.');
  const $=load(originalHtml),originals=$('body img').toArray();
  const occurrences=proof.map(({sourceSha256,...occurrence})=>{
    if(!Number.isSafeInteger(occurrence.index)||occurrence.index<0||occurrence.index>=originals.length||!/^[a-f0-9]{64}$/.test(sourceSha256))
      throw new Error('Invalid compact EU image proof.');
    const source=$(originals[occurrence.index]).attr('src')??'';
    if(createHash('sha256').update(source).digest('hex')!==sourceSha256)throw new Error('EU image original reference proof mismatch.');
    return {...occurrence,source};
  });
  assertEuAssetIntegrity(htmlIntegrity(originalHtml),derivedHtml,occurrences,readAsset);
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
