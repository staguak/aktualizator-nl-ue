import {load} from 'cheerio';
import type {Element} from 'domhandler';
import {XMLValidator} from 'fast-xml-parser';
import path from 'node:path';
import {hash} from './release-store.js';
import {observeUnits} from './unit-observations.js';
import type {UnitSnapshot} from './unit-observations.js';
import {FORMEX_DOCUMENT_ROOTS} from './formex-vocabulary.js';
import type {EuLanguage} from './eu-language.js';

interface LanguageEvidence {value:string;origin:'bibliography'|'member-name';locator:string|null}
interface PackageDocument {member:string;root:string;role:string;sha256:string;languageEvidence:LanguageEvidence[]}
interface Component {member:string;root:string;parentMember:string;documentMember:string;catalogueMember:string|null;
  referenceMember:string;locator:string;order:number;sha256:string;references:{member:string;locator:string;kind:'DOC'|'INCLUDE'}[]}
export interface FormexPackageInfo {root:string;layers:Record<string,string>[];members:string[];unitHistory:UnitSnapshot[];
  documents:PackageDocument[];attachments:Component[];fragments:Component[]}
const roles:Record<string,string>={CJT:'court-notice',CASE:'case-summary-or-result',CONCLUSION:'advocate-general-opinion',
  JUDGMENT:'judgment',CORR:'corrigendum','CONS.ACT':'consolidation','CONS.OTH':'consolidation',ACT:'act',GENERAL:'general'};
