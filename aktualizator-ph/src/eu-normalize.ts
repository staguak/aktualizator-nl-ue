import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { assertEuIntegrity, htmlIntegrity } from './content-integrity.js';
import { hash, normalizeOutput, stableJson } from './output.js';

export const LANGUAGE_BASE = 'http://publications.europa.eu/resource/authority/language/';
const DEFAULTS: Record<string, {key:string; value:string[]}> = {
  c:{key:'resource_legal_codified_version',value:['0']},
  e:{key:'resource_legal_date_end-of-validity',value:['9999-12-31']},
  i:{key:'resource_legal_in-force',value:['1']},
};
export type Metadata = Record<string,string[]>;
export interface NormalizedMetadata { [key:string]: string[] | string }
export interface MetadataRules {languageAuthorityBase: string; languageSets: Record<string,string[]>}
export function languageDictionary(metadata: Metadata[]): MetadataRules {
  const sets = [...new Set(metadata.filter(m=>m.available_language?.every(v=>v.startsWith(LANGUAGE_BASE)))
    .map(m=>JSON.stringify(m.available_language.map(v=>v.slice(LANGUAGE_BASE.length)))))].sort();
  return {languageAuthorityBase:LANGUAGE_BASE,languageSets:Object.fromEntries(sets.map((v,i)=>[`L${String(i+1).padStart(2,'0')}`,JSON.parse(v)]))};
}
export function expandMetadata(metadata: NormalizedMetadata, celex: string, rules: MetadataRules): Metadata {
  const result: Metadata = {};
  for (const [key,value] of Object.entries(metadata)) {
    if (['available_language_ref','_dp','_aliases'].includes(key)) continue;
    if (!Array.isArray(value) || value.some(v=>typeof v!=='string')) throw new Error('Invalid normalized EU metadata.');
    result[key]=[...value];
  }
  if (metadata.available_language_ref !== undefined) {
    const values=rules.languageSets[String(metadata.available_language_ref)];
    if (!values || result.available_language) throw new Error('Invalid EU language reference.');
    result.available_language=values.map(v=>rules.languageAuthorityBase+v);
  }
  for (const flag of String(metadata._dp ?? '')) {
    const d=DEFAULTS[flag];if(!d || result[d.key])throw new Error('Invalid EU metadata default mask.');result[d.key]=[...d.value];
  }
  for (const flag of String(metadata._aliases ?? '')) {
    const key = flag==='x'?'resource_legal_id_celex':flag==='l'?'work_date_creation_legacy':flag==='d'?'work_date_document':'';
    const value=flag==='x'?[celex]:flag==='l'?result.date_creation_legacy:result.act_consolidated_date;
    if (!key||!value||result[key])throw new Error('Invalid EU metadata alias mask.');result[key]=[...value];
  }
  return result;
}
export function normalizeMetadata(original: Metadata, celex:string, rules: MetadataRules): NormalizedMetadata {
  const result: NormalizedMetadata = Object.fromEntries(Object.entries(original).map(([k,v])=>[k,[...v]]));
  if(original.available_language?.every(v=>v.startsWith(LANGUAGE_BASE))) {
    const codes=original.available_language.map(v=>v.slice(LANGUAGE_BASE.length));
    const ref=Object.entries(rules.languageSets).find(([,v])=>JSON.stringify(v)===JSON.stringify(codes))?.[0];
    if(!ref)throw new Error('Missing EU language dictionary entry.');
    delete result.available_language;result.available_language_ref=ref;
  }
  let aliases='';
  for(const [flag,key,value] of [['x','resource_legal_id_celex',[celex]],['l','work_date_creation_legacy',original.date_creation_legacy],['d','work_date_document',original.act_consolidated_date]] as const) {
    if(value && JSON.stringify(original[key])===JSON.stringify(value)){delete result[key];aliases+=flag;}
  }
  if(aliases)result._aliases=aliases;
  let defaults='';for(const [flag,d]of Object.entries(DEFAULTS))if(JSON.stringify(original[d.key])===JSON.stringify(d.value)){delete result[d.key];defaults+=flag;}
  if(defaults)result._dp=defaults;
  assert.deepEqual(expandMetadata(result,celex,rules),original);
  return result;
}
function htmlSignature(html:string) {
  const $=load(html,{xmlMode:false},false);
  const tags:any[]=[],texts:string[]=[];
  function walk(nodes:any[]) {for(const n of nodes){if(n.type==='text' && /\S/u.test(n.data))texts.push(n.data);
    if(n.name)tags.push([n.type,n.name,Object.entries(n.attribs??{}).sort(([a],[b])=>a.localeCompare(b))]);if(n.children)walk(n.children);}}
  walk($.root().contents().toArray());return {tags,texts};
}
export function equivalentHtml(before:string,after:string): boolean {
  try {assert.deepEqual(htmlSignature(before),htmlSignature(after));return before.replace(/\s/gu,'')===after.replace(/\s/gu,'');}catch{return false;}
}
export function hasSensitiveEuBody(body:string):boolean {
  return /<(?:pre|code|textarea|script|style)\b/i.test(body)||/^[ \t]*(?:`{3,}|~{3,})/m.test(body);
}
export function normalizeEuBody(body:string): {body:string; status:'unchanged'|'verified'|'sensitive-skip'|'fallback'} {
  if(hasSensitiveEuBody(body))return {body,status:'sensitive-skip'};
  const candidate=body.replace(/^[ \t]+(?=<(?:\/?)(?:table|thead|tbody|tfoot|tr|td|th|colgroup|col|p|div|figure|figcaption)(?:\s|\/?>))/gm,'');
  if(candidate===body)return {body,status:'unchanged'};
  return equivalentHtml(body,candidate)?{body:candidate,status:'verified'}:{body,status:'fallback'};
}
export function legalBodyHash(body:string): string {return hash(body);}
export const EU_START='<!-- EU legal body -->';
export const EU_END='<!-- /EU legal body -->';
export function euHeader(title:string,celex:string,part:number,total:number,sourceUrl:string,language:'NL'|'EN'='NL'):string {
  // Keep the URL and consolidation disclaimer usable without the manifest.
  const status=celex.startsWith('0')?' · konsolidacja dokumentacyjna':'';
  return normalizeOutput(`# ${title}\n\nCELEX ${celex} · ${language} · ${part}/${total}${status} · [źródło](${sourceUrl})\n`);
}
export function euLayoutBytes(title:string,celex:string,part:number,total:number,sourceUrl:string,language:'NL'|'EN'='NL'):number {
  return Buffer.byteLength(`${euHeader(title,celex,part,total,sourceUrl,language)}\n${EU_START}\n\n${EU_END}\n`);
}
export function euContent(title:string,celex:string,part:number,total:number,body:string,sourceUrl:string,language:'NL'|'EN'='NL'): string {
  return euContentFromBody(title,celex,part,total,normalizeFinalEuBody(body),sourceUrl,language);
}
export function normalizeFinalEuBody(body:string): string {
  const text=normalizeOutput(body).replace(/\n$/,'');
  if(body.includes(EU_START)||body.includes(EU_END))throw new Error('Reserved EU boundary marker in source.');
  if(hasSensitiveEuBody(body)&&!equivalentHtml(body,text))throw new Error('Cannot normalize sensitive legal whitespace safely.');
  // Common LF/trailing-space normalization is distinct from conservative HTML indentation.
  assert.deepEqual(htmlSignature(body).tags,htmlSignature(text).tags);
  assertEuIntegrity(htmlIntegrity(body),text);
  if(body.replace(/\s/gu,'')!==text.replace(/\s/gu,''))throw new Error('Final layout normalization changed EU source bytes.');
  return text;
}
export function euContentFromBody(title:string,celex:string,part:number,total:number,body:string,sourceUrl:string,language:'NL'|'EN'='NL'): string {
  return `${euHeader(title,celex,part,total,sourceUrl,language)}\n${EU_START}\n${body}\n${EU_END}\n`;
}
export function extractEuBody(content:string): string {
  const parts=content.split(EU_START+'\n');
  if(parts.length!==2||parts[1].split('\n'+EU_END+'\n').length!==2||!parts[1].endsWith('\n'+EU_END+'\n'))throw new Error('Invalid EU legal boundaries.');
  return parts[1].slice(0,-('\n'+EU_END+'\n').length);
}
export function metadataHash(metadata:Metadata): string {return hash(stableJson(metadata));}
