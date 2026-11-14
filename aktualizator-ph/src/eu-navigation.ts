import { load } from 'cheerio';

export interface EuNavigation { sourceFragmentIssues: string[] }
const idsIn = (html: string): Set<string> => {
  const $ = load(html);
  return new Set($('[id],[name]').toArray().flatMap((e) => [$(e).attr('id'), $(e).attr('name')]).filter((id): id is string => !!id));
};
const fragment = (value: string): string => {
  try { return decodeURIComponent(value); } catch { throw new Error('Malformed EU fragment identifier.'); }
};

export function resolveEuNavigation(chunks: string[], names: string[], sourceUrl: string,fragmentMode=false): {chunks: string[]; navigation: EuNavigation} {
  if (chunks.length !== names.length || new Set(names).size !== names.length ||
      names.some((name) => !/^[A-Za-z0-9_.-]+\.md$/.test(name))) throw new Error('Invalid EU part names.');
  const targets = new Map<string, number>();
  chunks.forEach((chunk, i) => { for (const id of idsIn(chunk)) if (!targets.has(id)) targets.set(id, i); });
  const sourceFragmentIssues = new Set<string>();
  const resolved = chunks.map((chunk, i) => {
    const $ = load(chunk,{sourceCodeLocationInfo:fragmentMode},!fragmentMode);
    const edits=new Map<number,{end:number;text:string}>();
    $('a[href^="#"]').each((_j, e) => {
      const href = $(e).attr('href')!;
      if (href === '#') return;
      const target = targets.get(fragment(href.slice(1)));
      let replacement:string|undefined;
      if (target === undefined) {
        sourceFragmentIssues.add(href);
        // Keep the official reference; never invent a footnote or a local target.
        replacement=new URL(href, sourceUrl).href;
      } else if (target !== i) replacement=names[target]+href;
      if(replacement!==undefined){
        if(fragmentMode){
          const location=(e as any).sourceCodeLocation?.attrs?.href;
          if(!location||!Number.isInteger(location.startOffset)||!Number.isInteger(location.endOffset)||
            location.startOffset<0||location.endOffset>chunk.length||location.endOffset<=location.startOffset)throw new Error('Missing original legal hyperlink offsets.');
          const text='href="'+replacement.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')+'"';
          const prior=edits.get(location.startOffset);
          if(prior&&(prior.end!==location.endOffset||prior.text!==text))throw new Error('Conflicting original legal hyperlink edits.');
          edits.set(location.startOffset,{end:location.endOffset,text});
        }else $(e).attr('href',replacement);
      }
    });
    if(!fragmentMode)return $('body').html()??'';
    // Re-serializing a parsed table can foster-parent its anchors outside
    // their logical units. Patch only actual href spans in the exact body.
    let result=chunk,boundary=chunk.length;
    for(const [start,edit] of [...edits].sort((a,b)=>b[0]-a[0])){
      if(edit.end>boundary)throw new Error('Overlapping original legal hyperlink edits.');
      result=result.slice(0,start)+edit.text+result.slice(edit.end);boundary=start;
    }
    return result;
  });
  validateEuNavigation(resolved, names);
  return { chunks: resolved, navigation: {sourceFragmentIssues: [...sourceFragmentIssues].sort()} };
}

export function validateEuNavigation(chunks: string[], names: string[]): void {
  const targets = new Map(names.map((name, i) => [name, idsIn(chunks[i])]));
  chunks.forEach((chunk, i) => {
    const $ = load(chunk);
    $('a[href]').each((_j, e) => {
      const href = $(e).attr('href')!;
      if (href === '#' || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return;
      const separator = href.indexOf('#');
      const name = separator < 0 ? href : href.slice(0, separator) || names[i];
      const id = separator < 0 ? '' : fragment(href.slice(separator + 1));
      if (!targets.has(name) || (id && !targets.get(name)!.has(id))) throw new Error('Broken local EU reference.');
    });
  });
}
