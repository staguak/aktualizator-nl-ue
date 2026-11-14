export interface ScopeInclude {
  articles?: string[];
  structures?: string[];
}

export interface ScopeAct {
  order: number;
  title: string;
  bwbId: string;
  include: ScopeInclude;
  mustIncludeArticles: string[];
  /** Search selectors stay unchanged; expand retrieved content when enabled. */
  retrievalScope?: 'full-act';
  outputProfile?:'legal-structure-v1';
}

export interface ScopeConfig {
  schemaVersion: number;
  source: {
    title: string;
    derivedAt: string;
    frozenReference?: {
      title: string;
      driveFileId?: string;
      modifiedAt?: string;
      note?: string;
    };
  };
  policy?: {
    rangeTo?: string;
    baselineBeforeRange?: boolean;
    failClosedOnMissingMigrationArticles?: boolean;
    note?: string;
  };
  acts: ScopeAct[];
}

export interface VersionRecord {
  key: string;
  toestandUrl: string;
  validFrom: string | null;
  validTo: string | null;
  visibleFrom?: string | null;
  visibleTo?: string | null;
  wtiUrl?: string | null;
  manifestUrl?: string | null;
}

export interface ParsedProvision {
  provisionRef: string;
  article: string;
  title?: string;
  content: string;
  structurePath: string;
}

export interface ParsedStatute {
  bwbId: string;
  title: string;
  inForceDate?: string;
  provisions: ParsedProvision[];
}

export interface VersionSnapshot {
  sourceSha256?:string;
  legalDraft?:import('./legal-structure.js').LegalDraft;
  version: VersionRecord;
  statute: ParsedStatute;
}

export interface ArticleState {
  article: string;
  title?: string;
  validFrom: string | null;
  validTo: string | null;
  content: string;
  sourceUrls: string[];
  sourceStates: number[];
  sourceStateCount: number;
}

export interface RenderedChunk {
  file: import('./final-file.js').NlFinalFile;
  fileName: string;
  articleCount: number;
  articles: string[];
  content: string;
}
