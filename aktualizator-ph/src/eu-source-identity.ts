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
function cleanEurLexTitle(title:string):string|undefined{
  let clean=title.replace(/^EUR-Lex\s*-\s*/i,'');
  const match=/-\s*(?:EN|PL|NL|FR)$/i.exec(clean);
  if(match)clean=clean.slice(0,match.index).trimEnd();
  return declaredCelex(clean);
}
export function assertEuSourceIdentity(html:string,sourceUrl:string,expected:string,index?:CellarIndex):void{
  const $=load(html),title=$('head title').text().replace(/\s+/g,' ').trim(),declared:string[]=[];
  // Consolidations name the original act and documentary layer separately.
  // A linear, staged read avoids reconsidering long malformed CELEX titles.
  const prefix=/^(?:Consolidated TEXT|Tekst skonsolidowany|Skonsolidowany tekst|Texte consolidé|Geconsolideerde tekst):/i.exec(title);
  let consolidation:string|undefined;
  if(prefix){
    let rest=title.slice(prefix[0].length).trimStart();
    const act=/^3\d{4}[LRD]\d{4}(?:\(\d{2}\))?/i.exec(rest);
    if(act){
      rest=rest.slice(act[0].length).trimStart();
      if(rest[0]==='—'||rest[0]==='–'||rest[0]==='-'){
        rest=rest.slice(1).trimStart();
        const language=/^(?:EN|PL|NL|FR)/i.exec(rest);
        if(language){
          rest=rest.slice(language[0].length).trimStart();
          if(rest[0]==='—'||rest[0]==='–'||rest[0]==='-'){
            rest=rest.slice(1).trimStart();
            const date=/^(\d{2})\.(\d{2})\.(\d{4})/.exec(rest);
            if(date)consolidation=`0${act[0].slice(1)}-${date[3]}${date[2]}${date[1]}`;
          }
        }
      }
    }
  }
  if(consolidation)declared.push(consolidation);
  else{
    const id=cleanEurLexTitle(title);
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
