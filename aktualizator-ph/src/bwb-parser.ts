/*
 * The BWB source uses mixed-content XML: ordinary sentence text can be
 * interrupted by inline elements such as <intref>, <extref> and <nadruk>.
 * fast-xml-parser's default object mode does not retain the relative position
 * of those text fragments, so legal wording can be reordered. This parser
 * deliberately uses preserveOrder=true and reconstructs text in XML order.
 *
 * The original hierarchy/parsing approach was adapted from Ansvar Systems,
 * Dutch-law-mcp (Apache-2.0). See ../third_party/Ansvar-Apache-2.0.txt.
 */

import { XMLParser } from 'fast-xml-parser';
import type { ParsedProvision, ParsedStatute } from './types.js';

type OrderedNode = Record<string, unknown>;
type OrderedChildren = OrderedNode[];

interface ElementView {
  name: string;
  node: OrderedNode;
  children: OrderedChildren;
  attrs: Record<string, unknown>;
}

function attr(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function asChildren(value: unknown): OrderedChildren {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is OrderedNode =>
      item != null && typeof item === 'object' && !Array.isArray(item),
  );
}

function elementView(node: OrderedNode): ElementView | null {
  for (const [key, value] of Object.entries(node)) {
    if (
      key === ':@' ||
      key === '#text' ||
      key === '#cdata' ||
      key.startsWith('?') ||
      key.startsWith('#')
    ) {
      continue;
    }
    if (!Array.isArray(value)) continue;

    const rawAttrs = node[':@'];
    return {
      name: key,
      node,
      children: asChildren(value),
      attrs:
        rawAttrs != null && typeof rawAttrs === 'object' && !Array.isArray(rawAttrs)
          ? (rawAttrs as Record<string, unknown>)
          : {},
    };
  }
  return null;
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\n\f\r ]+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim();
}

/**
 * Reconstruct mixed XML text exactly in child order, then normalize layout
 * whitespace. No separator is injected between child nodes: spaces and
 * punctuation come from the XML itself, which prevents inline references from
 * moving to the beginning/end of a sentence.
 */
function orderedTextRaw(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(orderedTextRaw).join('');
  if (typeof value !== 'object') return '';

  const obj = value as OrderedNode;
  if ('#text' in obj) return attr(obj['#text']);
  if ('#cdata' in obj) return attr(obj['#cdata']);

  const view = elementView(obj);
  if (view?.name === 'redactie') {
    const inner = normalizeText(orderedTextRaw(view.children));
    if (!inner) return '';
    const alreadyBracketed = /^\\[.*\\]$/.test(inner);
    return alreadyBracketed ? ` ${inner} ` : ` [Red: ${inner}] `;
  }
  if (view) return orderedTextRaw(view.children);
  return '';
}

function orderedText(value: unknown): string {
  return normalizeText(orderedTextRaw(value));
}

function directElements(children: OrderedChildren, name: string): ElementView[] {
  const out: ElementView[] = [];
  for (const child of children) {
    const view = elementView(child);
    if (view?.name === name) out.push(view);
  }
  return out;
}

function firstDirectElement(
  children: OrderedChildren,
  name: string,
): ElementView | undefined {
  return directElements(children, name)[0];
}

function firstDirectText(children: OrderedChildren, name: string): string {
  const view = firstDirectElement(children, name);
  return view ? orderedText(view.children) : '';
}

function getKopNr(view: ElementView): string | undefined {
  const kop = firstDirectElement(view.children, 'kop');
  if (!kop) return undefined;
  const nr = firstDirectText(kop.children, 'nr');
  return nr || undefined;
}

function getKopTitle(view: ElementView): string | undefined {
  const kop = firstDirectElement(view.children, 'kop');
  if (!kop) return undefined;
  const title = firstDirectText(kop.children, 'titel');
  return title || undefined;
}

function articleNumber(view: ElementView): string {
  const direct = attr(view.attrs['@_nr']).trim();
  if (direct) return direct;

  const kopNr = getKopNr(view);
  if (kopNr) return kopNr;

  const kop = firstDirectElement(view.children, 'kop');
  const label = kop ? firstDirectText(kop.children, 'label') : '';
  if (/^ee?nig artikel$/i.test(label)) return 'enig';

  return '';
}

