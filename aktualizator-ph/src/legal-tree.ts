import {load} from 'cheerio';
import {fingerprintText,htmlIntegrity,assertIntegrity} from './content-integrity.js';
import {LEGAL_PROFILE,LEGAL_START,LEGAL_END,legalIdentity,legalHash,unitStart,unitEnd,planLegalChunks} from './legal-structure.js';
import type {LegalContext,LegalDraft,LegalKind,LegalUnit} from './legal-structure.js';

export interface LegalSourceNode {tag:string;attributes:Record<string,string>;children:LegalSourceNode[];text?:string;locator:string;kind?:LegalKind;label?:string;synthetic?:boolean;level?:number;reference?:string;preserveWhitespace?:boolean}
export interface LegalTreeRules {
  kind:(node:LegalSourceNode)=>LegalKind|undefined;
  label:(node:LegalSourceNode,kind:LegalKind)=>string;
  tag:(node:LegalSourceNode)=>string|null;
  skip:Set<string>;
  block:Set<string>;
  groupKinds:Set<LegalKind>;
  atomicKinds:Set<LegalKind>;
  protectedClasses?:Set<string>;
}
export const vectorTags=new Set(['svg','g','path','rect','circle','ellipse','line','polyline','polygon','text','tspan','defs','use','symbol','clipPath','mask','linearGradient','radialGradient','stop','pattern','marker','filter','feGaussianBlur','image',
  'math','mrow','mi','mo','mn','msub','msup','mfrac','msqrt','mroot','mtext','mtable','mtr','mtd','semantics','annotation']);
