import {load} from 'cheerio';
import {sourceTree,nodeText,descendants,renderLegalTree,vectorTags} from './legal-tree.js';
import type {LegalSourceNode,LegalTreeRules} from './legal-tree.js';
import type {LegalContext,LegalKind,LegalDraft} from './legal-structure.js';
import {htmlIntegrity,assertEuIntegrity} from './content-integrity.js';

const normalized=(n:LegalSourceNode)=>nodeText(n).replace(/\s+/g,' ').trim();
const article=/^(?:Article|Artikel|Artykuł|Art\.)\s*(\d+[a-z]*|premier|unique|pierwszy|jedyny)\s*$/iu;
const articlePrefix=/^(?:Article|Artikel|Artykuł|Art\.)\s*(\d+[a-z]*|premier|unique|pierwszy|jedyny)\b/iu;
const sectionWords: [RegExp,LegalKind,number][]=[
  [/^(?:BOOK|BOEK|LIVRE|KSIĘGA)\s+[IVXLCDM\d]+\b/iu,'book',1],
  [/^(?:PART|DEEL|PARTIE|CZĘŚĆ)\s+[IVXLCDM\d]+\b/iu,'part',2],
  [/^(?:TITLE|TITEL|TITRE|TYTUŁ)\s+[IVXLCDM\d]+\b/iu,'title',3],
  [/^(?:CHAPTER|HOOFDSTUK|CHAPITRE|ROZDZIAŁ)\s+[IVXLCDM\d]+\b/iu,'chapter',4],
  [/^(?:SECTION|AFDELING|SEKCJA|DZIAŁ)\s+[IVXLCDM\d]+\b/iu,'section',5],
];
const annex=/^(?:[A-Z]\.\s*)?(?:\d+\.\s*)?(?:ANNEX(?:E)?|APPENDIX|BIJLAGE|BĲLAGE|AANHANGSEL|ZAŁĄCZNIK|DODATEK|PROTOCOL(?:E)?|PROTOKÓŁ|DECLARATION|DÉCLARATION|DEKLARACJA)(?:\s|$)/iu;
const headingClass=/(?:^|\s)(?:oj-ti-|ti-art|C\d+Titre|title-|doc-ti|oj-doc-ti)/i;
const articleClass=/(?:^|\s)(?:oj-ti-art|ti-art)(?:\s|$)/i;
function explicitKind(node:LegalSourceNode):LegalKind|undefined{
  if(node.tag==='article'||/^(?:art|article)[_-][a-z0-9_-]+$/i.test(node.attributes.id??''))return 'article';
  if(/^(?:anx|annex)[_-][a-z0-9_-]+$/i.test(node.attributes.id??''))return 'annex';
  if(node.tag==='section')return 'section';
  return;
}
function heading(node:LegalSourceNode):{kind:LegalKind;level:number;label:string;reference?:string}|undefined{
  if(!['p','h1','h2','h3','h4','h5','h6'].includes(node.tag))return;
  const text=normalized(node),cls=node.attributes.class??'';
  if(article.test(text)||articleClass.test(cls))return {kind:'article',level:10,label:text,reference:(article.exec(text)??articlePrefix.exec(text))?.[1]};
  if(annex.test(text))return {kind:'annex',level:0,label:text};
  for(const [pattern,kind,level] of sectionWords)if(pattern.test(text))return {kind,level,label:text};
  if(/^On those grounds|^Het Hof.*verklaart|^Par ces motifs|^Z (?:powyższych|tych) względów/iu.test(text))return {kind:'holding',level:0,label:text};
  if(/^h[1-6]$/.test(node.tag)||/C\d+Titre/i.test(cls))return {kind:'section',level:6,label:text};
}
function virtual(node:LegalSourceNode,kind:LegalKind,label:string,children:LegalSourceNode[],level?:number,reference?:string):LegalSourceNode{
  return {tag:'legal-group',attributes:{},locator:node.locator+'::'+kind,kind,label,children,synthetic:true,level,reference};
}
/** A flat EUR-Lex article heading starts a structural article, never a text
 * search hit elsewhere in a paragraph. Actual source containers take priority. */
