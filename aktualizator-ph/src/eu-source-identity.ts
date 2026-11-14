import {load} from 'cheerio';
import type {CellarIndex} from './eu-provider.js';

import {celexPattern} from './eu-identifiers.js';
function declaredCelex(value:string):string|undefined{
  const clean=value.trim().replace(/^CELEX:/i,'');
  if(celexPattern.test(clean))return clean;
  try{
    const u=new URL(clean),candidate=u.searchParams.get('uri')?.replace(/^CELEX:/i,'')??
      (u.pathname.includes('/celex/')?decodeURIComponent(u.pathname.split('/celex/')[1]):undefined);
    if(candidate&&celexPattern.test(candidate))return candidate;
  }catch{/* Not every official identifier is a URL or a CELEX. */}
}
export function assertEuSourceIdentity(html:string,sourceUrl:string,expected:string,index?:CellarIndex):void{
  const $=load(html),title=$('head title').text().replace(/\s+/g,' ').trim(),declared:string[]=[];
  // Consolidations name the original act and documentary layer separately.
  const consolidation=title.match(/^(?:Consolidated TEXT|Tekst skonsolidowany|Skonsolidowany tekst|Texte consolidé|Geconsolideerde tekst):\s*(3\d{4}[LRD]\d{4}(?:\(\d{2}\))?)\s*[—–-]\s*(?:EN|PL|NL|FR)\s*[—–-]\s*(\d{2})\.(\d{2})\.(\d{4})/i);
  if(consolidation)declared.push(`0${consolidation[1].slice(1)}-${consolidation[4]}${consolidation[3]}${consolidation[2]}`);
  else{
    const id=declaredCelex(title.replace(/^EUR-Lex\s*-\s*/i,'').replace(/\s*-\s*(?:EN|PL|NL|FR)$/i,''));
    if(id)declared.push(id);
  }
  $('head meta[name],head link[rel="canonical"]').each((_i,node)=>{
    const name=($(node).attr('name')??'').toLowerCase();
    if(!['dc.identifier','dcterms.identifier','dc.identifier.uri'].includes(name)&&node.tagName!=='link')return;
    const id=declaredCelex($(node).attr(node.tagName==='link'?'href':'content')??'');if(id)declared.push(id);
  });
  if(declared.some(id=>id!==expected))throw new Error(`EU source identity mismatch: expected ${expected}.`);
  const u=new URL(sourceUrl);
  if(!['https:','http:'].includes(u.protocol)||!['publications.europa.eu','eur-lex.europa.eu'].includes(u.hostname)||
    u.username||u.password||u.port)throw new Error('Unexpected EU identity source URL.');
  const urlId=declaredCelex(sourceUrl);
  if(urlId&&urlId!==expected)throw new Error('EU source redirect CELEX mismatch.');
  if(u.pathname.startsWith('/resource/cellar/')){
    // The returned stream must be one of the requested CELEX/language's items;
    // sharing only a work UUID is insufficient to establish the expression.
    u.protocol='https:';
    if(!index||!index.rows.some(r=>r.item===u.href&&['html','xhtml','html_simplified','xhtml_simplified'].includes(r.format)))
      throw new Error('EU XHTML is not bound to the requested CELEX/language in the WEMI index.');
  }else if(!declared.includes(expected))throw new Error('EU XHTML has no independently confirmed document identity.');
}