export function sourceTree(source:string,xml:boolean):LegalSourceNode[]{
  if(source.includes('<!-- legal-unit:')||source.includes('<!-- /legal-unit:')||source.includes(LEGAL_START)||source.includes(LEGAL_END))throw new Error('Reserved legal markers in original source.');
  const $=xml?load(source,{xmlMode:true}):load(source);
  const protectedNodes=new Set<any>();let uncertainWhitespace=false;
  if(!xml)$('style').each((_i,style)=>{
    const css=$(style).text();if(!/white-space\s*:/i.test(css))return;
    let matched=false;
    for(const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g))if(/white-space\s*:/i.test(rule[2])){
      matched=true;try{$(rule[1].trim()).each((_j,node)=>{protectedNodes.add(node);});}catch{uncertainWhitespace=true;}
    }
    if(!matched)uncertainWhitespace=true;
  });
  function convert(nodes:any[],parent:string):LegalSourceNode[]{
    const counters=new Map<string,number>();
    return nodes.flatMap((node):LegalSourceNode[]=>{
      if(node.type==='text')return [{tag:'#text',text:(node.data??'').replace(/\r\n?/g,'\n'),attributes:{},children:[],locator:parent+'/text()['+(counters.set('#text',(counters.get('#text')??0)+1).get('#text'))+']'}];
      if(node.type==='comment')return [{tag:'#comment',text:node.data??'',attributes:{},children:[],locator:parent+'/comment()['+(counters.set('#comment',(counters.get('#comment')??0)+1).get('#comment'))+']'}];
      if(node.type==='cdata')return convert(node.children??[],parent+'/cdata()');
      if(typeof node.name!=='string')return [];
      const ordinal=(counters.get(node.name)??0)+1;counters.set(node.name,ordinal);
      const locator=parent+'/'+node.name+'['+ordinal+']';
      return [{tag:node.name,attributes:{...node.attribs},locator,children:convert(node.children??[],locator),
        ...protectedNodes.has(node)||uncertainWhitespace?{preserveWhitespace:true}:{}}];
    });
  }
  return convert($.root().contents().toArray(),'');
}
export const nodeText=(node:LegalSourceNode):string=>node.tag==='#text'?node.text??'':node.children.map(nodeText).join('');
export function descendants(node:LegalSourceNode,predicate:(n:LegalSourceNode)=>boolean):LegalSourceNode[]{
  const result:LegalSourceNode[]=[];const visit=(n:LegalSourceNode)=>{if(predicate(n))result.push(n);n.children.forEach(visit);};visit(node);return result;
}
export function sourceText(node:LegalSourceNode,rules:LegalTreeRules):string{
  if(rules.skip.has(node.tag)||['style','#comment'].includes(node.tag))return '';
  if(node.tag==='#text')return node.text??'';
  return node.children.map(n=>sourceText(n,rules)).join('')+(rules.block.has(node.tag)?'\n':'');
}
const escapeText=(value:string)=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const escapeAttribute=(value:string)=>escapeText(value).replace(/"/g,'&quot;').replace(/\r/g,'&#13;');
const sectionKinds=new Set<LegalKind>(['book','part','title','chapter','section']);
const identityAttributes=['id','name','eId','stam-id','versie-id','revisie-id','label-id','IDENTIFIER'];
function protectedWhitespace(node:LegalSourceNode,rules:LegalTreeRules):boolean{
  return node.preserveWhitespace===true||['pre','code','textarea'].includes(node.tag)||node.attributes['xml:space']==='preserve'||
    /white-space\s*:/i.test(node.attributes.style??'')||(node.attributes.class??'').split(/\s+/).some(c=>rules.protectedClasses?.has(c));
}
function savedAttributes(attributes:Record<string,string>):LegalUnit['attributes']{
  return Object.fromEntries(Object.entries(attributes).map(([name,value])=>[name,/^data:/i.test(value)?{sha256:legalHash(value),characters:value.length}:value]));
}
/** Flatten structural wrappers into an ordered view. Every legal unit has
 * markers; text/table/inline markup is kept once. Significant whitespace
 * wrappers stay atomic, so partitioning cannot change their presentation. */
export function renderLegalTree(root:LegalSourceNode,context:LegalContext,rules:LegalTreeRules,maxBytes?:number):LegalDraft{
  const units:LegalUnit[]=[],pieces:string[]=[],groups:{start:number;key:string}[]=[],breaks:number[]=[];
  let length=0,htmlDepth=0;const stack:LegalUnit[]=[];const seenAnchors=new Set<string>();
  const append=(value:string)=>{pieces.push(value);length+=value.length;};
  const markGroup=(key:string)=>{
    if(htmlDepth)return;
    const prior=groups.at(-1);if(prior?.key===key)return;
    if(!prior)groups.push({start:0,key});else if(prior.start===length)prior.key=key;else groups.push({start:length,key});
  };
  const safe=()=>{if(!htmlDepth)breaks.push(length);};
  function visit(node:LegalSourceNode,atomic=false):void{
    if(rules.skip.has(node.tag))return;
    if(node.tag==='#text'){append(escapeText(node.text??''));return;}
    if(node.tag==='#comment'){append('<!--'+(node.text??'')+'-->');return;}
    if(node.tag==='style'){
      const css=nodeText(node);if(/<\/style\b/i.test(css))throw new Error('Unsafe source stylesheet boundary.');append('<style>'+css+'</style>');return;
    }
    const kind=node===root?'version':node.kind??rules.kind(node),protectedNode=protectedWhitespace(node,rules);
    const localAtomic=atomic||protectedNode||kind!==undefined&&rules.atomicKinds.has(kind);
    let unit:LegalUnit|undefined;
    if(kind){
      const identity=legalIdentity(context,node.locator,kind);
      if(seenAnchors.has(identity.anchor))throw new Error('Duplicate source locator in legal model.');seenAnchors.add(identity.anchor);
      unit={...identity,parentId:stack.at(-1)?.id??null,kind,label:node.label??rules.label(node,kind),order:units.length+1,
        sourceLocator:node.locator,sourceTag:node.tag,attributes:savedAttributes(node.attributes),
        ...(node.reference?{reference:node.reference}:{}),
        officialIdentifiers:identityAttributes.filter(name=>!!node.attributes[name]).map(name=>({name,value:node.attributes[name]}))};
      if(!atomic&&!htmlDepth){
        if(rules.groupKinds.has(kind)||protectedNode)markGroup(unit.anchor);
        else if(kind==='article')markGroup([...stack].reverse().find(u=>sectionKinds.has(u.kind))?.anchor??unit.anchor);
      }
      safe();units.push(unit);stack.push(unit);append(unitStart(unit.anchor)+`<a id="${unit.anchor}"></a>`);
    }
    let tag=rules.tag(node);
    if(protectedNode&&tag===null)tag='div';
    const attrs:Record<string,string>={};
    if(tag){
      for(const [name,value] of Object.entries(node.attributes))if(/^(?:id|name|title|class|style|alt|width|height|colspan|rowspan|scope|align|valign|dir|lang|xml:lang|xml:space|xmlns|role|aria-[a-z-]+|data-[a-z-]+)$/i.test(name)||
        ['ol','ul'].includes(tag)&&['type','start','reversed'].includes(name)||tag==='li'&&name==='value'||
        vectorTags.has(tag)&&/^[a-z][a-z0-9_:.-]*$/i.test(name)&&!/^on/i.test(name)&&!/(?:href|src)$/i.test(name))attrs[name]=value;
      if(node.attributes['xml:space']==='preserve')attrs.style=(attrs.style??'')+';white-space:pre-wrap';
      if(node.tag==='nadruk'&&!/\b(?:vet|bold)\b/i.test(node.attributes.type??''))tag='em';
      if(node.attributes.morerows&&/^\d+$/.test(node.attributes.morerows))attrs.rowspan=String(Number(node.attributes.morerows)+1);
      let link=tag==='a'?(node.attributes.href??node.attributes.doc??node.attributes.ref):vectorTags.has(tag)?node.attributes.href??node.attributes['xlink:href']:undefined;
      if(node.tag==='extref'){
        if(node.attributes.doc)attrs['data-source-doc']=node.attributes.doc;
        if(node.attributes.reeks)attrs['data-source-reeks']=node.attributes.reeks;
      }
      if(link&&context.corpus==='NL'&&/^jci\d+(?:\.\d+)?:/i.test(link))link='https://wetten.overheid.nl/'+link;
      else if(link&&context.corpus==='NL'&&node.tag==='extref'&&node.attributes.reeks?.toLowerCase()==='celex'&&/^[0-9][A-Za-z0-9_()./-]*$/.test(link)){
        const target=new URL('https://eur-lex.europa.eu/legal-content/'+context.language+'/TXT/');target.searchParams.set('uri','CELEX:'+link);link=target.href;
      }
      const src=tag==='img'?(node.attributes.src??node.attributes.url??(context.corpus==='NL'&&node.tag==='illustratie'?node.attributes.naam:undefined)):undefined;
      if(context.corpus==='NL'&&node.tag==='illustratie'){
        if(node.attributes.breedte)attrs.width=node.attributes.breedte;
        if(node.attributes.hoogte)attrs.height=node.attributes.hoogte;
        for(const [name,value] of Object.entries(node.attributes))attrs['data-source-'+name.replace(/[^a-z0-9-]/gi,'-')]=value;
      }
      if(link){
        if(link.startsWith('#'))attrs.href=link;
        else {const url=new URL(link,context.sourceUrl);if(!['http:','https:','mailto:'].includes(url.protocol)&&!(tag==='image'&&/^data:image\//i.test(link)))throw new Error('Unsupported legal hyperlink protocol.');attrs.href=url.href;}
      }
      if(src){const url=new URL(src,context.sourceUrl);if(!['http:','https:'].includes(url.protocol)&&!/^data:image\//i.test(src))throw new Error('Unsupported legal image protocol.');attrs.src=url.href;}
      if(['intref','nootref','voetnootref'].includes(node.tag)&&!attrs.href){const ref=node.attributes.refid??node.attributes['ref-id']??node.attributes.idref;
        if(ref)attrs.href='#'+ref;}
      if(['table','tabel','entry','row','colspec','tgroup'].includes(node.tag))for(const [name,value] of Object.entries(node.attributes))
        if(!Object.hasOwn(attrs,name))attrs['data-source-'+name.replace(/[^a-z0-9-]/gi,'-')]=value;
      append('<'+tag+Object.entries(attrs).map(([k,v])=>' '+k+'="'+escapeAttribute(v)+'"').join('')+'>');
      htmlDepth++;
    }else{
      for(const name of ['id','name'])if(node.attributes[name])append(`<a ${name}="${escapeAttribute(node.attributes[name])}"></a>`);
    }
    const voidTag=tag&&['img','br','hr','col','wbr','input'].includes(tag);
    if(!voidTag)for(const child of node.children)visit(child,localAtomic);
    if(tag){htmlDepth--;if(!voidTag)append('</'+tag+'>');}
    else if(rules.block.has(node.tag))append('\n');
    if(unit){append(unitEnd(unit.anchor));stack.pop();safe();}
  }
  visit(root);
  const body=pieces.join('');
  if(!groups.length)groups.push({start:0,key:units[0].anchor});
  const expected=fingerprintText(sourceText(root,rules));
  assertIntegrity(expected,htmlIntegrity(body).text);
  const originalImages:string[]=[];
  const images=(node:LegalSourceNode)=>{if(rules.skip.has(node.tag))return;if(rules.tag(node)==='img'){
    const src=node.attributes.src??node.attributes.url??(context.corpus==='NL'&&node.tag==='illustratie'?node.attributes.naam:undefined);if(!src)throw new Error('Original image has no source.');originalImages.push(new URL(src,context.sourceUrl).href);
  }node.children.forEach(images);};images(root);
  assertIntegrity(fingerprintText(JSON.stringify(originalImages)),htmlIntegrity(body).images);
  const chunks=planLegalChunks(body,groups,breaks,maxBytes);
  return {...context,profile:LEGAL_PROFILE,units,chunks};
}
