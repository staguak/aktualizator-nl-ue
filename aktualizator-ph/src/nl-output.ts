import type { ScopeAct } from './types.js';
import {imageIndexRows} from './legal-images.js';
import type { TextIntegrity } from './content-integrity.js';
import { publishedMetadata } from './final-file.js';
import type { RenderResult } from './render.js';
import { normalizeOutput, outputChanges } from './output.js';
import { pendingValidation, reportValidation } from './validation-result.js';
import type { ValidationResult } from './validation-result.js';
import type { SourceArchive } from './official-sources.js';
import {renderBuildReport} from './build-report.js';
import {legalIndexRows} from './legal-structure.js';
import type {LegalManifest} from './legal-structure.js';

export interface NlActManifest {
  order: number; title: string; bwbId: string; selectedArticles: string[];
  selectors: ScopeAct['include']; fetchedStates: number; discoveredVersions: number;
  retrievalScope?:'full-act';requestedArticles?:string[];
  sourceStates: { index: number; key: string; validFrom: string | null; validTo: string | null }[];
  articles: {articleId: string; versions: {validFrom: string | null; validTo: string | null;
    sourceStates: number[]; sourceStateCount: number; merged: boolean; contentHash: string}[]}[];
  files: {name: string; articles: string[]; articleCount: number; size: number; md5: string}[];
  integrity: TextIntegrity;
  sourceArchive?: SourceArchive;
  legalDocuments?:LegalManifest[];
}
export function nlActManifest(rendered: RenderResult, discoveredVersions: number): NlActManifest {
  const act = rendered.act;
  return {order: act.order, title: act.title, bwbId: act.bwbId, selectedArticles: rendered.selectedArticles,
    selectors: act.include, fetchedStates: rendered.sourceStates.length, discoveredVersions,
    ...(rendered.retrievalScope?{retrievalScope:rendered.retrievalScope,requestedArticles:rendered.requestedArticles}:{}),
    ...(rendered.legalDocuments?{legalDocuments:rendered.legalDocuments}:{}),
    sourceStates: rendered.sourceStates,
    articles: rendered.articles.map(({articleId, versions}) => ({articleId, versions: versions.map(s => ({
      validFrom: s.validFrom, validTo: s.validTo, sourceStates: s.sourceStates, sourceStateCount: s.sourceStateCount,
      merged: s.sourceStateCount > 1, contentHash: s.contentHash}))})),
    files: rendered.chunks.map(c => ({...publishedMetadata(c.file), articles:c.articles, articleCount:c.articleCount})), integrity:rendered.integrity};
}
export function nlIndex(manifest: {rangeFrom: string; rangeTo: string; acts: NlActManifest[];imagePackage?:unknown}): string {
  return normalizeOutput(['# Aktualizator NL — indeks','',`Zakres: ${manifest.rangeFrom} – ${manifest.rangeTo}`,'',
    ...manifest.acts.flatMap(a => [`## ${a.order}. ${a.title}`,'',`Artykuły: ${a.selectedArticles.join(', ')}.`,'',
      ...(a.legalDocuments?a.legalDocuments.flatMap(doc=>[`### Wersja ${doc.version}`,'',...legalIndexRows(doc),...doc.parts.map(p=>`- [Część strukturalna ${p.sequence}](${p.file})`),'']):a.files.map(f => `- [${f.name}](${f.name}) — art. ${f.articles.join(', ')}`)),
      ...(a.sourceArchive?[`- [Oryginalne źródła BWB](${a.sourceArchive.distribution?.bundle??a.sourceArchive.name}) — ${a.sourceArchive.entryCount} zasobów; MD5 ${a.sourceArchive.md5}.${a.sourceArchive.distribution?' Katalog: '+a.sourceArchive.distribution.prefix+'.':''}`]:[]),'']),...imageIndexRows(manifest)].join('\n'));
}
export function nlReport(manifest: any, previous: any, validation: ValidationResult = pendingValidation()): string {
  const acts: NlActManifest[] = manifest.acts;
  const versions = acts.flatMap(a => a.articles.flatMap(a => a.versions));
  const files = acts.flatMap(a => a.files);
  return normalizeOutput(['# Aktualizator NL — raport wykonania','',`Uruchomienie: ${manifest.generatedAt}`,
    `Zakres: ${manifest.rangeFrom} – ${manifest.rangeTo}`,'',
    `Akty: ${acts.length}; artykuły: ${acts.reduce((n,a)=>n+a.articles.length,0)}; wersje: ${versions.length}.`,
    `Pobrane stany aktów: ${acts.reduce((n,a)=>n+a.fetchedStates,0)}; scalone dodatkowe stany artykułów: ${versions.reduce((n,v)=>n+v.sourceStateCount-1,0)}.`,
    `Pliki treści: ${files.length}; rozmiar korpusu: ${files.reduce((n,f)=>n+f.size,0)} bajtów.`,
    `Zmiany: ${outputChanges(previous,manifest)}`,'','## Ostrzeżenia i anomalie','',
    ...(manifest.officialSources?['XML w archiwach źródłowych zachowuje oryginalne bajty. Markdown jest widokiem pochodnym.',
      'Przedziały V opisują zarejestrowane brzmienie w stanach BWB, nie osobne daty obowiązywania wszystkich ustępów.',
      ...acts.flatMap(a=>(a.sourceArchive?.warnings??[]).map(w=>`- ${a.bwbId}: ${w}`))]:[]),
    ...acts.flatMap(a=>(a.legalDocuments??[]).filter(d=>d.sourceFragmentIssues?.length).map(d=>`- ${a.bwbId}, ${d.version}: nierozpoznane fragmenty źródła zachowano jako odnośniki urzędowe: ${d.sourceFragmentIssues!.join(', ')}.`)),
    ...acts.filter(a=>!a.legalDocuments).flatMap(a=>a.files.filter(f=>f.size>50_000)).map(f=>`- ${f.name}: ${f.size} bajtów; niepodzielny artykuł przekracza 50 000 bajtów.`),
    validation.status==='PASS' ? 'Nie wykryto braków wybranych artykułów ani pustych selektorów.' : 'Ocena braków i selektorów: zobacz wynik walidacji.', '',
    reportValidation(validation),renderBuildReport(manifest,previous,validation)].join('\n'));
}
