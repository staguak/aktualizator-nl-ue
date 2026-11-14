import {XMLValidator} from 'fast-xml-parser';
import {sourceTree,nodeText,descendants,renderLegalTree,vectorTags} from './legal-tree.js';
import type {LegalSourceNode,LegalTreeRules} from './legal-tree.js';
import type {LegalContext,LegalKind,LegalDraft} from './legal-structure.js';
import {resolveCalsGrid} from './nl-cals.js';

const kinds:Record<string,LegalKind>={wetgeving:'version',boek:'book',deel:'part',titeldeel:'title',hoofdstuk:'chapter',afdeling:'section',paragraaf:'section',
  'sub-paragraaf':'section',subparagraaf:'section',artikel:'article',lid:'paragraph',al:'paragraph',li:'point',onderdeel:'point',bijlage:'annex',
  aanhef:'preamble',wetsluiting:'closing','regeling-sluiting':'closing',intitule:'heading',citeertitel:'heading','officiele-inhoudsopgave':'other',
  table:'table',tabel:'table',plaatje:'image',img:'image',noot:'footnote',voetnoot:'footnote',kop:'heading'};
const tags:Record<string,string|null>={wetgeving:null,'wet-besluit':null,wettekst:null,boek:null,deel:null,titeldeel:null,hoofdstuk:null,afdeling:null,paragraaf:null,
  'sub-paragraaf':null,subparagraaf:null,artikel:null,lid:null,li:null,onderdeel:null,bijlage:null,aanhef:null,wetsluiting:null,'regeling-sluiting':null,
  kop:'h2',intitule:'h1',citeertitel:'p',al:'p',tussenkop:'h3',label:'span',nr:'span',titel:'span',lidnr:'span','li.nr':'span',
  nadruk:'strong',intref:'a',extref:'a',plaatje:'img',img:'img',noot:'aside',voetnoot:'aside',nootref:'a',table:'table',tabel:'table',
  tgroup:null,thead:'thead',tbody:'tbody',tfoot:'tfoot',row:'tr',tr:'tr',entry:'td',td:'td',th:'th',colspec:'col',col:'col',
  lijst:'div',definitielijst:'dl',definitie:'dd',term:'dt',br:'br',sup:'sup',sub:'sub',pre:'pre',code:'code',redactie:'span',
  math:'math',mrow:'mrow',mi:'mi',mo:'mo',mn:'mn',msub:'msub',msup:'msup',mfrac:'mfrac'};
const skip=new Set(['meta-data','bwb-inputbestand','bwb-wijzigingen','redactionele-correcties']);
function label(node:LegalSourceNode,kind:LegalKind){
  const kop=node.children.find(n=>n.tag==='kop');
  const number=node.attributes.nr??node.children.find(n=>['lidnr','li.nr'].includes(n.tag))?.children.map(nodeText).join('');
  return (kop?nodeText(kop):number??(['intitule','citeertitel','kop'].includes(node.tag)?nodeText(node):kind)).replace(/\s+/g,' ').trim();
}
export const nlLegalRules:LegalTreeRules={kind:n=>kinds[n.tag],label,tag:n=>Object.hasOwn(tags,n.tag)?tags[n.tag]:vectorTags.has(n.tag)?n.tag:'span',skip,
  block:new Set(['wetgeving','wet-besluit','wettekst','boek','deel','titeldeel','hoofdstuk','afdeling','paragraaf','sub-paragraaf','subparagraaf','artikel','lid','li','onderdeel','bijlage','aanhef','wetsluiting','regeling-sluiting','intitule','citeertitel','kop','al','tussenkop','row','tr','entry','td','th','br','noot','voetnoot']),
  groupKinds:new Set(['book','part','title','chapter','section','annex','preamble','closing']),atomicKinds:new Set(['article','annex','table'])};
export function parseNlLegalStructure(xml:string,context:LegalContext,maxBytes?:number):LegalDraft{
  if(/<!DOCTYPE|<!ENTITY/i.test(xml)||XMLValidator.validate(xml)!==true)throw new Error('Invalid original NL structural XML.');
  const trees=sourceTree(xml,true),toestand=trees.flatMap(n=>descendants(n,x=>x.tag==='toestand'))[0];
  if(!toestand||toestand.attributes['bwb-id']!==context.documentId)throw new Error('NL structural source identity mismatch.');
  const root=toestand.children.find(n=>n.tag==='wetgeving');if(!root)throw new Error('NL legal body missing.');
  const references=(node:LegalSourceNode,book?:string)=>{
    const kop=node.children.find(n=>n.tag==='kop'),number=node.attributes.nr??kop?.children.find(n=>n.tag==='nr')?.children.map(nodeText).join('');
    if(node.tag==='boek'&&number&&/^\d+$/.test(number))book=number;
    if(node.tag==='artikel'){
      const ref=number??(/^ee?nig artikel$/i.test(kop?.children.find(n=>n.tag==='label')?.children.map(nodeText).join('')??'')?'enig':undefined);
      if(ref)node.reference=book?book+':'+ref:ref;
    }
    node.children.forEach(child=>references(child,book));
  };references(root);
  for(const group of descendants(root,n=>n.tag==='tgroup'))resolveCalsGrid(group);
  return renderLegalTree(root,{...context,metadata:{...typeof context.metadata==='object'&&context.metadata!==null?context.metadata:{},toestandAttributes:toestand.attributes}},nlLegalRules,maxBytes);
}
