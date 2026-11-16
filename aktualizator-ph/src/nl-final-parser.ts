import { NL_START, NL_END } from './content-integrity.js';

/** Read complete version bodies with monotonic delimiter searches. */
export function scanNlVersions(section:string):string[][]{
  const results:string[][]=[];
  const start=/^### V=([^\n]*)\n\n<!-- NL source text -->\n/gm;
  const footer='\n<!-- /NL source text -->\n\nŹródła: ';
  let match:RegExpExecArray|null;
  while((match=start.exec(section))!==null){
    const dates=/^([^ \n]+) – ([^ \n]+)/.exec(match[1]);
    if(!dates)continue;
    const close=section.indexOf(footer,start.lastIndex);
    if(close<0)continue;
    const refsStart=close+footer.length,refsEnd=section.indexOf('\n',refsStart);
    if(refsEnd<0||refsEnd===refsStart)continue;
    results.push([match[0],dates[1],dates[2],section.slice(start.lastIndex,close),section.slice(refsStart,refsEnd)]);
    start.lastIndex=refsEnd+1;
  }
  return results;
}

export function parseNlFinal(content:string) {
  const sourceSection=content.lastIndexOf('\n## Źródła\n');
  if(sourceSection<0)throw new Error('NL source definitions missing.');
  const definitions=[...content.slice(sourceSection).matchAll(/^\[\^(S\d+)\]: (https?:\/\/\S+)$/gm)];
  const sources=new Map(definitions.map(m=>[m[1],m[2]]));
  if(sources.size!==definitions.length||new Set(sources.values()).size!==sources.size)throw new Error('Duplicate NL source.');
  const body=content.slice(0,sourceSection),used=new Set<string>();
  const blocks=[...body.matchAll(/^## Artikel ([^\n]+)\n([\s\S]*?)(?=^## Artikel |$(?![\s\S]))/gm)];
  const articles=blocks.map(m=>({articleId:m[1],versions:scanNlVersions(m[2]).map(v=>{
    const refs=[...v[4].matchAll(/\[\^(S\d+)\]/g)].map(r=>r[1]);
    if(!refs.length||refs.map(r=>`[^${r}]`).join(' ')!==v[4]||new Set(refs).size!==refs.length)throw new Error('Invalid NL source references.');
    for(const ref of refs){if(!sources.has(ref))throw new Error('Undefined NL source.');used.add(ref);}
    return {validFrom:v[1]==='?'?null:v[1],validTo:v[2]==='open'?null:v[2],content:v[3],sourceCount:refs.length,sourceUrls:refs.map(ref=>sources.get(ref)!)};
  })}));
  if(!articles.length||articles.some(a=>!a.versions.length)||used.size!==sources.size||
    body.split(NL_START).length-1!==articles.reduce((n,a)=>n+a.versions.length,0)||
    body.split(NL_END).length!==body.split(NL_START).length)throw new Error('Invalid NL logical output.');
  return articles;
}
