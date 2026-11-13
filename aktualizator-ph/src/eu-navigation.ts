import { load } from 'cheerio';

export interface EuNavigation { sourceFragmentIssues: string[] }
const idsIn = (html: string): Set<string> => {
  const $ = load(html);
  return new Set($('[id],[name]').toArray().flatMap((e) => [$(e).attr('id'), $(e).attr('name')]).filter((id): id is string => !!id));
};
const fragment = (value: string): string => {
  try { return decodeURIComponent(value); } catch { throw new Error('Malformed EU fragment identifier.'); }
};

export function resolveEuNavigation(chunks: string[], names: string[], sourceUrl: string): {chunks: string[]; navigation: EuNavigation} {
  if (chunks.length !== names.length || new Set(names).size !== names.length ||
      names.some((name) => !/^[A-Za-z0-9_.-]+\.md$/.test(name))) throw new Error('Invalid EU part names.');
  const targets = new Map<string, number>();
  chunks.forEach((chunk, i) => { for (const id of idsIn(chunk)) if (!targets.has(id)) targets.set(id, i); });
  const sourceFragmentIssues = new Set<string>();
  const resolved = chunks.map((chunk, i) => {
    const $ = load(chunk);
    $('a[href^="#"]').each((_j, e) => {
      const href = $(e).attr('href')!;
      if (href === '#') return;
      const target = targets.get(fragment(href.slice(1)));
      if (target === undefined) {
        sourceFragmentIssues.add(href);
        // Keep the official reference; never invent a footnote or a local target.
        $(e).attr('href', new URL(href, sourceUrl).href);
      } else if (target !== i) $(e).attr('href', names[target] + href);
    });
    return $('body').html() ?? '';
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
