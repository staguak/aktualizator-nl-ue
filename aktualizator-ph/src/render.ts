import assert from 'node:assert/strict';
import { parseNlFinal } from './nl-final-parser.js';
import type { RenderedChunk, ScopeAct, VersionSnapshot } from './types.js';
import { assertIntegrity, nlOutputIntegrity } from './content-integrity.js';
import { buildNlModel } from './nl-model.js';
import type { NlModel } from './nl-model.js';
import { planNlParts } from './nl-plan.js';
import { renderNlPart } from './nl-format.js';
import { finalFile } from './final-file.js';

export interface RenderResult extends NlModel { chunks: RenderedChunk[] }
export function renderNlModel(model: NlModel): RenderResult {
  const chunks = planNlParts(model).map(part => {
    const content = renderNlPart(model, part.articles);
    const file = finalFile(part.name, content, {jurisdiction: 'NL', kind: 'content', metadata: {articles: part.articles}});
    if (file.size !== part.predictedSize) throw new Error('NL predicted final chunk size differs from rendered bytes.');
    return {fileName: file.name,
      articles: part.articles, articleCount: part.articles.length, content, file};
  });
  // Check exact source/version attribution before discarding the logical model.
  const restored = chunks.flatMap(chunk => parseNlFinal(chunk.content));
  assert.deepEqual(restored.map(a => ({articleId:a.articleId,versions:a.versions.map(v =>
    ({validFrom:v.validFrom,validTo:v.validTo,content:v.content,sourceUrls:v.sourceUrls}))})),
    model.articles.filter(a => a.versions.length).map(a => ({articleId:a.articleId,versions:a.versions.map(v =>
      ({validFrom:v.validFrom,validTo:v.validTo,content:v.content,sourceUrls:v.sourceUrls}))})));
  assertIntegrity(model.integrity, nlOutputIntegrity(chunks.map(chunk => chunk.content)));
  return {...model, chunks};
}
// Convenience entry point; source/model decisions live entirely in nl-model.
export function renderAct(act: ScopeAct, snapshots: VersionSnapshot[], rangeFrom: string, rangeTo: string): RenderResult {
  return renderNlModel(buildNlModel(act, snapshots, rangeFrom, rangeTo));
}