function infer(node:LegalSourceNode,inside?:LegalKind,caseLaw=false):LegalSourceNode{
  const own=explicitKind(node);if(own){node.kind=own;inside=own;
    const title=node.children.find(n=>heading(n));node.label=node.label??(title?normalized(title):normalized(node).slice(0,240));
    if(own==='article')node.reference=(title?heading(title)?.reference:undefined)??/^(?:art|article)[_-](.+)$/i.exec(node.attributes.id??'')?.[1];
  }
  const children=node.children.map(child=>infer(child,inside,caseLaw));
  const result:LegalSourceNode[]=[],sections:LegalSourceNode[]=[];
  let leaf:LegalSourceNode|undefined,annexNode:LegalSourceNode|undefined;
  const parent=()=>leaf??sections.at(-1)??annexNode;
  const append=(child:LegalSourceNode,target=parent())=>{if(target)target.children.push(child);else result.push(child);};
  for(const child of children){
    const h=heading(child);
    if(h&&!['article','annex','table'].includes(inside??'')){
      if(h.kind==='article'){
        leaf=undefined;const group=virtual(child,'article',h.label,[],h.level,h.reference);append(group,sections.at(-1)??annexNode);child.kind='heading';group.children.push(child);leaf=group;continue;
      }
      if(h.kind==='annex'||h.kind==='holding'){
        leaf=undefined;sections.length=0;const group=virtual(child,h.kind,h.label,[],h.level);result.push(group);child.kind='heading';group.children.push(child);leaf=group;annexNode=h.kind==='annex'?group:undefined;continue;
      }
      leaf=undefined;
      while(sections.length&&(sections.at(-1)!.level??0)>=h.level)sections.pop();
      const group=virtual(child,h.kind,h.label,[],h.level);append(group,sections.at(-1)??annexNode);child.kind='heading';group.children.push(child);sections.push(group);continue;
    }
    if(h&&inside==='article')child.kind='heading';
    if(child.kind==='article'||child.kind==='annex'||child.kind==='section')leaf=undefined;
    append(child);
  }
  // Recitals form a preamble before the first substantive structural group.
  const firstStructure=result.findIndex(n=>['article','book','part','title','chapter','section','annex','holding'].includes(n.kind??''));
  const boundary=firstStructure<0?result.length:firstStructure;
  const start=result.findIndex((n,i)=>i<boundary&&(n.kind==='recital'||/^(?:Whereas|Overwegende|Considérant|Mając na uwadze)/iu.test(normalized(n))));
  if(!caseLaw&&start>=0&&!['article','annex','preamble'].includes(inside??'')){
    const group=virtual(result[start],'preamble','Preamble / recitals',result.slice(start,boundary));
    result.splice(start,boundary-start,group);
  }
  node.children=result;
  if(!node.kind){
    const cls=node.attributes.class??'',id=node.attributes.id??'';
    if(node.tag==='table')node.kind='table';
    else if(node.tag==='img'||node.tag==='svg')node.kind='image';
    else if(/(?:footnote|note-body|oj-note)/i.test(cls)||/^(?:fn|footnote)[_-]/i.test(id))node.kind='footnote';
    else if(!caseLaw&&node.tag==='p'&&/^\s*\(\d+\)/.test(nodeText(node))&&!inside)node.kind='recital';
    else if(node.tag==='p'&&/C\d+Point|C08Dispositif/i.test(cls))node.kind='point';
    else if(node.tag==='p'||node.tag==='li')node.kind=node.tag==='li'?'point':'paragraph';
    else if(/^h[1-6]$/.test(node.tag)||headingClass.test(cls))node.kind='heading';
  }
  return node;
}
function courtParagraphs(node:LegalSourceNode):void{
  if(node.tag==='p'&&/C\d+Pointnumerote/i.test(node.attributes.class??'')){
    const number=/^(\d+)[.)]?(?:\s|$)/.exec(normalized(node))?.[1];
    if(number){node.kind='paragraph';node.reference=number;node.label='Paragraph '+number;}
  }
  node.children=node.children.map(child=>{
    courtParagraphs(child);
    if(child.tag!=='table')return child;
    const counts=descendants(child,n=>n.tag==='p'&&/(?:^|\s)coj-count(?:\s|$)/.test(n.attributes.class??'')&&
      !n.locator.slice(child.locator.length).includes('/table['));
    const reference=counts.length===1?/^(\d+)[.)]?$/.exec(normalized(counts[0]))?.[1]:undefined;
    return reference?virtual(child,'paragraph','Paragraph '+reference,[child],undefined,reference):child;
  });
}
function contextualUnits(node:LegalSourceNode,articleContext=false):void{
  const inside=articleContext||node.kind==='article';
  if(inside&&node.kind==='recital')node.kind='paragraph';
  node.children.forEach(child=>contextualUnits(child,inside));
}
const transparent=new Set(['div','section','article','main','header','footer']);
const htmlTags=new Set(['p','h1','h2','h3','h4','h5','h6','a','span','b','strong','i','em','u','s','del','ins','sup','sub','blockquote','pre','code','textarea',
  'table','thead','tbody','tfoot','tr','td','th','caption','colgroup','col','img','br','hr','ul','ol','li','dl','dt','dd','figure','figcaption','aside','abbr','time','small','mark']);
