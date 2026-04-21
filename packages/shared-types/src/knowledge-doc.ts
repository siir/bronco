export const KnowledgeDocSectionKey = {
  PROBLEM_STATEMENT: 'problemStatement',
  ENVIRONMENT: 'environment',
  EVIDENCE: 'evidence',
  HYPOTHESES: 'hypotheses',
  ROOT_CAUSE: 'rootCause',
  RECOMMENDED_FIX: 'recommendedFix',
  RISKS: 'risks',
  OPEN_QUESTIONS: 'openQuestions',
  RUN_LOG: 'runLog',
} as const;
export type KnowledgeDocSectionKey = (typeof KnowledgeDocSectionKey)[keyof typeof KnowledgeDocSectionKey];

export const SUBSECTION_PARENTS = new Set<string>([
  KnowledgeDocSectionKey.EVIDENCE,
  KnowledgeDocSectionKey.HYPOTHESES,
  KnowledgeDocSectionKey.OPEN_QUESTIONS,
]);

export const KnowledgeDocUpdateMode = {
  REPLACE: 'replace',
  APPEND: 'append',
} as const;
export type KnowledgeDocUpdateMode = (typeof KnowledgeDocUpdateMode)[keyof typeof KnowledgeDocUpdateMode];

export interface KnowledgeDocSectionMetaEntry {
  updatedAt: string;
  length: number;
  updatedByRunId?: string;
}

export interface KnowledgeDocSectionMeta {
  [sectionKey: string]: KnowledgeDocSectionMetaEntry;
}

export interface KnowledgeDocTocEntry {
  sectionKey: string;
  title: string;
  length: number;
  lastUpdatedAt: string | null;
  updatedByRunId?: string;
  subsections?: KnowledgeDocTocEntry[];
}

/** Canonical ordered list of top-level sections and their markdown titles. */
export const KNOWLEDGE_DOC_TEMPLATE_SECTIONS: ReadonlyArray<{ key: KnowledgeDocSectionKey; title: string }> = [
  { key: KnowledgeDocSectionKey.PROBLEM_STATEMENT, title: 'Problem Statement' },
  { key: KnowledgeDocSectionKey.ENVIRONMENT, title: 'Environment' },
  { key: KnowledgeDocSectionKey.EVIDENCE, title: 'Evidence' },
  { key: KnowledgeDocSectionKey.HYPOTHESES, title: 'Hypotheses' },
  { key: KnowledgeDocSectionKey.ROOT_CAUSE, title: 'Root Cause' },
  { key: KnowledgeDocSectionKey.RECOMMENDED_FIX, title: 'Recommended Fix' },
  { key: KnowledgeDocSectionKey.RISKS, title: 'Risks' },
  { key: KnowledgeDocSectionKey.OPEN_QUESTIONS, title: 'Open Questions' },
  { key: KnowledgeDocSectionKey.RUN_LOG, title: 'Run Log' },
];

/** Per-section content cap enforced by kd_update_section and kd_add_subsection. */
export const KNOWLEDGE_DOC_SECTION_MAX_CHARS = 10000;