const languageCodes={EN:['EN','ENG'],PL:['PL','POL'],NL:['NL','NLD','DUT'],FR:['FR','FRA','FRE']};
function parseMember(bytes:Uint8Array){
  const xml=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  if(/<!DOCTYPE|<!ENTITY/i.test(xml)||XMLValidator.validate(xml)!==true)throw new Error('Unsafe or invalid Formex XML.');
  const $=load(xml,{xmlMode:true}),root=$.root().children().first(),locators=new Map<Element,string>();
  function locate(node:Element,locator:string){locators.set(node,locator);const counts=new Map<string,number>();
    for(const child of $(node).children().toArray()){const n=(counts.get(child.name)??0)+1;counts.set(child.name,n);locate(child,`${locator}/${child.name}[${n}]`);}}
  locate(root[0],'/'+root[0].name+'[1]');
  const bibliography=root[0].name.startsWith('CONS.')?root.children().filter((_i,n)=>n.name==='CONS.DOC')
    .children().filter((_i,n)=>n.name==='BIB.INSTANCE'):root.children().filter((_i,n)=>n.name.startsWith('BIB.'));
  return {$,root,locators,bibliography,name:root[0].name};
}
function referencedMember(owner:string,value:string):string{
  if(!value||value.includes('\\')||path.posix.isAbsolute(value))throw new Error('Unsafe Formex member reference.');
  const member=path.posix.normalize(path.posix.join(path.posix.dirname(owner),value));
  if(member==='..'||member.startsWith('../'))throw new Error('Unsafe Formex member reference.');return member;
}
export function inspectFormexFiles(files:Record<string,Uint8Array>,celex:string,containerSha256:string,url:string|null,language?:EuLanguage):FormexPackageInfo{
  const xml=new Map(Object.entries(files).filter(([name])=>/\.xml$/i.test(name)).map(([name,bytes])=>[name,parseMember(bytes)]));
  const included=new Set<string>();
  for(const [member,m] of xml)for(const node of m.root.find('*').toArray().filter(n=>n.name==='INCL.ELEMENT'&&n.attribs.TYPE==='FORMEX.DOC'))
    included.add(referencedMember(member,node.attribs.FILEREF));
  const subordinate=new Set<string>();
  for(const [member,m] of xml)if(m.name==='DOC')for(const node of m.root.find('*').toArray().filter(n=>n.name==='REF.PHYS'&&n.attribs.TYPE==='DOC.XML'))
    if(m.$(node).parents().toArray().some(n=>n.name==='DOC.SUB.PUB'))subordinate.add(referencedMember(member,node.attribs.FILE));
  const primary=[...xml].filter(([member,m])=>FORMEX_DOCUMENT_ROOTS.includes(m.name)&&!included.has(member)&&!subordinate.has(member));
  if(!primary.length)throw new Error('Missing matching Formex legal document.');
  const documents:PackageDocument[]=[],layers:Record<string,string>[]=[],components:Component[]=[],ordered:string[]=[];
  const catalogueRefs=(m:ReturnType<typeof parseMember>)=>m.bibliography.children().filter((_i,n)=>n.name==='DOCUMENT.REF')
    .toArray().map(n=>n.attribs.FILE).filter(Boolean);
  for(const [member,m] of primary){
    const languageEvidence:LanguageEvidence[]=m.bibliography.children().filter((_i,n)=>n.name==='LG.DOC').toArray()
      .map(n=>({value:m.$(n).text().trim().toUpperCase(),origin:'bibliography',locator:m.locators.get(n)!}));
    if(language){
      const accepted=languageCodes[language];
      if(languageEvidence.length){if(languageEvidence.some(e=>!accepted.includes(e.value)))throw new Error('Formex document bibliography language mismatch.');}
      else{
        // Some ECR originals omit LG.DOC. Only their own standard member name
        // supplies a fallback; a quoted act or another package member cannot.
        const code=accepted.join('|'),base=path.posix.basename(member);
        if(!new RegExp(`(?:^|[_.-]|[0-9])(?:${code})(?=[_.-]|$)`,'i').test(base)&&
          !new RegExp(`^CL[0-9]{4}[A-Z][0-9]{4}(?:${code})[0-9]`,'i').test(base))throw new Error('Formex package does not identify the requested language.');
        languageEvidence.push({value:language,origin:'member-name',locator:null});
      }
    }
    const identifiers=m.bibliography.children().filter((_i,n)=>n.name==='NO.CELEX').toArray().map(n=>m.$(n).text().trim());
    if(identifiers.some(id=>id!==celex))throw new Error('Formex document CELEX identity mismatch.');
    const cases=m.bibliography.find('*').toArray().filter(n=>n.name==='NO.CASE').map(n=>m.$(n).text().trim());
    if(/^6[0-9]{4}[CTF][A-Z][0-9]{4}/.test(celex)&&cases.length&&!cases.some(value=>{
      const match=/^([CTF])[-\s\u2011\u2013]*([0-9]+)\/([0-9]{2}|[0-9]{4})(?:\b|$)/.exec(value);
      return match&&match[1]===celex[5]&&Number(match[2])===Number(celex.slice(7,11))&&match[3].slice(-2)===celex.slice(3,5);
    }))throw new Error('Formex case identity mismatch.');
    for(const node of m.root.find('*').toArray().filter(n=>n.name==='INFO.CONSLEG')){
      const attrs={...node.attribs};
      if(celex.startsWith('0')&&(attrs['CONSLEG.REF']!==celex.slice(1,10)||attrs['START.DATE']!==celex.slice(11)))throw new Error('Formex layer does not match requested CELEX.');
      layers.push(attrs);
    }
    documents.push({member,root:m.name,role:roles[m.name],sha256:hash(files[member]),languageEvidence});
    const refs=catalogueRefs(m),active=new Set<string>();
    const catalogue=refs.map(ref=>referencedMember(member,ref)).find(name=>xml.get(name)?.name==='DOC')??null;
    function visit(target:string,parentMember:string,referenceMember:string,locator:string,kind:'DOC'|'INCLUDE'){
      const part=xml.get(target);if(!part)throw new Error('Missing XML member referenced by Formex document.');
      if(![...FORMEX_DOCUMENT_ROOTS,'ANNEX'].includes(part.name))throw new Error('Unsupported Formex document component.');
      if(active.has(target))throw new Error('Cyclic Formex document inclusion.');
      const old=components.find(c=>c.member===target);
      if(old){
        if(old.documentMember!==member)throw new Error('Formex component belongs to multiple documents.');
        old.references.push({member:referenceMember,locator,kind});return;
      }
      if(ordered.includes(target)){if(target!==member)throw new Error('Ambiguous Formex component ownership.');return;}
      if(target!==member){
        if(catalogueRefs(part).some(ref=>referencedMember(target,ref)!==catalogue))throw new Error('Formex annex or fragment belongs to another document catalogue.');
        const langs=part.bibliography.children().filter((_i,n)=>n.name==='LG.DOC').toArray().map(n=>part.$(n).text().trim().toUpperCase());
        if(language&&langs.some(value=>!languageCodes[language].includes(value)))throw new Error('Formex annex or fragment language mismatch.');
        components.push({member:target,root:part.name,parentMember,documentMember:member,catalogueMember:catalogue,referenceMember,
          locator,order:ordered.length+1,sha256:hash(files[target]),references:[{member:referenceMember,locator,kind}]});
      }
      ordered.push(target);active.add(target);
      for(const node of part.root.find('*').toArray().filter(n=>n.name==='INCL.ELEMENT'&&n.attribs.TYPE==='FORMEX.DOC'))
        visit(referencedMember(target,node.attribs.FILEREF),target,target,part.locators.get(node)!+'/@FILEREF','INCLUDE');
      active.delete(target);
    }
    visit(member,member,member,'/'+m.name+'[1]','DOC');
    for(const ref of refs){
      const catalogueMember=referencedMember(member,ref),catalogue=xml.get(catalogueMember);
      if(!catalogue||catalogue.name!=='DOC')continue;
      const physical=catalogue.root.find('*').toArray().filter(n=>n.name==='REF.PHYS'&&n.attribs.TYPE==='DOC.XML');
      const targets=physical.map(n=>referencedMember(catalogueMember,n.attribs.FILE));
      if(!targets.includes(member))throw new Error('Formex catalogue does not reference its owning document.');
      for(let i=0;i<targets.length;i++){
        const target=targets[i],part=xml.get(target);
        if(!part)throw new Error('Missing XML member referenced by Formex catalogue.');
        if(target!==member)visit(target,member,catalogueMember,catalogue.locators.get(physical[i])!+'/@FILE','DOC');
      }
    }
  }
  if(celex.startsWith('0')&&!layers.length)throw new Error('Missing matching Formex legal document layer.');
  if([...xml].some(([name,m])=>(m.name==='ANNEX'||included.has(name)||subordinate.has(name))&&!ordered.includes(name)))throw new Error('Unlinked Formex annex or fragment has no owning document.');
  const unitHistory=ordered.map(member=>observeUnits(files[member],{jurisdiction:'EU',documentId:celex,url,member,containerSha256}));
  return {root:primary[0][1].name,layers,members:Object.keys(files).sort(),unitHistory,documents,
    attachments:components.filter(c=>c.root==='ANNEX'),fragments:components.filter(c=>c.root!=='ANNEX')};
}