function numberedPrefix(number: string, lines: string[]): string[] {
  if (!number) return lines;
  if (lines.length === 0) return [number];
  return [`${number} ${lines[0]}`, ...lines.slice(1)];
}

const BLOCK_METADATA = new Set([
  'kop',
  'meta-data',
  'lidnr',
  'li.nr',
]);

function renderListItem(view: ElementView): string[] {
  const number =
    firstDirectText(view.children, 'li.nr') ||
    firstDirectText(view.children, 'nr') ||
    attr(view.attrs['@_nr']).trim();

  const lines: string[] = [];
  for (const child of view.children) {
    const childView = elementView(child);
    if (childView && BLOCK_METADATA.has(childView.name)) continue;
    lines.push(...renderBlockNode(child));
  }

  const compact = lines.map(normalizeText).filter(Boolean);
  if (compact.length === 0) {
    const fallback = orderedText(
      view.children.filter((child) => {
        const childView = elementView(child);
        return !childView || !BLOCK_METADATA.has(childView.name);
      }),
    );
    if (fallback) compact.push(fallback);
  }

  return numberedPrefix(number, compact);
}

function renderList(view: ElementView): string[] {
  const lines: string[] = [];
  for (const child of view.children) {
    const childView = elementView(child);
    if (!childView) continue;
    if (childView.name === 'li') {
      lines.push(...renderListItem(childView));
    } else if (!BLOCK_METADATA.has(childView.name)) {
      lines.push(...renderBlockNode(child));
    }
  }
  return lines;
}

function renderDefinitionItem(view: ElementView): string[] {
  const term = firstDirectText(view.children, 'term');
  const definitionView = firstDirectElement(view.children, 'definitie');
  const definition = definitionView ? orderedText(definitionView.children) : '';
  const line = normalizeText([term, definition].filter(Boolean).join(' '));
  return line ? [line] : [];
}

function renderDefinitionList(view: ElementView): string[] {
  const lines: string[] = [];
  for (const child of view.children) {
    const childView = elementView(child);
    if (childView?.name === 'definitie-item') {
      lines.push(...renderDefinitionItem(childView));
    }
  }
  return lines;
}

function renderLid(view: ElementView): string[] {
  const number =
    firstDirectText(view.children, 'lidnr') ||
    attr(view.attrs['@_nr']).trim() ||
    getKopNr(view) ||
    '';

  const lines: string[] = [];
  for (const child of view.children) {
    const childView = elementView(child);
    if (childView && BLOCK_METADATA.has(childView.name)) continue;
    lines.push(...renderBlockNode(child));
  }

  const compact = lines.map(normalizeText).filter(Boolean);
  if (compact.length === 0) {
    const fallback = orderedText(
      view.children.filter((child) => {
        const childView = elementView(child);
        return !childView || !BLOCK_METADATA.has(childView.name);
      }),
    );
    if (fallback) compact.push(fallback);
  }

  return numberedPrefix(number, compact);
}

function renderBlockNode(node: OrderedNode): string[] {
  if ('#text' in node || '#cdata' in node) {
    const text = orderedText(node);
    return text ? [text] : [];
  }

  const view = elementView(node);
  if (!view) return [];

  if (BLOCK_METADATA.has(view.name)) return [];

  switch (view.name) {
    case 'al': {
      const text = orderedText(view.children);
      return text ? [text] : [];
    }
    case 'lid':
      return renderLid(view);
    case 'lijst':
    case 'lista':
      return renderList(view);
    case 'li':
      return renderListItem(view);
    case 'definitielijst':
      return renderDefinitionList(view);
    case 'definitie-item':
      return renderDefinitionItem(view);
    default: {
      // Unknown block/container: recurse instead of flattening the whole object.
      // This keeps source order and lets known nested al/lijst/lid nodes retain
      // their line structure. Pure inline wrappers still collapse to one line.
      const nested: string[] = [];
      for (const child of view.children) nested.push(...renderBlockNode(child));
      const compact = nested.map(normalizeText).filter(Boolean);
      if (compact.length > 0) return compact;

      const text = orderedText(view.children);
      return text ? [text] : [];
    }
  }
}

