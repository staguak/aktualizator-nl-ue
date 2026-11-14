import test from 'node:test';
import assert from 'node:assert/strict';
import {parseEuHtml} from './eu-parser.js';
import {firstEuLanguage,EU_LANGUAGE_ORDER,languageCode,preferredEuLanguages,unicodeLength} from './eu-language.js';
import type {EuLanguage} from './eu-language.js';
import {fetchEuText,preferredFormexIndex,selectEuDocuments} from './eu-provider.js';
import type {CellarIndex,EuDocument} from './eu-provider.js';
import {SourceHttpError} from './source-cache.js';
import {zipSync} from 'fflate';

const celex='32003L0088',work='https://publications.europa.eu/resource/cellar/050dd964-4f94-4c61-ab50-89217a0d90e2';
const document:EuDocument={celex,include:'full-document',metadata:{},role:'original'};
const source=(text:string,url:string)=>({text,bytes:Buffer.from(text),url,contentType:'application/xml'});
function bindings(language:EuLanguage,format:string){return [{work:{value:work},expression:{value:work+'.0001'},language:{value:'http://publications.europa.eu/resource/authority/language/'+languageCode(language)},manifestation:{value:work+'.0001.01'},format:{value:format},item:{value:work+'.0001.01/DOC_1'}}];}
function index(language:EuLanguage,format:string):CellarIndex {
  return {language,work,requestedUrl:'https://publications.europa.eu/webapi/rdf/sparql',source:source('{}',work),rows:[{work,expression:work+'.0001',manifestation:work+'.0001.01',format}]};
}
const languageOf=(query:string):EuLanguage=>EU_LANGUAGE_ORDER.find(language=>query.includes('/'+languageCode(language)))!;
const longText='Legal article text preserving punctuation and original order. '.repeat(20);
function html(language:EuLanguage):string{
  const heading=language==='PL'?'Artykuł 1':language==='NL'?'Artikel 1':'Article 1';
  return `<html lang="${language.toLowerCase()}"><head><title>EUR-Lex - ${celex} - ${language}</title></head><body><p class="oj-ti-art">${heading}</p><p>${longText}</p></body></html>`;
}

test('language preference is EN, PL, NL, FR and stops at the first available result',async()=>{
  const visited:EuLanguage[]=[];
  const result=await firstEuLanguage(EU_LANGUAGE_ORDER,async language=>{visited.push(language);if(language!=='PL')throw new Error('unavailable');return 'Polish source';},()=>true);
  assert.deepEqual(visited,['EN','PL']);assert.equal(result.language,'PL');
  await assert.rejects(firstEuLanguage(EU_LANGUAGE_ORDER,async()=>{throw new SourceHttpError(503);},error=>error instanceof SourceHttpError&&error.status===404),/503/);
  assert.deepEqual(preferredEuLanguages(['http://publications.europa.eu/resource/authority/language/FRA','http://publications.europa.eu/resource/authority/language/POL']),['PL','FR']);
});

test('preferred discovery includes Polish/French versions but explicit Dutch scope remains unchanged',()=>{
  const act={order:1,title:'Directive',celex,include:'full-document' as const,requiredVersions:[],attachedDocuments:[]};
  const french={celex:'02003L0088-20250101',role:'consolidated',include:'full-document',metadata:{available_language:['http://publications.europa.eu/resource/authority/language/FRA']}};
  assert.deepEqual(selectEuDocuments([french],act,'2025-01-01','2026-11-13','preferred').map(doc=>doc.celex),[french.celex]);
  assert.equal(selectEuDocuments([french],act,'2025-01-01','2026-11-13','NL').length,0);
});

test('a missing English Formex uses Polish Formex first and does not inspect later translations',async()=>{
  const visited:EuLanguage[]=[];const en=index('EN','html');
  const result=await preferredFormexIndex(celex,en,EU_LANGUAGE_ORDER,async(url)=>{
    const language=languageOf(new URL(url).searchParams.get('query')!);visited.push(language);
    return source(JSON.stringify({results:{bindings:bindings(language,'fmx4')}}),url);
  });
  assert.equal(result?.language,'PL');assert.deepEqual(visited,['PL']);
  visited.length=0;
  assert.equal((await preferredFormexIndex(celex,index('EN','fmx4'),EU_LANGUAGE_ORDER,async()=>{throw new Error('Should not query translations');}))?.language,'EN');
});

test('Formex language fallback does not turn an index failure into absence',async()=>{
  const visited:EuLanguage[]=[];
  await assert.rejects(preferredFormexIndex(celex,index('EN','html'),EU_LANGUAGE_ORDER,async(url)=>{
    visited.push(languageOf(new URL(url).searchParams.get('query')!));throw new SourceHttpError(503);
  }),/503/);
  assert.deepEqual(visited,['PL']);
});

test('English legal text stays English while optional Formex lookup examines other languages',async()=>{
  const textLanguages:string[]=[];
  const result=await fetchEuText(document,'EN',async(url,headers)=>{
    if(headers.Accept==='application/sparql-results+json'){
      const language=languageOf(new URL(url).searchParams.get('query')!);
      return source(JSON.stringify({results:{bindings:language==='EN'?bindings('EN','html'):[]}}),url);
    }
    if(headers.Accept.startsWith('application/rdf+xml'))return source('<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="'+work+'"/></rdf:RDF>',url);
    textLanguages.push(headers['Accept-Language']);return source(html('EN'),url);
  });
  assert.equal(result.language,'EN');assert.deepEqual(textLanguages,['eng']);assert.equal(result.html,html('EN'));
  assert.equal(result.nativeSources?.filter(entry=>entry.kind==='CELLAR-XHTML').length,1);
});