export function parseEuLegalStructure(html:string,context:LegalContext,maxBytes?:number):LegalDraft{
  const trees=sourceTree(html,false),htmlRoot=trees.find(n=>n.tag==='html');
  const body=htmlRoot?.children.find(n=>n.tag==='body');if(!htmlRoot||!body)throw new Error('Missing EU body.');
  const styles=htmlRoot.children.filter(n=>n.tag==='head').flatMap(n=>descendants(n,x=>x.tag==='style'));
  const protectedClasses=new Set<string>();
  for(const style of [...styles,...descendants(body,n=>n.tag==='style')])for(const rule of nodeText(style).matchAll(/([^{}]+)\{([^{}]*)\}/g))
    if(/white-space\s*:/i.test(rule[2]))for(const name of rule[1].matchAll(/\.([a-z0-9_-]+)/gi))protectedClasses.add(name[1]);
  const caseLaw=context.documentId.startsWith('6');
  infer(body,undefined,caseLaw);contextualUnits(body);if(caseLaw)courtParagraphs(body);body.children.unshift(...styles);
  const rules:LegalTreeRules={
    kind:n=>n.kind,label:(n,kind)=>n.label??(n.reference?kind+' '+n.reference:kind==='paragraph'||kind==='point'||kind==='recital'?kind+' '+(normalized(n).match(/^(?:\(?\d+[a-z]?\)?[.)]?)/i)?.[0]??''):normalized(n).slice(0,240)||kind),
    tag:n=>n.synthetic||n.tag==='body'||transparent.has(n.tag)?null:htmlTags.has(n.tag)||vectorTags.has(n.tag)?n.tag:'span',
    skip:new Set(['script','noscript']),block:new Set(['p','div','section','article','h1','h2','h3','h4','h5','h6','li','blockquote','hr','br','tr','td','th']),
    groupKinds:new Set(['book','part','title','chapter','section','annex','preamble','holding']),atomicKinds:new Set(['article','annex','table']),protectedClasses,
  };
  const draft=renderLegalTree(body,context,rules,maxBytes);
  const $=load(html);$('script,style,noscript').remove();
  $('body img[src]').each((_i,node)=>{$(node).attr('src',new URL($(node).attr('src')!,context.sourceUrl).href);});
  assertEuIntegrity(htmlIntegrity($('body').html()??''),draft.chunks.map(p=>p.body).join(''));
  return draft;
}
