import type { ArticleState } from './types.js';
import type { NlModel } from './nl-model.js';
import { NL_START, NL_END } from './content-integrity.js';
import { normalizeOutput } from './output.js';

export function articleBlock(article: string, states: ArticleState[], sources: Map<string, string>): string {
  const out: string[] = [`## Artikel ${article}`, ''];

  for (const state of states) {
    const from = state.validFrom ?? '?';
    const to = state.validTo ?? 'open';
    const title = state.title ? ` — ${state.title}` : '';

    out.push(`### V=${from} – ${to}${title}`, '');
    if (state.content.includes(NL_START) || state.content.includes(NL_END)) throw new Error('Reserved NL text marker in source.');
    out.push(NL_START, state.content, NL_END, '');

    out.push('Źródła: ' + state.sourceUrls.map(url => `[^${sources.get(url)}]`).join(' '));
    out.push('');
  }

  return out.join('\n').trimEnd() + '\n';
}

export function nlHeader(model: NlModel): string {
  const {act, rangeFrom, rangeTo} = model;
  return `# ${act.order}. ${act.title}\n\nBWB: ${act.bwbId} · Zakres: ${rangeFrom} – ${rangeTo}\n\n`;
}
export function renderNlPart(model: NlModel, articles: string[]): string {
  const states = new Map(model.articles.map(a => [a.articleId, a.versions]));
  const urls = [...new Set(articles.flatMap(a => states.get(a)!.flatMap(s => s.sourceUrls)))].sort();
  const sources = new Map(urls.map((url, i) => [url, `S${i+1}`]));
  return normalizeOutput(nlHeader(model) + articles.map(a => articleBlock(a, states.get(a)!, sources)).join('\n') +
    '\n## Źródła\n\n' + urls.map(url => `[^${sources.get(url)}]: ${url}`).join('\n'));
}
