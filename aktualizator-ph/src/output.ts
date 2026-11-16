import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const hash = (content: string | Buffer, algorithm = 'sha256'): string =>
  createHash(algorithm).update(content).digest('hex');
// These are the only common layout transformations. Do not collapse legal whitespace.
export function normalizeOutput(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n');
  const fragments: string[] = [];
  let start = 0;
  // JavaScript's multiline end-of-line anchor also recognizes U+2028 and U+2029.
  // Preserve those separators while trimming only trailing spaces and tabs.
  for (let i = 0; i <= normalized.length; i++) {
    const code = i < normalized.length ? normalized.charCodeAt(i) : -1;
    if (i < normalized.length && code !== 10 && code !== 0x2028 && code !== 0x2029) continue;
    let end = i;
    while (end > start && (normalized.charCodeAt(end - 1) === 32 || normalized.charCodeAt(end - 1) === 9)) end--;
    fragments.push(normalized.slice(start, end));
    if (i < normalized.length) fragments.push(normalized[i]);
    start = i + 1;
  }
  const output = fragments.join('');
  let end = output.length;
  while (end && output.charCodeAt(end - 1) === 10) end--;
  return output.slice(0, end) + '\n';
}
const ordered = (item: any): any => Array.isArray(item) ? item.map(ordered) :
    item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).filter(k=>item[k]!==undefined).sort().map(k => [k, ordered(item[k])])) : item;
export function stableCompactJson(value:unknown):string{return JSON.stringify(ordered(value))+'\n';}
export function stableJson(value: unknown): string {
  const spaced = (raw: string): string => {
    let quoted = false, escaped = false;
    const out: string[] = [];
    for (const character of raw) {
      out.push(character);
      if (escaped) { escaped = false; continue; }
      if (quoted && character === '\\') { escaped = true; continue; }
      if (character === '"') quoted = !quoted;
      if (character === ',' && !quoted) out.push(' ');
    }
    return out.join('');
  };
  const render = (item: any, depth: number): string => {
    const pad = '  '.repeat(depth), child = '  '.repeat(depth + 1);
    if (!item || typeof item !== 'object') return JSON.stringify(item);
    const compact = spaced(JSON.stringify(item));
    if (Array.isArray(item)) {
      if (!item.length || item.every(v => v === null || typeof v !== 'object')) return spaced(JSON.stringify(item));
      return '[\n' + item.map(v => child + render(v, depth+1)).join(',\n') + '\n' + pad + ']';
    }
    // Keep short records (states, versions, integrity) on one line. Never minify the root.
    if (depth >= 2 && compact.length <= 320) return compact;
    const keys = Object.keys(item);
    if (!keys.length) return '{}';
    return '{\n' + keys.map(k => child + JSON.stringify(k) + ': ' + render(item[k], depth+1)).join(',\n') + '\n' + pad + '}';
  };
  return normalizeOutput(render(ordered(value), 0));
}
export function fileMetadata(name: string, content: string | Buffer) {
  return { name, size: Buffer.byteLength(content, 'utf8'), md5: hash(content, 'md5') };
}
export function readPreviousManifest(dir: string): any | undefined {
  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) return undefined;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('Unreadable previous local manifest.'); }
}
export function outputChanges(previous: any, next: any): string {
  if (!previous) return 'Brak poprzedniego lokalnego zestawu do porównania.';
  const old = new Map<string,string>((previous.acts ?? []).flatMap((a: any) => a.files.map((f: any) => [f.name, f.md5])));
  const current = new Map<string,string>(next.acts.flatMap((a: any) => a.files.map((f: any) => [f.name, f.md5])));
  const added = [...current.keys()].filter(k => !old.has(k)).length;
  const removed = [...old.keys()].filter(k => !current.has(k)).length;
  const changed = [...current].filter(([k,v]) => old.has(k) && old.get(k) !== v).length;
  return `Dodane: ${added}; zmienione: ${changed}; wycofane części: ${removed}; bez zmian: ${current.size-added-changed}.`;
}
