import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

export const LEGAL_PROFILE='legal-structure-v1' as const;
export const LEGAL_START='<!-- legal-structure-v1 body -->';
export const LEGAL_END='<!-- /legal-structure-v1 body -->';
export type LegalKind='version'|'book'|'part'|'title'|'chapter'|'section'|'article'|'paragraph'|'point'|'recital'|'preamble'|'annex'|'table'|'image'|'footnote'|'holding'|'heading'|'closing'|'other';
export interface LegalContext {corpus:'NL'|'EU';documentId:string;version:string;language:string;sourceUrl:string;sourceSha256:string;metadata?:unknown;sourceFragmentIssues?:string[]}
export interface LegalUnit {
  id:string;anchor:string;parentId:string|null;kind:LegalKind;label:string;order:number;sourceLocator:string;
  sourceTag:string;attributes:Record<string,string|{sha256:string;characters:number}>;officialIdentifiers:{name:string;value:string}[];
  reference?:string;
}
export interface LegalChunk {key:string;body:string;technicalSplit:boolean}
export interface LegalDraft extends LegalContext {profile:typeof LEGAL_PROFILE;units:LegalUnit[];chunks:LegalChunk[]}
export interface LegalLocation {file:string;part:number;start:number;end:number}
export interface LegalUnitRecord extends LegalUnit {start:number;end:number;sha256:string;locations:LegalLocation[]}
export interface LegalManifest extends LegalContext {
  profile:typeof LEGAL_PROFILE;offsetEncoding:'utf16-code-units';bodySha256:string;bodyLength:number;
  parts:{file:string;sequence:number;key:string;sha256:string;characters:number;technicalSplit:boolean}[];
  units:LegalUnitRecord[];
}
export const legalHash=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
export const unitStart=(anchor:string)=>`<!-- legal-unit:${anchor} -->`;
export const unitEnd=(anchor:string)=>`<!-- /legal-unit:${anchor} -->`;
export function legalIdentity(context:LegalContext,locator:string,kind:LegalKind){
  return {id:'unit_'+legalHash(JSON.stringify([context.corpus,context.documentId,context.version,context.language,locator,kind])),
    anchor:'lu_'+legalHash(JSON.stringify([locator,kind])).slice(0,32)};
}
export function legalPartName(prefix:string,chunk:LegalChunk){
  if(!/^[A-Za-z0-9_.-]+$/.test(prefix))throw new Error('Invalid legal part namespace.');
  return `${prefix}__${legalHash(chunk.key).slice(0,24)}.md`;
}

/** Natural cuts are established by source structure. A byte ceiling is used
 * only when a natural group itself cannot fit the technical destination. */
export function planLegalChunks(body:string,groups:{start:number;key:string}[],safeBreaks:number[],maxBytes=94_000_000):LegalChunk[]{
  if(!body||!Number.isSafeInteger(maxBytes)||maxBytes<1||!groups.length||groups[0].start!==0||
    groups.some((g,i)=>!g.key||!Number.isInteger(g.start)||g.start<0||g.start>=body.length||i>0&&g.start<=groups[i-1].start))throw new Error('Invalid legal grouping.');
  const breaks=[...new Set(safeBreaks)].filter(n=>Number.isInteger(n)&&n>0&&n<body.length).sort((a,b)=>a-b);
  const result:LegalChunk[]=[];
  groups.forEach((group,index)=>{
    const end=groups[index+1]?.start??body.length,text=body.slice(group.start,end);
    if(Buffer.byteLength(text)<=maxBytes){result.push({key:group.key,body:text,technicalSplit:false});return;}
    let start=group.start;
    while(start<end){
      let cut=end;
      if(Buffer.byteLength(body.slice(start,end))>maxBytes){
        cut=start;
        for(const candidate of breaks){
          if(candidate<=start||candidate>=end)continue;
          if(Buffer.byteLength(body.slice(start,candidate))>maxBytes)break;
          cut=candidate;
        }
        if(cut===start)throw new Error('No safe internal legal boundary within the technical file limit.');
      }
      result.push({key:group.key+':continuation:'+legalHash(body.slice(start,cut)).slice(0,24),body:body.slice(start,cut),technicalSplit:true});start=cut;
    }
  });
  if(result.map(p=>p.body).join('')!==body)throw new Error('Legal partition lost content.');
  return result;
}

