import { fileMetadata, normalizeOutput } from './output.js';
import fs from 'node:fs';
import path from 'node:path';

export interface FileMetadata { name: string; size: number; md5: string }
export const CONTROL_FILES: readonly string[] = ['INDEX.md', 'REPORT.md', 'manifest.json'];
export type ControlName = 'INDEX.md' | 'REPORT.md' | 'manifest.json';
export type FinalFileDetails =
  | {jurisdiction: 'NL'; kind: 'content'; metadata: {articles: string[];layoutProfile?:'legal-structure-v1'}}
  | {jurisdiction: 'EU'; kind: 'content'; metadata: {celex: string; part: number; sourceHash: string;layoutProfile?:'legal-structure-v1'}}
  | {jurisdiction: 'EU'; kind: 'reference'; metadata: {celex: string; part: number; sourceHash: string; canonicalFile: string}}
  | {jurisdiction: 'NL' | 'EU'; kind: 'control'; metadata: {role: ControlName}};
export type FinalFile = FileMetadata & FinalFileDetails & {content: Buffer};
export type NlFinalFile = Extract<FinalFile, {jurisdiction: 'NL'}>;
export type EuFinalFile = Extract<FinalFile, {jurisdiction: 'EU'}>;

export function safeContentName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9_.-]+\.md$/.test(name);
}
// Content is already final: this function never changes legal text or layout.
// One byte representation supplies the write, generated MD5 and size.
export function finalFile<T extends FinalFileDetails>(name: string, text: string, details: T): FileMetadata & T & {content: Buffer} {
  const validName = details.kind === 'control' ? CONTROL_FILES.includes(name) && name === details.metadata.role : safeContentName(name) && !CONTROL_FILES.includes(name);
  const structural=details.kind==='content'&&details.metadata.layoutProfile==='legal-structure-v1';
  if (!validName || !text.length || (structural?!isLegalMarkdownEncoding(text):text !== normalizeOutput(text))) throw new Error('Invalid final generated file.');
  const content = Buffer.from(text, 'utf8');
  return {...fileMetadata(name, content), ...details, content};
}
export function isLegalMarkdownEncoding(text:string):boolean{
  return !text.includes('\r')&&text.endsWith('\n')&&!text.endsWith('\n\n')&&Buffer.byteLength(text)<=95_000_000&&
    Buffer.from(text,'utf8').toString('utf8')===text;
}
export function writeControlFile(dir: string, jurisdiction: 'NL' | 'EU', name: ControlName, text: string): FileMetadata {
  const file = finalFile(name, text, {jurisdiction, kind: 'control', metadata: {role: name}});
  fs.writeFileSync(path.join(dir, name), file.content);
  return publishedMetadata(file);
}
export function publishedMetadata(file: FileMetadata): FileMetadata {
  return {name: file.name, size: file.size, md5: file.md5};
}