function extractArticleContent(view: ElementView): string {
  const lines: string[] = [];

  for (const child of view.children) {
    const childView = elementView(child);
    if (childView?.name === 'kop' || childView?.name === 'meta-data') continue;
    lines.push(...renderBlockNode(child));
  }

  return lines
    .map((line) => normalizeText(line))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function isNumericBook(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

interface WalkContext {
  book?: string;
  path: string[];
}

const STRUCTURE_KEYS = new Set([
  'boek',
  'deel',
  'hoofdstuk',
  'titeldeel',
  'afdeling',
  'paragraaf',
  'sub-paragraaf',
  'subparagraaf',
]);

const SKIP_WALK = new Set([
  'meta-data',
  'bwb-inputbestand',
  'bwb-wijzigingen',
  'redactionele-correcties',
]);

function structureNumber(view: ElementView): string {
  return attr(view.attrs['@_nr']).trim() || getKopNr(view) || '';
}

function structureSegment(kind: string, view: ElementView): string {
  const nr = structureNumber(view);
  return nr ? `${kind}:${nr}` : kind;
}

function walk(
  nodes: OrderedChildren,
  context: WalkContext,
  out: ParsedProvision[],
): void {
  for (const node of nodes) {
    const view = elementView(node);
    if (!view) continue;
    if (SKIP_WALK.has(view.name)) continue;

    if (view.name === 'artikel') {
      const nr = articleNumber(view);
      if (!nr) continue;

      out.push({
        provisionRef: context.book ? `${context.book}:${nr}` : nr,
        article: nr,
        title: getKopTitle(view),
        content: extractArticleContent(view),
        structurePath: context.path.join('/'),
      });
      continue;
    }

    if (STRUCTURE_KEYS.has(view.name)) {
      const nr = structureNumber(view);
      const nextBook =
        view.name === 'boek' && nr && isNumericBook(nr) ? nr : context.book;
      walk(
        view.children,
        {
          book: nextBook,
          path: [...context.path, structureSegment(view.name, view)],
        },
        out,
      );
      continue;
    }

    walk(view.children, context, out);
  }
}

function findFirstElement(
  nodes: OrderedChildren,
  name: string,
): ElementView | undefined {
  for (const node of nodes) {
    const view = elementView(node);
    if (!view) continue;
    if (view.name === name) return view;
    const nested = findFirstElement(view.children, name);
    if (nested) return nested;
  }
  return undefined;
}

export function parseBwbXml(xml: string): ParsedStatute {
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
  });

  const parsed = parser.parse(xml) as unknown;
  const root = asChildren(parsed);

  const toestand = findFirstElement(root, 'toestand');
  const wetgeving = toestand
    ? firstDirectElement(toestand.children, 'wetgeving')
    : findFirstElement(root, 'wetgeving');

  const bwbId =
    attr(toestand?.attrs['@_bwb-id']).trim() ||
    attr(wetgeving?.attrs['@_bwb-id']).trim();

  const rawDate = attr(toestand?.attrs['@_inwerkingtreding']).trim();
  const inForceDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
    ? rawDate
    : undefined;

  if (!wetgeving) {
    return { bwbId, title: '', inForceDate, provisions: [] };
  }

  const title =
    firstDirectText(wetgeving.children, 'intitule') ||
    firstDirectText(wetgeving.children, 'citeertitel') ||
    bwbId;

  const provisions: ParsedProvision[] = [];
  walk(wetgeving.children, { path: [] }, provisions);

  const unique = new Map<string, ParsedProvision>();
  for (const provision of provisions) {
    const key = [
      provision.provisionRef,
      provision.structurePath,
      provision.content,
    ].join('\u0000');
    if (!unique.has(key)) unique.set(key, provision);
  }

  return {
    bwbId,
    title,
    inForceDate,
    provisions: [...unique.values()],
  };
}