export function indexLegalDocument(draft:LegalDraft,files:string[],bodies:string[]):LegalManifest{
  if(files.length!==bodies.length||files.length!==draft.chunks.length||!files.length||new Set(files).size!==files.length||
    files.some(n=>!/^[A-Za-z0-9_.-]+\.md$/.test(n)))throw new Error('Invalid legal physical files.');
  const body=bodies.join(''),ids=new Set<string>(),anchors=new Set<string>();
  const opens=new Map<string,number>(),closes=new Map<string,number>();
  for(const match of body.matchAll(/<!-- (\/?)legal-unit:(lu_[a-f0-9]{32}) -->/g)){
    const target=match[1]?closes:opens;
    if(target.has(match[2]))throw new Error('Repeated legal unit occurrence.');target.set(match[2],match.index!);
  }
  const parts=files.map((file,i)=>({file,sequence:i+1,key:draft.chunks[i].key,sha256:legalHash(bodies[i]),characters:bodies[i].length,technicalSplit:draft.chunks[i].technicalSplit}));
  const offsets:number[]=[];let offset=0;for(const part of bodies){offsets.push(offset);offset+=part.length;}
  const units=draft.units.map((unit,i):LegalUnitRecord=>{
    if(ids.has(unit.id)||anchors.has(unit.anchor)||unit.order!==i+1||!/^unit_[a-f0-9]{64}$/.test(unit.id)||!/^lu_[a-f0-9]{32}$/.test(unit.anchor))throw new Error('Duplicate or invalid logical unit identity/order.');
    const expected=legalIdentity(draft,unit.sourceLocator,unit.kind);
    if(unit.id!==expected.id||unit.anchor!==expected.anchor)throw new Error('Logical identity differs from source/version.');
    ids.add(unit.id);anchors.add(unit.anchor);
    const close=unitEnd(unit.anchor),start=opens.get(unit.anchor),closing=closes.get(unit.anchor);
    if(start===undefined||closing===undefined||closing<start)throw new Error('Missing or repeated legal unit occurrence.');
    const end=closing+close.length;
    if(!body.slice(start,end).includes(`<a id="${unit.anchor}"></a>`))throw new Error('Logical anchor missing from body.');
    return {...unit,start,end,sha256:legalHash(body.slice(start,end)),locations:files.flatMap((file,part)=>{
      const from=Math.max(start,offsets[part]),to=Math.min(end,offsets[part]+bodies[part].length);
      return from<to?[{file,part:part+1,start:from-offsets[part],end:to-offsets[part]}]:[];
    })};
  });
  if((body.match(/<!-- legal-unit:lu_[a-f0-9]{32} -->/g)??[]).length!==units.length||
    (body.match(/<!-- \/legal-unit:lu_[a-f0-9]{32} -->/g)??[]).length!==units.length)throw new Error('Unindexed logical content.');
  const byId=new Map(units.map(u=>[u.id,u]));
  if(units.filter(u=>u.parentId===null).length!==1||units[0]?.kind!=='version'||units[0].start!==0||units[0].end!==body.length)throw new Error('Invalid legal version root.');
  for(const unit of units){
    if(unit.parentId!==null){const parent=byId.get(unit.parentId);
      if(!parent||parent.order>=unit.order||parent.start>=unit.start||parent.end<=unit.end)throw new Error('Invalid logical hierarchy.');}
  }
  for(let i=1;i<units.length;i++)if(units[i].start<=units[i-1].start)throw new Error('Legal source order changed.');
  const families=new Map<string,LegalUnitRecord[]>();
  for(const unit of units)if(unit.parentId){const siblings=families.get(unit.parentId)??[];siblings.push(unit);families.set(unit.parentId,siblings);}
  for(const children of families.values()){
    if(children.some((u,i)=>i>0&&u.start<children[i-1].end))throw new Error('Overlapping legal sibling units.');
  }
  const {chunks:_,units:__,...context}=draft;
  return {...context,offsetEncoding:'utf16-code-units',bodySha256:legalHash(body),bodyLength:body.length,parts,units};
}
export function validateLegalDocument(manifest:LegalManifest,readBody:(file:string)=>string):string{
  if(manifest.profile!==LEGAL_PROFILE||manifest.offsetEncoding!=='utf16-code-units'||!manifest.parts?.length||!Array.isArray(manifest.units))throw new Error('Unknown or incomplete legal manifest.');
  const bodies=manifest.parts.map((part,i)=>{const body=readBody(part.file);
    if(part.sequence!==i+1||part.characters!==body.length||part.sha256!==legalHash(body))throw new Error('Legal physical part changed or reordered.');return body;});
  const {parts:_,bodySha256:__,bodyLength:___,offsetEncoding:____,units,...context}=manifest;
  const draft:LegalDraft={...context,units:units.map(({start:_,end:__,sha256:___,locations:____,...u})=>u),
    chunks:manifest.parts.map((p,i)=>({key:p.key,body:bodies[i],technicalSplit:p.technicalSplit}))};
  const actual=indexLegalDocument(draft,manifest.parts.map(p=>p.file),bodies);
  if(!isDeepStrictEqual(actual,manifest))throw new Error('Legal unit index differs from reconstructed content.');
  return bodies.join('');
}
export function extractLegalBody(markdown:string):string{
  const start=markdown.indexOf(LEGAL_START),end=markdown.lastIndexOf(LEGAL_END);
  if(start<0||end<=start||markdown.indexOf(LEGAL_START,start+LEGAL_START.length)>=0||markdown.indexOf(LEGAL_END)!==end)throw new Error('Invalid legal body framing.');
  if(markdown.slice(start+LEGAL_START.length,start+LEGAL_START.length+1)!=='\n'||markdown.slice(end-1,end)!=='\n')throw new Error('Invalid legal body delimiter.');
  return markdown.slice(start+LEGAL_START.length+1,end-1);
}
export function legalMarkdown(title:string,context:LegalContext,body:string,contextLabels:string[]):string{
  const label=(s:string)=>s.replace(/[\r\n]+/g,' ').replace(/([\\\[\]<>])/g,'\\$1');
  return `# ${label(title)}\n\n${context.corpus} · ${label(context.documentId)} · ${label(context.version)} · ${label(context.language)}\n\n`+
    `Kontekst strukturalny: ${contextLabels.map(label).join(' → ')}\n\nŹródło: ${context.sourceUrl}\n\n${LEGAL_START}\n${body}\n${LEGAL_END}\n`;
}
export function legalIndexRows(manifest:LegalManifest):string[]{
  return manifest.units.filter(u=>['article','annex','holding','preamble'].includes(u.kind)||u.kind==='paragraph'&&!!u.reference).map(unit=>{
    const location=unit.locations[0];return `- [${unit.label.replace(/[\r\n]/g,' ').replace(/([\\\[\]])/g,'\\$1')||unit.kind}](${location.file}#${unit.anchor}) — ${manifest.version}; ${unit.id}`;
  });
}
export function legalChunkContext(draft:LegalDraft,body:string):string[]{
  const anchor=/<!-- legal-unit:(lu_[a-f0-9]{32}) -->/.exec(body)?.[1];
  let unit=draft.units.find(u=>u.anchor===anchor)??draft.units[0];
  const labels:string[]=[];const byId=new Map(draft.units.map(u=>[u.id,u]));
  for(let count=0;unit&&count<draft.units.length;count++){
    labels.unshift(unit.label||unit.kind);if(!unit.parentId)break;unit=byId.get(unit.parentId)!;
  }
  return labels;
}
