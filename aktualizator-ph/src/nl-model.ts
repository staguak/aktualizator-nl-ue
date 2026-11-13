import type { ArticleState, ParsedProvision, ScopeAct, VersionSnapshot } from './types.js';
import { fingerprintText } from './content-integrity.js';
import type { TextIntegrity } from './content-integrity.js';
import { normalizeOutput } from './output.js';

export interface NlVersion extends ArticleState { contentHash: string }
export interface NlModel {
  act: ScopeAct;
  rangeFrom: string;
  rangeTo: string;
  articles: {articleId: string; versions: NlVersion[]}[];
  states: NlVersion[];
  sourceStates: {index: number; key: string; validFrom: string | null; validTo: string | null; visibleFrom?:string|null; visibleTo?:string|null; toestandUrl?:string}[];
  selectedArticles: string[];
  missingArticles: string[];
  missingStructures: string[];
  integrity: TextIntegrity;
}

// Explicit BWB interval boundaries are inclusive. This helper compares
// adjacency only; it must never manufacture a missing source end date.
function dayBefore(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function overlaps(
  from: string | null,
  to: string | null,
  rangeFrom: string,
  rangeTo: string,
): boolean {
  if (from && from > rangeTo) return false;
  if (to && to < rangeFrom) return false;
  return true;
}

function normalize(text: string): string { return normalizeOutput(text).trim(); }

function compareArticles(a: string, b: string): number {
  return a.localeCompare(b, 'nl', { numeric: true, sensitivity: 'base' });
}

function matchesStructure(path: string, selector: string): boolean {
  return path === selector || path.startsWith(`${selector}/`);
}

function selectedArticles(
  act: ScopeAct,
  snapshots: VersionSnapshot[],
): { articles: string[]; missingStructures: string[] } {
  const selected = new Set<string>(act.include.articles ?? []);
  const structures = act.include.structures ?? [];
  const matchedStructures = new Set<string>();

  for (const snapshot of snapshots) {
    for (const provision of snapshot.statute.provisions) {
      for (const selector of structures) {
        if (matchesStructure(provision.structurePath, selector)) {
          selected.add(provision.article);
          matchedStructures.add(selector);
        }
      }
    }
  }

  return {
    articles: [...selected].sort(compareArticles),
    missingStructures: structures.filter((s) => !matchedStructures.has(s)),
  };
}

function indexProvisions(snapshot:VersionSnapshot):Map<string,ParsedProvision> {
  const index=new Map<string,ParsedProvision>();
  for(const provision of snapshot.statute.provisions)for(const key of [provision.article,provision.provisionRef]){
    // Preserve the first match of the original ordered linear search, even
    // when an article ID collides with another provision's full reference.
    if(!index.has(key))index.set(key,provision);
  }
  return index;
}

function windowedSnapshots(snapshots: VersionSnapshot[]): Array<{
  snapshot: VersionSnapshot;
  stateIndex: number;
  validFrom: string | null;
  validTo: string | null;
  provisions:Map<string,ParsedProvision>;
}> {
  const sorted = [...snapshots].sort((a, b) => {
    const af = a.version.validFrom ?? '';
    const bf = b.version.validFrom ?? '';
    if (af !== bf) return af.localeCompare(bf);
    return a.version.key.localeCompare(b.version.key);
  });

  return sorted.map((snapshot, index) => {
    const validFrom = snapshot.version.validFrom;
    const validTo = snapshot.version.validTo === '9999-12-31' ? null : snapshot.version.validTo;

    return { snapshot, validFrom, validTo, stateIndex: index,provisions:indexProvisions(snapshot) };
  });
}

function buildStatesForArticle(
  target: string,
  windows: ReturnType<typeof windowedSnapshots>,
  rangeFrom: string,
  rangeTo: string,
): ArticleState[] {
  const states: ArticleState[] = [];
  let open: ArticleState | null = null;

  for (const window of windows) {
    const provision = window.provisions.get(target);

    if (!provision) {
      if (open) {
        states.push(open);
        open = null;
      }
      continue;
    }

    const content = normalize(provision.content);
    if (!content) {if(open)states.push(open);open=null;continue;}

    // Equal bytes do not fill an unobserved interval or establish repeal.
    const continuous=open&&window.validFrom!==null&&(open.validTo!==null
      ?dayBefore(window.validFrom)<=open.validTo:open.validFrom===window.validFrom);
    if (open && open.content === content && open.title === provision.title && continuous) {
      open.validTo = open.validTo===null||window.validTo===null?null:
        (open.validTo>window.validTo?open.validTo:window.validTo);
      open.sourceStates.push(window.stateIndex);
      open.sourceStateCount = open.sourceStates.length;
      if (!open.sourceUrls.includes(window.snapshot.version.toestandUrl)) {
        open.sourceUrls.push(window.snapshot.version.toestandUrl);
      }
      continue;
    }

    if (open) states.push(open);

    open = {
      article: target,
      title: provision.title,
      validFrom: window.validFrom,
      validTo: window.validTo,
      content,
      sourceUrls: [window.snapshot.version.toestandUrl],
      sourceStates: [window.stateIndex],
      sourceStateCount: 1,
    };
  }

  if (open) states.push(open);

  return states.filter((state) =>
    overlaps(state.validFrom, state.validTo, rangeFrom, rangeTo),
  );
}

export function buildNlModel(act: ScopeAct, snapshots: VersionSnapshot[], rangeFrom: string, rangeTo: string): NlModel {
  const windows = windowedSnapshots(snapshots);
  const resolved = selectedArticles(act, snapshots);
  const articles = resolved.articles.map(articleId => ({articleId,
    versions: buildStatesForArticle(articleId, windows, rangeFrom, rangeTo).map(state =>
      ({...state, contentHash: fingerprintText(state.content).sha256})),
  }));
  const present = new Set(articles.filter(a => a.versions.length).map(a => a.articleId));
  const states = articles.flatMap(a => a.versions);
  return {act, rangeFrom, rangeTo, articles, states,
    sourceStates: windows.map(({snapshot}, index) => ({index, key: snapshot.version.key,
      validFrom: snapshot.version.validFrom,
      ...(snapshot.version.visibleFrom!==undefined?{visibleFrom:snapshot.version.visibleFrom,visibleTo:snapshot.version.visibleTo,toestandUrl:snapshot.version.toestandUrl}:{}),
      validTo: snapshot.version.validTo === '9999-12-31' ? null : snapshot.version.validTo})),
    selectedArticles: resolved.articles,
    missingArticles: [...new Set([...act.mustIncludeArticles, ...resolved.articles].filter(id => !present.has(id)))],
    missingStructures: resolved.missingStructures,
    integrity: fingerprintText(states.map(state => state.content).join('\n')),
  };
}
