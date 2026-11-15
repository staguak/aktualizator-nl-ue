import {load} from 'cheerio';
import {isCalendarDate} from './calendar.js';
import {legalMarkdown,LEGAL_START} from './legal-structure.js';
import type {LegalContext} from './legal-structure.js';

export const EU_HEADER_PROFILE='eu-document-header-v1';
const titleClasses=new Set(['doc-ti','oj-doc-ti','title-doc','title-doc-first','title-doc-last','coj-sum-title-1']);
const normalized=(text:string)=>text.replace(/\s+/gu,' ').trim();
export interface EuTitle {
  value:string;
  provenance:{kind:'xhtml-title-block'|'legacy-xhtml-title'|'html-title'|'celex'|'unavailable';sourceUrl:string;sourceSha256:string;
    fragments:{ordinal:number;tag:string;classes:string[];text:string}[]};
}
export interface EuDate {value:string|null;status:'confirmed'|'unknown'|'ambiguous'|'invalid';fields:Record<string,string[]>}
export interface EuDocumentHeader {profile:typeof EU_HEADER_PROFILE;documentId:string;title:EuTitle;dates:{document:EuDate;consolidation:EuDate;publication:EuDate}}
export const EU_DATE_FIELDS=['work_date_document','official-journal-act_date_publication','resource_legal_date_publication'] as const;
/** Only the initial, contiguous title block; later annex headings cannot join it. */
export function readEuTitle(html:string,sourceUrl:string,sourceSha256:string,documentId?:string):EuTitle{
  const $=load(html);$('script,style,noscript').remove();
  const fragments:EuTitle['provenance']['fragments']=[];
  const blocks=$('body').find('p,h1,h2,h3,h4,h5,h6').toArray();
  for(const [ordinal,node]of blocks.entries()){
    const text=normalized($(node).text());if(!text)continue;
    const classes=($(node).attr('class')??'').split(/\s+/).filter(Boolean);
    const boundary=/^(?:Table of contents|Contents|Spis treści|Inhoudsopgave|Inhoud|Table des matières|Sommaire)$/iu.test(text)||
      /^(?:ANNEX(?:E)?|APPENDIX|BIJLAGE|BĲLAGE|AANHANGSEL|ZAŁĄCZNIK|DODATEK)(?:\s|$)/iu.test(text)||
      classes.some(c=>/^(?:oj-ti-art|ti-art|title-article|title-annex|oj-ti-annex)$/.test(c))||
      /^(?:Article|Artikel|Artykuł|Art\.)\s+(?:\d+[a-z]*|premier|unique|pierwszy|jedyny)\s*$/iu.test(text);
    if(boundary)break;
    if(classes.some(c=>titleClasses.has(c)))fragments.push({ordinal,tag:node.tagName,classes,text});
    else if(fragments.length)break;
  }
  const provenance={sourceUrl,sourceSha256,fragments};
  if(fragments.length)return {value:fragments.map(f=>f.text).join(' '),provenance:{...provenance,kind:'xhtml-title-block'}};
  // Older official EUR-Lex pages identify the work in H1 and put the actual
  // title in STRONG, alongside a separate EM publication citation.
  const identifiers=$('body h1').filter((_i,node)=>documentId?normalized($(node).text())===documentId:/^[036][A-Z0-9_()./-]+$/i.test(normalized($(node).text())));
  if(identifiers.length===1){
    const paragraph=identifiers.first().next('p'),ordinal=blocks.indexOf(paragraph[0]);
    const strong=paragraph.find('strong').toArray();
    if(ordinal>=0&&strong.length){
      const legacy=strong.map(node=>({ordinal,tag:'strong',classes:($(node).attr('class')??'').split(/\s+/).filter(Boolean),text:normalized($(node).text())})).filter(f=>f.text);
      if(legacy.length)return {value:legacy.map(f=>f.text).join(' '),provenance:{...provenance,fragments:legacy,kind:'legacy-xhtml-title'}};
    }
  }
  const head=normalized($('head > title').first().text());
  const technical=!head||/^EUR-Lex\b/i.test(head)||/^[0-9][A-Z0-9_()./-]+$/i.test(head)||/^[\w.-]+\.(?:xml|xhtml|html)$/i.test(head);
  if(!technical)return {value:head,provenance:{...provenance,kind:'html-title'}};
  return {value:documentId?`CELEX ${documentId}`:'Nieustalony tytuł dokumentu',provenance:{...provenance,kind:documentId?'celex':'unavailable'}};
}
function date(fields:Record<string,string[]>):EuDate{
  const values=[...new Set(Object.values(fields).flat())];
  const status=!values.length?'unknown':values.some(v=>!isCalendarDate(v))?'invalid':values.length===1?'confirmed':'ambiguous';
  return {value:status==='confirmed'?values[0]:null,status,fields};
}
export function euDocumentHeader(title:EuTitle,documentId:string,metadata:Record<string,string[]>):EuDocumentHeader{
  const fields=(names:readonly string[])=>Object.fromEntries(names.map(k=>[k,[...new Set(metadata[k]??[])].sort()]));
  // A layer's CELEX date identifies the consolidation, never the act's adoption.
  const layer=/^0\d{4}[A-Z]\d{4}(?:\(\d{2}\))?-(\d{4})(\d{2})(\d{2})(?:R\(\d{2}\))?$/.exec(documentId);
  return {profile:EU_HEADER_PROFILE,documentId,title,dates:{document:date(fields(['work_date_document'])),
    consolidation:date({'celex-consolidation':layer?[layer.slice(1).join('-')]:[]}),publication:date(fields(EU_DATE_FIELDS.slice(1)))}};
}
/** Replay dates from retained raw responses, not generated metadata/headers. */
export function euHeaderMetadata(documentId:string,index:{entries:any[];discovery?:{unavailable?:boolean}},items:Record<string,Uint8Array>):Record<string,string[]>{
  const result:Record<string,string[]>={};
  const add=(key:string,value:unknown)=>{if(!EU_DATE_FIELDS.includes(key as typeof EU_DATE_FIELDS[number]))return;
    if(typeof value!=='string')throw new Error('Invalid official header date metadata.');
    result[key]=[...new Set([...(result[key]??[]),value])].sort();};
  for(const entry of index.entries){
    if(!['CELLAR-SPARQL','CELLAR-case-catalog'].includes(entry.kind))continue;
    if(entry.kind==='CELLAR-SPARQL'&&index.discovery?.unavailable)continue;
    const rows=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(items[entry.name])).results?.bindings;
    if(!Array.isArray(rows))throw new Error('Invalid original EU header metadata response.');
    for(const row of rows){
      if(row.id?.value!==documentId)continue;
      if(entry.kind==='CELLAR-case-catalog'){if(row.date?.value!==undefined)add('work_date_document',row.date.value);}
      else if(typeof row.p?.value==='string'&&row.p.value.startsWith('http://publications.europa.eu/ontology/cdm#'))add(row.p.value.slice('http://publications.europa.eu/ontology/cdm#'.length),row.v?.value);
    }
  }
  return result;
}
export function euHeaderDateLines(header:EuDocumentHeader):string{
  const value=(d:EuDate)=>d.value??`niepotwierdzona (${d.status})`;
  return [`Data dokumentu (work_date_document): ${value(header.dates.document)}`,
    `Data konsolidacji (CELEX): ${value(header.dates.consolidation)}`,
    `Data publikacji (metadane publikacji): ${value(header.dates.publication)}`].join('\n');
}
/** EU-only wrapper. The shared NL renderer and legal body remain unchanged. */
export function euLegalMarkdown(header:EuDocumentHeader,context:LegalContext,body:string,labels:string[]):string{
  const text=legalMarkdown(header.title.value,context,body,labels),at=text.indexOf('\n\nKontekst strukturalny:');
  if(at<0)throw new Error('Missing structured EU header boundary.');
  return text.slice(0,at)+'\n\n'+euHeaderDateLines(header)+text.slice(at);
}
export function euLegalHeaderPrefix(text:string):string{
  const at=text.indexOf(LEGAL_START);if(at<0)throw new Error('Missing structured EU header.');return text.slice(0,at);
}
