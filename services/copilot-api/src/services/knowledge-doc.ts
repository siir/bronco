/**
 * Re-export of the shared knowledge-doc helpers. Core parse / compose / update
 * logic lives in `@bronco/shared-utils` so that the mcp-platform server,
 * ticket-analyzer worker, and these REST handlers all reach for the same
 * implementation without a circular copilot-api dependency.
 */
export {
  initEmptyKnowledgeDoc,
  slugify,
  splitIntoSections,
  composeSections,
  buildToc,
  readSection,
  updateSection,
  addSubsection,
  loadKnowledgeDoc,
  KnowledgeDocError,
  REQUIRED_SECTION_KEYS,
} from '@bronco/shared-utils';
export type { KdSection, KdReadSectionResult, PrismaTx } from '@bronco/shared-utils';
