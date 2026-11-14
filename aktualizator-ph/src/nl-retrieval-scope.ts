import {load} from 'cheerio';
import {isDeepStrictEqual} from 'node:util';
import type {NlActManifest} from './nl-output.js';

/** Compare full-act article/state coverage against original XML, independently
 * of the model's selector resolver and file planner. Other legal containers
 * remain in the originals; their structured Markdown view is a later stage. */
export function assertFullNlSourceCoverage(act:NlActManifest,index:any,items:Record<string,Uint8Array>,from:string,to:string):void{
  if(act.retrievalScope!=='full-act')return;
  const expected=new Set<string>(),seenStates=new Set<number>();
  for(const entry of index.entries.filter((e:any)=>e.kind==='BWB-Toestand')){
    const state=act.sourceStates.find(s=>s.key===entry.metadata?.version?.key);
    if(!state||seenStates.has(state.index))throw new Error('Full NL source-state coverage differs from original XML.');
    seenStates.add(state.index);
    if(state.validFrom&&state.validFrom>to||state.validTo&&state.validTo<from)continue;
    const xml=new TextDecoder('utf-8',{fatal:true}).decode(items[entry.name]),$=load(xml,{xmlMode:true});
    if($('toestand').attr('bwb-id')!==act.bwbId)throw new Error('Full NL source identity mismatch.');
    const refs=new Set<string>();
    $('wetgeving artikel').each((_i,node)=>{
      const article=$(node);
      if(article.parents('artikel,meta-data,bwb-inputbestand,bwb-wijzigingen,redactionele-correcties').length)return;
      const kop=article.children('kop');
      const number=(article.attr('nr')||kop.children('nr').text()||(/^ee?nig artikel$/i.test(kop.children('label').text().trim())?'enig':'')).trim();
      if(!number)throw new Error('Unidentified article in full NL source.');
      const body=article.clone();body.children('kop,meta-data').remove();
      if(!body.text().trim())return;
      const book=article.parents('boek').toArray().map(book=>{
        const element=$(book);return (element.attr('nr')||element.children('kop').children('nr').text()).trim();
      }).find(value=>/^\d+$/.test(value));
      const ref=book?`${book}:${number}`:number;
      if(refs.has(ref))throw new Error('Ambiguous article identity in original NL state.');
      refs.add(ref);expected.add(JSON.stringify([ref,state.index]));
    });
  }
  if(seenStates.size!==act.sourceStates.length)throw new Error('Missing original XML for a full NL state.');
  const actual=new Set<string>();
  for(const article of act.articles)for(const version of article.versions)for(const state of version.sourceStates){
    const key=JSON.stringify([article.articleId,state]);
    if(actual.has(key))throw new Error('Duplicate full NL article/state attribution.');actual.add(key);
  }
  if(!expected.size||!isDeepStrictEqual(actual,expected))throw new Error('Full NL article coverage differs from original XML.');
}
