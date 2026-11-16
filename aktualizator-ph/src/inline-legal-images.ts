import {replaceCssUrls} from './css-url-rules.js';
import {load} from 'cheerio';
import {isDeepStrictEqual} from 'node:util';
import {legalHash,extractLegalBody,LEGAL_START} from './legal-structure.js';
import type {LegalManifest} from './legal-structure.js';
import {legalImageReferences,verifyNativeImage} from './legal-images.js';
import type {LegalImageIndex} from './legal-images.js';
import {hash} from './release-store.js';

export interface GraphicPatch {canonicalStart:number;canonicalEnd:number;renderedStart:number;renderedEnd:number;original:string;renderedSha256:string}
export interface RenderedGraphicFile {name:string;canonicalSha256:string;renderedSha256:string;patches:GraphicPatch[]}
export interface ImageRendering {profile:'inline-base64-v1';offsetEncoding:'utf16-code-units';patchScope:'full-markdown';legalOffsetScope:'restored-canonical-body';files:RenderedGraphicFile[]}
interface Edit {start:number;end:number;text:string}
const escaped=(value:string)=>value.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
function apply(text:string,edits:Edit[]):string{
  let cursor=0,result='';
  for(const edit of [...edits].sort((a,b)=>a.start-b.start||a.end-b.end)){
    if(edit.start<cursor||edit.end<edit.start||edit.end>text.length)throw new Error('Overlapping graphic rendering edits.');
    result+=text.slice(cursor,edit.start)+edit.text;cursor=edit.end;
  }
  return result+text.slice(cursor);
}
function minimal(text:string,edit:Edit):Edit|undefined{
  const before=text.slice(edit.start,edit.end),after=edit.text;let prefix=0,suffix=0;
  while(prefix<before.length&&prefix<after.length&&before[prefix]===after[prefix])prefix++;
  while(suffix<before.length-prefix&&suffix<after.length-prefix&&before[before.length-1-suffix]===after[after.length-1-suffix])suffix++;
  if(prefix===before.length&&prefix===after.length)return;
  // Never bisect a UTF-16 surrogate pair in a reversible recipe.
  if(prefix>0&&/[\uDC00-\uDFFF]/.test(before[prefix]??''))prefix--;
  if(suffix>0&&/[\uDC00-\uDFFF]/.test(before[before.length-suffix]??''))suffix--;
  return {start:edit.start+prefix,end:edit.end-suffix,text:after.slice(prefix,after.length-suffix)};
}

/** A transport view only. The canonical legal Markdown and source identity
 * remain recoverable exactly; no text, legal order or table geometry is cut. */