test('only missing English text permits a complete Polish document, retaining actual language',async()=>{
  const textLanguages:string[]=[];
  const result=await fetchEuText(document,'EN',async(url,headers)=>{
    if(headers.Accept==='application/sparql-results+json'){
      const language=languageOf(new URL(url).searchParams.get('query')!);
      return source(JSON.stringify({results:{bindings:language==='PL'?bindings('PL','html'):[]}}),url);
    }
    if(headers.Accept.startsWith('application/rdf+xml'))return source('<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="'+work+'"/></rdf:RDF>',url);
    textLanguages.push(headers['Accept-Language']);if(headers['Accept-Language']==='eng')throw new SourceHttpError(404);
    return source(html('PL'),url);
  });
  assert.equal(result.language,'PL');assert.deepEqual(textLanguages,['eng','eng','pol']);
  assert(result.nativeSources?.some(entry=>entry.kind==='CELLAR-XHTML'&&(entry.metadata as any).language==='PL'));
  assert(result.nativeIssues?.some(issue=>issue.code==='TEXT_LANGUAGE_FALLBACK'));
});

test('supplemental Polish Formex has its own language and cannot replace the English legal text',async()=>{
  const packageBytes=Buffer.from(zipSync({'OJ_L_2003299PL.xml':Buffer.from('<ACT><ARTICLE IDENTIFIER="art_1"><TI.ART>Artykuł 1</TI.ART><PARAG>Treść urzędowa.</PARAG></ARTICLE></ACT>')}));
  const queried:EuLanguage[]=[],downloads:string[]=[];
  const result=await fetchEuText(document,'EN',async(url,headers)=>{
    if(headers.Accept==='application/sparql-results+json'){
      const language=languageOf(new URL(url).searchParams.get('query')!);queried.push(language);
      return source(JSON.stringify({results:{bindings:bindings(language,language==='EN'?'html':'fmx4')}}),url);
    }
    if(headers.Accept.startsWith('application/rdf+xml'))return source('<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="'+work+'"/></rdf:RDF>',url);
    return source(html('EN'),url);
  },async(url,headers)=>{downloads.push(headers['Accept-Language']);return {bytes:packageBytes,url,contentType:'application/zip'};});
  assert.equal(result.language,'EN');assert.equal(result.html,html('EN'));assert.deepEqual(queried,['EN','PL']);assert.deepEqual(downloads,['pol']);
  const formex=result.nativeSources?.find(entry=>entry.kind==='CELLAR-Formex4');assert(formex);
  assert.deepEqual(formex.source.bytes,packageBytes);assert.equal((formex.metadata as any).language,'PL');assert.equal((formex.metadata as any).textLanguage,'EN');assert.equal((formex.metadata as any).supplemental,true);
});

test('indexed English text retrieval/validation failure is not concealed by Polish text',async()=>{
  const visited:string[]=[];
  await assert.rejects(fetchEuText(document,'EN',async(url,headers)=>{
    if(headers.Accept==='application/sparql-results+json')return source(JSON.stringify({results:{bindings:bindings('EN','html')}}),url);
    visited.push(headers['Accept-Language']??'item');throw new SourceHttpError(503);
  }),/Indexed EN legal text/);
  assert(!visited.includes('pol'));
});

test('Polish/French article labels and declared language are validated',()=>{
  for(const language of ['PL','FR'] as const){
    const parsed=parseEuHtml(html(language),work,'full-document',language);assert.equal(parsed.articleCount,1);assert(parsed.chunks[0].includes(longText.trim()));
    assert.throws(()=>parseEuHtml(html(language==='PL'?'FR':'PL'),work,'full-document',language),/language/);
  }
});

test('Polish and French operative parts retain exactly five disposition points',()=>{
  for(const [language,intro,title] of [['PL','Z powyższych względów Trybunał (wielka izba) orzeka, co następuje:','Wyrok'],['FR','Par ces motifs, la Cour (grande chambre) déclare et arrête :','Arrêt']] as const){
    const make=(points:number)=>`<html lang="${language.toLowerCase()}"><body><p>${title}</p><p>${intro}</p>${Array.from({length:points},(_,i)=>`<p class="C08Dispositif">${i+1}) ${longText}</p>`).join('')}</body></html>`;
    const parsed=parseEuHtml(make(5),work,'operative-part',language);
    assert(parsed.chunks.join('\n').includes('5)'));assert.throws(()=>parseEuHtml(make(4),work,'operative-part',language),/five-point/);
  }
});

test('legacy layout does not reject a complete article at the withdrawn character cap',()=>{
  const make=(size:number)=>`<html lang="en"><body><p>Directive</p><p class="oj-ti-art">Article 1</p><p>${'a'.repeat(size)}</p></body></html>`;
  const parsed=parseEuHtml(make(550_000),work,'full-document','EN');
  const articleParts=parsed.chunks.filter(chunk=>chunk.includes('Article 1'));
  assert.equal(articleParts.length,1);assert(articleParts[0].includes('a'.repeat(550_000)));
  const large=parseEuHtml(make(600_000),work,'full-document','EN');
  const complete=large.chunks.filter(chunk=>chunk.includes('Article 1'));
  assert.equal(complete.length,1);assert(complete[0].includes('a'.repeat(600_000)));
  assert.equal(unicodeLength('😀a'),2);
});
