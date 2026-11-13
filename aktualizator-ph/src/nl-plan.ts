import type { NlModel } from './nl-model.js';
import { articleBlock, nlHeader } from './nl-format.js';
import { normalizeOutput } from './output.js';

export const TARGET_MAX_FILE_SIZE = 50_000;
export interface NlPartPlan {name: string; articles: string[]; predictedSize: number}
function safeSlug(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 70);
}

// Layout planning preserves every article together with all its versions.
// The final local source-ID widths are included without rerendering candidates.
export function planNlParts(model: NlModel): NlPartPlan[] {
  const act = model.act, header = nlHeader(model);
  const articleStates = new Map(model.articles.map(a => [a.articleId, a.versions]));
  const present = model.articles.filter(a => a.versions.length).map(a => a.articleId);
  const parts: NlPartPlan[] = [];

  // Render article blocks once for sizing with S1 placeholders. The exact
  // correction below counts every reference and definition's final ID width.
  const allUrls=[...new Set(model.states.flatMap(state => state.sourceUrls))];
  const placeholders=new Map(allUrls.map(url=>[url,'S1']));
  const sizes=new Map(present.map(article=>[article,Buffer.byteLength(normalizeOutput(articleBlock(article,articleStates.get(article)!,placeholders)))]));
  const counts=new Map(present.map(article=>{
    const refs=new Map<string,number>();
    for(const state of articleStates.get(article)!)for(const url of state.sourceUrls)refs.set(url,(refs.get(url)??0)+1);
    return [article,refs] as const;
  }));
  const definitionBytes=new Map(allUrls.map(url=>[url,Buffer.byteLength(normalizeOutput(`[^S1]: ${url}`))-1]));
  const headerBytes=Buffer.byteLength(normalizeOutput(header+'X').slice(0,-2));
  let current: string[] = [];
  let blockBytes=0,refs=new Map<string,number>(),predicted=0;
  const addRefs=(article:string,base:Map<string,number>)=>{
    const next=new Map(base);for(const [url,count]of counts.get(article)!)next.set(url,(next.get(url)??0)+count);return next;
  };
  const predict=(articles:number,blocks:number,sources:Map<string,number>)=>{
    const urls=[...sources.keys()].sort();
    return headerBytes+blocks+articles-1+Buffer.byteLength('\n## Źródła\n\n')+urls.length+
      urls.reduce((n,url,i)=>n+definitionBytes.get(url)!+(String(i+1).length-1)*(1+sources.get(url)!),0);
  };
  const flush = () => {
    if (!current.length) return;
    const fileName = `${String(act.order).padStart(2, '0')}_${act.bwbId}_${safeSlug(act.title)}__${String(parts.length+1).padStart(2, '0')}.md`;
    parts.push({name: fileName, articles: current, predictedSize: predicted});
    current = [];
    blockBytes=0;refs=new Map();predicted=0;
  };
  for (const article of present) {
    let candidateRefs=addRefs(article,refs),candidateBytes=blockBytes+sizes.get(article)!;
    if(current.length&&predict(current.length+1,candidateBytes,candidateRefs)>TARGET_MAX_FILE_SIZE){
      flush();candidateRefs=addRefs(article,refs);candidateBytes=sizes.get(article)!;
    }
    current.push(article);
    refs=candidateRefs;blockBytes=candidateBytes;predicted=predict(current.length,blockBytes,refs);
  }
  flush();

  return parts;
}