export function renderBase64Markdown(name:string,canonical:string,index:LegalImageIndex,readAsset:(name:string)=>Uint8Array):{text:string;recipe:RenderedGraphicFile}{
  const body=extractLegalBody(canonical),base=canonical.indexOf(LEGAL_START)+LEGAL_START.length+1;
  const refs=legalImageReferences(body),$=load(body,{sourceCodeLocationInfo:true},false),edits:Edit[]=[];
  const available=index.occurrences.filter(o=>o.markdownFile===name),omitted=(index.omittedDecorations??[]).filter(o=>o.markdownFile===name),gaps=(index.unavailableImages??[]).filter(o=>o.markdownFile===name);
  const assets=new Map(index.assets.map(a=>[a.name,a]));
  const decision=(ref:typeof refs[number]):{kind:'available';value:string}|{kind:'omitted'|'unavailable'}=>{
    const same=(o:{offset:number;occurrence:number;kind:string})=>o.offset===ref.offset&&o.occurrence===ref.index&&o.kind===ref.kind;
    if(omitted.some(same))return {kind:'omitted'};
    if(gaps.some(same))return {kind:'unavailable'};
    const found=available.filter(same),targets=new Set(found.map(o=>o.target));
    if(!found.length||targets.size!==1)throw new Error('Missing or ambiguous inline graphic mapping.');
    const asset=assets.get(found[0].target);if(!asset)throw new Error('Missing inline native asset.');
    const bytes=Buffer.from(readAsset(asset.name));
    if(hash(bytes)!==asset.sha256||bytes.length!==asset.bytes)throw new Error('Inline graphic bytes differ from native original.');
    const fragment=new URL(ref.source,'https://render.invalid/').hash.replace(/'/g,'%27');
    return {kind:'available',value:`data:${asset.contentType};base64,${bytes.toString('base64')}${fragment}`};
  };
  const byLocation=(kind:string,offset:number,source?:string)=>refs.find(r=>r.kind===kind&&r.offset===offset&&(source===undefined||r.source===source));
  $('*').filter((_i,node)=>'tagName' in node&&['img','image','feimage','use'].includes(node.tagName.toLowerCase())).each((_i,node)=>{
    if(!('tagName' in node))return;
    if(node.tagName!=='img'&&($(node).attr('href')??$(node).attr('xlink:href')??'').startsWith('#'))return;
    const loc=(node as any).sourceCodeLocation;if(!loc)throw new Error('Missing image rendering location.');
    const kind=node.tagName==='img'?'img':'svg-image',ref=byLocation(kind,loc.startOffset);
    if(!ref)throw new Error('Unindexed rendered image.');
    const value=decision(ref);
    if(value.kind!=='available'){
      const replacement=value.kind==='omitted'?'<!-- omitted decorative OJ flag -->':kind==='svg-image'?'<text>Grafika niedostępna</text>':
        `<span data-unavailable-image="${ref.index}">[Grafika niedostępna po sprawdzeniu źródeł i języków]</span>`;
      edits.push({start:loc.startOffset,end:loc.endOffset,text:replacement});return;
    }
    const attribute=loc.attrs?.src?'src':loc.attrs?.href?'href':'xlink:href',position=loc.attrs?.[attribute];
    if(!position)throw new Error('Missing exact graphic attribute span.');
    edits.push({start:position.startOffset,end:position.endOffset,text:`${attribute}="${value.value}"`});
  });
  $('style,[style]').each((_i,node)=>{
    const loc=(node as any).sourceCodeLocation;if(!loc)return;
    const style=node.tagName==='style',text=style?$(node).text():$(node).attr('style')??'';
    const updated=replaceCssUrls(text,({text:whole,source})=>{
      const ref=byLocation('css',loc.startOffset,source);if(!ref)return whole;
      const value=decision(ref);return value.kind==='available'?`url('${value.value}')`:'none';
    });
    if(updated===text)return;
    if(style){if(!loc.startTag||!loc.endTag)throw new Error('Incomplete style rendering span.');edits.push({start:loc.startTag.endOffset,end:loc.endTag.startOffset,text:updated});}
    else{const position=loc.attrs?.style;if(!position)throw new Error('Missing style attribute rendering span.');edits.push({start:position.startOffset,end:position.endOffset,text:`style="${escaped(updated)}"`});}
  });
  // Embed complete outer SVGs after their image/CSS dependencies have been
  // embedded. Original SVG bytes remain in the native source sidecars.
  const outer=refs.filter(r=>r.kind==='inline-svg').filter((r,_i,all)=>!all.some(parent=>parent!==r&&parent.offset<=r.offset&&parent.end>=r.end));
  for(const ref of outer){
    const selected=edits.filter(e=>e.start>=ref.offset&&e.end<=ref.end),raw=body.slice(ref.offset,ref.end);
    const disposition=decision(ref);
    if(disposition.kind!=='available'){
      for(const e of selected)edits.splice(edits.indexOf(e),1);
      edits.push({start:ref.offset,end:ref.end,text:disposition.kind==='omitted'?'<!-- omitted decorative OJ flag -->':'<span data-unavailable-image="svg">[Grafika SVG niedostępna]</span>'});continue;
    }
    let svg=apply(raw,selected.map(e=>({start:e.start-ref.offset,end:e.end-ref.offset,text:e.text})));
    if(!/^<svg\b[^>]*\sxmlns=/.test(svg))svg=svg.replace(/^<svg\b/,'<svg xmlns="http://www.w3.org/2000/svg"');
    if(svg.includes('xlink:')&&!/^<svg\b[^>]*\sxmlns:xlink=/.test(svg))svg=svg.replace(/^<svg\b/,'<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
    const native=verifyNativeImage(Buffer.from(svg));if(native.format!=='SVG')throw new Error('Invalid derived inline SVG.');
    for(const e of selected)edits.splice(edits.indexOf(e),1);
    edits.push({start:ref.offset,end:ref.end,text:`<img alt="Grafika SVG" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">`});
  }
  const compact=edits.map(e=>minimal(canonical,{start:e.start+base,end:e.end+base,text:e.text})).filter((e):e is Edit=>!!e).sort((a,b)=>a.start-b.start||a.end-b.end);
  const text=apply(canonical,compact);if(Buffer.byteLength(text)>95_000_000)throw new Error('Base64 legal file exceeds the technical destination limit; safe structural repartition is required.');
  const patches:GraphicPatch[]=[];let delta=0;
  for(const edit of compact){
    patches.push({canonicalStart:edit.start,canonicalEnd:edit.end,renderedStart:edit.start+delta,renderedEnd:edit.start+delta+edit.text.length,original:canonical.slice(edit.start,edit.end),renderedSha256:legalHash(edit.text)});
    delta+=edit.text.length-(edit.end-edit.start);
  }
  assertInlineGraphics(text);
  return {text,recipe:{name,canonicalSha256:legalHash(canonical),renderedSha256:legalHash(text),patches}};
}

export function restoreCanonicalMarkdown(name:string,rendered:string,index:LegalImageIndex):string{
  const encoding=index.rendering;if(!encoding)return rendered;
  if(encoding.profile!=='inline-base64-v1'||encoding.offsetEncoding!=='utf16-code-units'||encoding.patchScope!=='full-markdown'||encoding.legalOffsetScope!=='restored-canonical-body')throw new Error('Unknown inline graphic rendering profile.');
  const file=encoding.files.find(f=>f.name===name);if(!file)return rendered;
  if(legalHash(rendered)!==file.renderedSha256)throw new Error('Rendered Markdown checksum changed.');
  const edits:Edit[]=[];let previous=0,delta=0;
  for(const p of file.patches){
    if(![p.canonicalStart,p.canonicalEnd,p.renderedStart,p.renderedEnd].every(Number.isSafeInteger)||p.canonicalStart<previous||p.canonicalEnd<p.canonicalStart||
      p.renderedStart!==p.canonicalStart+delta||p.renderedEnd<p.renderedStart||p.renderedEnd>rendered.length||typeof p.original!=='string'||p.original.length!==p.canonicalEnd-p.canonicalStart||legalHash(rendered.slice(p.renderedStart,p.renderedEnd))!==p.renderedSha256)throw new Error('Invalid reversible graphic patch.');
    edits.push({start:p.renderedStart,end:p.renderedEnd,text:p.original});previous=p.canonicalEnd;delta+=(p.renderedEnd-p.renderedStart)-p.original.length;
  }
  const canonical=apply(rendered,edits);if(legalHash(canonical)!==file.canonicalSha256)throw new Error('Canonical Markdown reconstruction changed.');
  return canonical;
}
export function validateInlineRendering(documents:LegalManifest[],index:LegalImageIndex,readCanonical:(name:string)=>string,readRendered:(name:string)=>string,readAsset:(name:string)=>Uint8Array):void{
  if(!index.rendering)return;
  const names=[...new Set(documents.flatMap(d=>d.parts.map(p=>p.file)))].sort();
  if(!isDeepStrictEqual(index.rendering.files.map(f=>f.name).sort(),names))throw new Error('Inline rendering inventory differs from legal files.');
  for(const file of index.rendering.files){
    const result=renderBase64Markdown(file.name,readCanonical(file.name),index,readAsset);
    if(result.text!==readRendered(file.name)||!isDeepStrictEqual(result.recipe,file))throw new Error('Inline presentation differs from verified native graphics or canonical text.');
  }
}
export function assertInlineGraphics(markdown:string):void{
  const seen=new Set<string>();
  const check=(body:string,depth:number)=>{
    if(depth>8)throw new Error('Excessive nested SVG image encoding.');
    for(const ref of legalImageReferences(body)){
      if(ref.kind==='inline-svg'&&depth>0)continue;
      if(depth>0&&ref.source.startsWith('#'))continue;
      if(ref.kind==='inline-svg')throw new Error('A final SVG is not encoded as Base64.');
      const match=/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})(?:#[^\s"'<>]*)?$/i.exec(ref.source);
      if(!match||!match[2])throw new Error('A final graphic is not self-contained Base64.');
      const bytes=Buffer.from(match[2],'base64');if(bytes.toString('base64')!==match[2])throw new Error('Invalid final graphic Base64.');
      if(match[1].toLowerCase()==='image/svg+xml'&&!seen.has(hash(bytes))){seen.add(hash(bytes));check(bytes.toString('utf8'),depth+1);}
    }
  };
  check(extractLegalBody(markdown),0);
}
