/**
 * Unit tests for packages/shared-utils/src/knowledge-doc.ts
 *
 * Tests cover pure-function exports only. DB-dependent functions
 * (updateSection, addSubsection, loadKnowledgeDoc) require a Prisma
 * connection and are deferred to integration tests.
 */

import { describe, it, expect } from 'vitest';
import {
  KNOWLEDGE_DOC_SECTION_MAX_CHARS,
  KNOWLEDGE_DOC_TEMPLATE_SECTIONS,
  KnowledgeDocSectionKey,
  SUBSECTION_PARENTS,
} from '@bronco/shared-types';
import {
  initEmptyKnowledgeDoc,
  slugify,
  splitIntoSections,
  composeSections,
  buildToc,
  readSection,
  type KdSection,
} from './knowledge-doc.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Canonical titles in template order. */
const TEMPLATE_TITLES = KNOWLEDGE_DOC_TEMPLATE_SECTIONS.map(s => s.title);
const TEMPLATE_KEYS = KNOWLEDGE_DOC_TEMPLATE_SECTIONS.map(s => s.key);

/** Build a minimal canonical doc with user-supplied section content. */
function makeDoc(overrides: Partial<Record<KnowledgeDocSectionKey, string>> = {}): string {
  const parts: string[] = [];
  for (const { key, title } of KNOWLEDGE_DOC_TEMPLATE_SECTIONS) {
    parts.push(`## ${title}`);
    parts.push('');
    const body = overrides[key as KnowledgeDocSectionKey] ?? '';
    if (body) {
      parts.push(body);
      parts.push('');
    }
    parts.push('');
  }
  return parts.join('\n').trimEnd() + '\n';
}

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe('slugify', () => {
  it('lowercases and replaces spaces with dashes', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('collapses multiple non-alnum runs to a single dash', () => {
    expect(slugify('foo  --  bar')).toBe('foo-bar');
  });

  it('strips leading and trailing dashes', () => {
    expect(slugify('  --foo--  ')).toBe('foo');
  });

  it('handles already-clean slugs', () => {
    expect(slugify('problem-statement')).toBe('problem-statement');
  });

  it('returns "section" for an empty or all-special-char title', () => {
    expect(slugify('')).toBe('section');
    expect(slugify('!@#$%')).toBe('section');
  });

  it('preserves digits', () => {
    expect(slugify('Step 1 of 3')).toBe('step-1-of-3');
  });
});

// ---------------------------------------------------------------------------
// initEmptyKnowledgeDoc
// ---------------------------------------------------------------------------

describe('initEmptyKnowledgeDoc', () => {
  it('produces a non-empty string ending with a newline', () => {
    const doc = initEmptyKnowledgeDoc();
    expect(typeof doc).toBe('string');
    expect(doc.length).toBeGreaterThan(0);
    expect(doc.endsWith('\n')).toBe(true);
  });

  it('contains all nine template section headers in order', () => {
    const doc = initEmptyKnowledgeDoc();
    let lastIdx = -1;
    for (const title of TEMPLATE_TITLES) {
      const idx = doc.indexOf(`## ${title}`);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it('contains exactly nine ## headers (no extras)', () => {
    const doc = initEmptyKnowledgeDoc();
    const h2Count = (doc.match(/^## /gm) ?? []).length;
    expect(h2Count).toBe(9);
  });

  it('has no ### subsection headers', () => {
    const doc = initEmptyKnowledgeDoc();
    expect(doc).not.toMatch(/^### /m);
  });
});

// ---------------------------------------------------------------------------
// splitIntoSections
// ---------------------------------------------------------------------------

describe('splitIntoSections', () => {
  it('parses a canonical empty doc into exactly nine sections', () => {
    const sections = splitIntoSections(initEmptyKnowledgeDoc());
    expect(sections).toHaveLength(9);
  });

  it('maps template titles to the correct keys', () => {
    const sections = splitIntoSections(initEmptyKnowledgeDoc());
    for (let i = 0; i < KNOWLEDGE_DOC_TEMPLATE_SECTIONS.length; i++) {
      expect(sections[i].key).toBe(KNOWLEDGE_DOC_TEMPLATE_SECTIONS[i].key);
      expect(sections[i].title).toBe(KNOWLEDGE_DOC_TEMPLATE_SECTIONS[i].title);
    }
  });

  it('extracts body content correctly', () => {
    const doc = makeDoc({ problemStatement: 'DB is slow' });
    const sections = splitIntoSections(doc);
    const ps = sections.find(s => s.key === 'problemStatement')!;
    expect(ps.content).toBe('DB is slow');
  });

  it('strips leading/trailing blank lines from section content but preserves inner horizontal whitespace', () => {
    // flushBufferTo does: buffer.join('\n').replace(/^\n+|\n+$/g, '')
    // That strips leading/trailing newlines only — not spaces on content lines.
    // This is intentional: markdown indentation is meaningful content.
    const rawDoc = '## Problem Statement\n\n\nDB is slow\n\n## Environment\n\n';
    const sections = splitIntoSections(rawDoc);
    const ps = sections.find(s => s.key === 'problemStatement')!;
    expect(ps.content).toBe('DB is slow');
  });

  it('preserves indentation on content lines (horizontal whitespace is NOT stripped)', () => {
    const rawDoc = '## Problem Statement\n\n   indented line\n\n## Environment\n\n';
    const sections = splitIntoSections(rawDoc);
    const ps = sections.find(s => s.key === 'problemStatement')!;
    // Leading spaces on the content line are preserved — not stripped
    expect(ps.content).toBe('   indented line');
  });

  it('parses subsections under Evidence into subsections array', () => {
    const doc =
      '## Evidence\n\n### Slow Query\n\nSELECT * FROM foo\n\n### Blocking\n\ndeadlock found\n\n## Hypotheses\n\n';
    const sections = splitIntoSections(doc);
    const evidence = sections.find(s => s.key === 'evidence')!;
    expect(evidence.subsections).toHaveLength(2);
    expect(evidence.subsections[0].key).toBe('evidence.slow-query');
    expect(evidence.subsections[0].title).toBe('Slow Query');
    expect(evidence.subsections[0].content).toBe('SELECT * FROM foo');
    expect(evidence.subsections[1].key).toBe('evidence.blocking');
    expect(evidence.subsections[1].content).toBe('deadlock found');
  });

  it('parses subsections under Hypotheses and Open Questions', () => {
    for (const parentKey of ['hypotheses', 'openQuestions'] as const) {
      const parentTitle = KNOWLEDGE_DOC_TEMPLATE_SECTIONS.find(s => s.key === parentKey)!.title;
      const doc = `## ${parentTitle}\n\n### My Sub\n\nsome text\n\n`;
      const sections = splitIntoSections(doc);
      const parent = sections.find(s => s.key === parentKey)!;
      expect(parent.subsections).toHaveLength(1);
      expect(parent.subsections[0].key).toBe(`${parentKey}.my-sub`);
    }
  });

  it('accepts out-of-order sections (returns them in parse order)', () => {
    const doc = '## Root Cause\n\nmystery\n\n## Problem Statement\n\nbad thing\n\n';
    const sections = splitIntoSections(doc);
    expect(sections[0].key).toBe('rootCause');
    expect(sections[1].key).toBe('problemStatement');
  });

  it('assigns a slugified key to unknown ## headings', () => {
    const doc = '## Custom Section\n\nsome content\n\n';
    const sections = splitIntoSections(doc);
    expect(sections[0].key).toBe('custom-section');
    expect(sections[0].content).toBe('some content');
  });

  it('handles CRLF line endings gracefully', () => {
    const doc = '## Problem Statement\r\n\r\nCRLF content\r\n\r\n## Environment\r\n\r\n';
    const sections = splitIntoSections(doc);
    const ps = sections.find(s => s.key === 'problemStatement')!;
    expect(ps.content).toBe('CRLF content');
  });

  it('returns empty array for empty string', () => {
    expect(splitIntoSections('')).toHaveLength(0);
  });

  it('does NOT treat ### headers under non-subsection parents as top-level sections', () => {
    // Environment does not allow subsections per SUBSECTION_PARENTS.
    // The parser still creates a subsection structurally — it doesn't enforce
    // the parent whitelist (that's enforced by addSubsection at write time).
    // This test documents that behavior.
    const doc = '## Environment\n\n### My Sub\n\nsome text\n\n';
    const sections = splitIntoSections(doc);
    const env = sections.find(s => s.key === 'environment')!;
    // Parser creates the subsection node regardless of parent whitelist
    expect(env.subsections).toHaveLength(1);
    // But it is NOT a top-level section
    expect(sections.some(s => s.key === 'my-sub')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// composeSections
// ---------------------------------------------------------------------------

describe('composeSections', () => {
  it('serializes sections back to markdown ending with newline', () => {
    const sections = splitIntoSections(initEmptyKnowledgeDoc());
    const composed = composeSections(sections);
    expect(composed.endsWith('\n')).toBe(true);
  });

  it('produces nine ## headers for full section set', () => {
    const sections = splitIntoSections(initEmptyKnowledgeDoc());
    const composed = composeSections(sections);
    const h2Count = (composed.match(/^## /gm) ?? []).length;
    expect(h2Count).toBe(9);
  });

  it('re-orders out-of-order sections into template order', () => {
    const sections = splitIntoSections(
      '## Root Cause\n\nmystery\n\n## Problem Statement\n\nbad thing\n\n',
    );
    const composed = composeSections(sections);
    const psIdx = composed.indexOf('## Problem Statement');
    const rcIdx = composed.indexOf('## Root Cause');
    expect(psIdx).toBeLessThan(rcIdx);
  });

  it('fills in missing template sections as empty headers', () => {
    // Only provide one section; composeSections must add the other eight.
    const sections: KdSection[] = [
      { key: 'problemStatement', title: 'Problem Statement', content: 'hello', subsections: [] },
    ];
    const composed = composeSections(sections);
    const h2Count = (composed.match(/^## /gm) ?? []).length;
    expect(h2Count).toBe(9);
  });

  it('appends unknown sections after the nine canonical ones', () => {
    const sections: KdSection[] = [
      { key: 'custom-section', title: 'Custom Section', content: 'extra', subsections: [] },
      { key: 'problemStatement', title: 'Problem Statement', content: 'hi', subsections: [] },
    ];
    const composed = composeSections(sections);
    const psIdx = composed.indexOf('## Problem Statement');
    const customIdx = composed.indexOf('## Custom Section');
    expect(customIdx).toBeGreaterThan(psIdx);
  });

  it('includes subsections as ### headers', () => {
    const sections: KdSection[] = [
      {
        key: 'evidence',
        title: 'Evidence',
        content: '',
        subsections: [
          { key: 'evidence.slow-query', title: 'Slow Query', content: 'plan here', subsections: [] },
        ],
      },
    ];
    const composed = composeSections(sections);
    expect(composed).toContain('### Slow Query');
    expect(composed).toContain('plan here');
  });

  it('does not include empty body lines for sections with no content', () => {
    const sections: KdSection[] = [
      { key: 'problemStatement', title: 'Problem Statement', content: '', subsections: [] },
    ];
    const composed = composeSections(sections);
    // The ## header should not be immediately followed by non-blank body text
    // (there may be blank lines but no content line).
    const afterHeader = composed.split('## Problem Statement')[1];
    const lines = afterHeader.split('\n').map(l => l.trim()).filter(Boolean);
    // First non-blank content should be the next ## header
    expect(lines[0]).toMatch(/^## /);
  });
});

// ---------------------------------------------------------------------------
// Parse / compose roundtrip
// ---------------------------------------------------------------------------

describe('parse/compose roundtrip', () => {
  it('composeSections(splitIntoSections(doc)) is stable for the empty skeleton', () => {
    const skeleton = initEmptyKnowledgeDoc();
    const roundtripped = composeSections(splitIntoSections(skeleton));
    // Both should contain the same headers — exact whitespace may differ.
    for (const title of TEMPLATE_TITLES) {
      expect(roundtripped).toContain(`## ${title}`);
    }
    expect((roundtripped.match(/^## /gm) ?? []).length).toBe(9);
  });

  it('section content survives a roundtrip', () => {
    const doc = makeDoc({
      problemStatement: 'Query is slow',
      environment: 'Azure SQL MI, dev environment',
      rootCause: 'Missing index on Orders.CustomerId',
    });
    const sections = splitIntoSections(doc);
    const recomposed = composeSections(sections);
    const resplit = splitIntoSections(recomposed);

    expect(resplit.find(s => s.key === 'problemStatement')!.content).toBe('Query is slow');
    expect(resplit.find(s => s.key === 'environment')!.content).toBe(
      'Azure SQL MI, dev environment',
    );
    expect(resplit.find(s => s.key === 'rootCause')!.content).toBe(
      'Missing index on Orders.CustomerId',
    );
  });

  it('subsections survive a roundtrip', () => {
    const docWithSub =
      '## Problem Statement\n\n## Environment\n\n## Evidence\n\n### Slow Query\n\nSELECT *\n\n## Hypotheses\n\n## Root Cause\n\n## Recommended Fix\n\n## Risks\n\n## Open Questions\n\n## Run Log\n\n';
    const sections = splitIntoSections(docWithSub);
    const composed = composeSections(sections);
    const resplit = splitIntoSections(composed);
    const evidence = resplit.find(s => s.key === 'evidence')!;
    expect(evidence.subsections).toHaveLength(1);
    expect(evidence.subsections[0].content).toBe('SELECT *');
  });
});

// ---------------------------------------------------------------------------
// readSection
// ---------------------------------------------------------------------------

describe('readSection', () => {
  const doc = makeDoc({
    problemStatement: 'Query timeout on Orders',
    environment: 'Azure SQL MI prod',
  });

  it('returns correct content for a top-level key', () => {
    const result = readSection(doc, null, 'problemStatement');
    expect(result.content).toBe('Query timeout on Orders');
    expect(result.length).toBe('Query timeout on Orders'.length);
  });

  it('returns empty content for a section that exists but has no body', () => {
    const result = readSection(doc, null, 'rootCause');
    expect(result.content).toBe('');
    expect(result.length).toBe(0);
  });

  it('returns empty content for an unknown top-level key', () => {
    const result = readSection(doc, null, 'nonexistentSection');
    expect(result.content).toBe('');
    expect(result.length).toBe(0);
  });

  it('returns correct content for a dotted subsection key', () => {
    const docWithSub =
      '## Evidence\n\n### Slow Query\n\nSELECT * FROM foo\n\n## Problem Statement\n\n## Environment\n\n## Hypotheses\n\n## Root Cause\n\n## Recommended Fix\n\n## Risks\n\n## Open Questions\n\n## Run Log\n\n';
    const result = readSection(docWithSub, null, 'evidence.slow-query');
    expect(result.content).toBe('SELECT * FROM foo');
  });

  it('returns empty content for a dotted key whose parent does not exist', () => {
    const result = readSection(doc, null, 'nonexistent.child');
    expect(result.content).toBe('');
  });

  it('returns empty content for a dotted key whose child does not exist', () => {
    const result = readSection(doc, null, 'evidence.missing-child');
    expect(result.content).toBe('');
  });

  it('returns empty content when knowledgeDoc is null', () => {
    const result = readSection(null, null, 'problemStatement');
    expect(result.content).toBe('');
    expect(result.length).toBe(0);
    expect(result.lastUpdatedAt).toBeNull();
  });

  it('prefers sidecar metadata for lastUpdatedAt', () => {
    const meta = { problemStatement: { updatedAt: '2024-01-01T00:00:00.000Z', length: 5 } };
    const result = readSection(doc, meta, 'problemStatement');
    expect(result.lastUpdatedAt).toBe('2024-01-01T00:00:00.000Z');
  });

  it('returns null lastUpdatedAt when no sidecar entry exists', () => {
    const result = readSection(doc, null, 'environment');
    expect(result.lastUpdatedAt).toBeNull();
  });

  it('dotted key under a non-subsection-permitting parent (e.g. environment.foo) returns empty', () => {
    // environment is not in SUBSECTION_PARENTS, but the parser won't have
    // created such a subsection from a canonically written doc.
    const result = readSection(doc, null, 'environment.foo');
    expect(result.content).toBe('');
  });
});

// ---------------------------------------------------------------------------
// buildToc
// ---------------------------------------------------------------------------

describe('buildToc', () => {
  it('always returns exactly nine top-level entries for the empty skeleton', () => {
    const toc = buildToc(initEmptyKnowledgeDoc(), null);
    expect(toc).toHaveLength(9);
  });

  it('returns nine entries even when knowledgeDoc is null', () => {
    const toc = buildToc(null, null);
    expect(toc).toHaveLength(9);
  });

  it('entries are in template order', () => {
    const toc = buildToc(initEmptyKnowledgeDoc(), null);
    for (let i = 0; i < TEMPLATE_KEYS.length; i++) {
      expect(toc[i].sectionKey).toBe(TEMPLATE_KEYS[i]);
    }
  });

  it('reports correct length from parsed content when no sidecar', () => {
    const doc = makeDoc({ problemStatement: 'hello' });
    const toc = buildToc(doc, null);
    const ps = toc.find(e => e.sectionKey === 'problemStatement')!;
    expect(ps.length).toBe('hello'.length);
  });

  it('prefers sidecar length over parsed content length', () => {
    const doc = makeDoc({ problemStatement: 'hello' });
    const meta = { problemStatement: { updatedAt: '2024-01-01T00:00:00.000Z', length: 999 } };
    const toc = buildToc(doc, meta);
    const ps = toc.find(e => e.sectionKey === 'problemStatement')!;
    expect(ps.length).toBe(999);
  });

  it('prefers sidecar lastUpdatedAt', () => {
    const doc = makeDoc({ problemStatement: 'hello' });
    const meta = { problemStatement: { updatedAt: '2025-06-01T12:00:00.000Z', length: 5 } };
    const toc = buildToc(doc, meta);
    const ps = toc.find(e => e.sectionKey === 'problemStatement')!;
    expect(ps.lastUpdatedAt).toBe('2025-06-01T12:00:00.000Z');
  });

  it('includes updatedByRunId when present in sidecar', () => {
    const doc = makeDoc({ problemStatement: 'hi' });
    const meta = {
      problemStatement: {
        updatedAt: '2025-01-01T00:00:00.000Z',
        length: 2,
        updatedByRunId: 'run-abc',
      },
    };
    const toc = buildToc(doc, meta);
    const ps = toc.find(e => e.sectionKey === 'problemStatement')!;
    expect(ps.updatedByRunId).toBe('run-abc');
  });

  it('reports zero length and null lastUpdatedAt for empty sections', () => {
    const toc = buildToc(initEmptyKnowledgeDoc(), null);
    for (const entry of toc) {
      expect(entry.length).toBe(0);
      expect(entry.lastUpdatedAt).toBeNull();
    }
  });

  it('includes subsections in the evidence entry', () => {
    const doc =
      '## Problem Statement\n\n## Environment\n\n## Evidence\n\n### Slow Query\n\nSELECT *\n\n## Hypotheses\n\n## Root Cause\n\n## Recommended Fix\n\n## Risks\n\n## Open Questions\n\n## Run Log\n\n';
    const toc = buildToc(doc, null);
    const evidence = toc.find(e => e.sectionKey === 'evidence')!;
    expect(evidence.subsections).toBeDefined();
    expect(evidence.subsections!).toHaveLength(1);
    expect(evidence.subsections![0].sectionKey).toBe('evidence.slow-query');
    expect(evidence.subsections![0].title).toBe('Slow Query');
  });

  it('does not include subsections array when section has none', () => {
    const toc = buildToc(initEmptyKnowledgeDoc(), null);
    const ps = toc.find(e => e.sectionKey === 'problemStatement')!;
    expect(ps.subsections).toBeUndefined();
  });

  it('gracefully handles non-object sidecar values', () => {
    // null, string, number — should not throw, should behave as if meta is empty
    expect(() => buildToc(initEmptyKnowledgeDoc(), null)).not.toThrow();
    expect(() => buildToc(initEmptyKnowledgeDoc(), 'bad')).not.toThrow();
    expect(() => buildToc(initEmptyKnowledgeDoc(), 42)).not.toThrow();
    expect(() => buildToc(initEmptyKnowledgeDoc(), [])).not.toThrow();

    const toc = buildToc(initEmptyKnowledgeDoc(), 'bad');
    expect(toc).toHaveLength(9);
  });
});

// ---------------------------------------------------------------------------
// 10,000-char cap — composeSections does not truncate (cap enforced at write time)
// ---------------------------------------------------------------------------

describe('section content cap context', () => {
  it('KNOWLEDGE_DOC_SECTION_MAX_CHARS is 10000', () => {
    expect(KNOWLEDGE_DOC_SECTION_MAX_CHARS).toBe(10000);
  });

  it('splitIntoSections and composeSections do NOT enforce the cap (pure parsing)', () => {
    // The cap is enforced by updateSection/addSubsection (DB write path).
    // The parsing layer is cap-agnostic so downstream reads of legacy or
    // out-of-band writes don't silently truncate.
    const bigContent = 'x'.repeat(15000);
    const sections: KdSection[] = [
      { key: 'problemStatement', title: 'Problem Statement', content: bigContent, subsections: [] },
    ];
    const composed = composeSections(sections);
    const resplit = splitIntoSections(composed);
    expect(resplit.find(s => s.key === 'problemStatement')!.content).toHaveLength(15000);
  });
});

// ---------------------------------------------------------------------------
// SUBSECTION_PARENTS whitelist
// ---------------------------------------------------------------------------

describe('SUBSECTION_PARENTS', () => {
  it('contains exactly evidence, hypotheses, openQuestions', () => {
    expect(SUBSECTION_PARENTS.has('evidence')).toBe(true);
    expect(SUBSECTION_PARENTS.has('hypotheses')).toBe(true);
    expect(SUBSECTION_PARENTS.has('openQuestions')).toBe(true);
    expect(SUBSECTION_PARENTS.size).toBe(3);
  });

  it('does not include non-subsection sections', () => {
    for (const key of [
      'problemStatement',
      'environment',
      'rootCause',
      'recommendedFix',
      'risks',
      'runLog',
    ] as KnowledgeDocSectionKey[]) {
      expect(SUBSECTION_PARENTS.has(key)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Malformed / edge-case markdown inputs
// ---------------------------------------------------------------------------

describe('malformed markdown inputs', () => {
  it('parse of markdown missing required sections fills in empty placeholders via composeSections', () => {
    // splitIntoSections only returns sections present in the markdown.
    // composeSections fills the missing ones when serializing.
    const partialDoc = '## Problem Statement\n\nbad thing happened\n\n';
    const sections = splitIntoSections(partialDoc);
    // Only one section parsed
    expect(sections).toHaveLength(1);
    // Composing adds the other eight empty sections
    const recomposed = composeSections(sections);
    expect((recomposed.match(/^## /gm) ?? []).length).toBe(9);
  });

  it('multiple consecutive ## headers (no content between) produce empty section bodies', () => {
    const doc = '## Problem Statement\n## Environment\n## Evidence\n\n';
    const sections = splitIntoSections(doc);
    expect(sections).toHaveLength(3);
    sections.forEach(s => expect(s.content).toBe(''));
  });

  it('doc with no ## headers at all returns empty array', () => {
    expect(splitIntoSections('just some text\n')).toHaveLength(0);
  });

  it('### before any ## header is ignored (no currentTop)', () => {
    // The parser ignores h3 when there is no currentTop — buffer goes nowhere.
    const doc = '### Orphan Sub\n\norphan content\n\n## Evidence\n\nreal content\n\n';
    const sections = splitIntoSections(doc);
    const evidence = sections.find(s => s.key === 'evidence');
    expect(evidence).toBeDefined();
    expect(evidence!.subsections).toHaveLength(0);
    // The orphan content is NOT captured in any section
  });

  it('duplicate ## headers of the same title creates two separate section objects', () => {
    const doc =
      '## Problem Statement\n\nfirst\n\n## Problem Statement\n\nsecond\n\n';
    const sections = splitIntoSections(doc);
    expect(sections).toHaveLength(2);
    // The composeSections deduplication behavior: byKey map takes the LAST write.
    // So the second 'problemStatement' wins.
    const composed = composeSections(sections);
    const resplit = splitIntoSections(composed);
    const ps = resplit.find(s => s.key === 'problemStatement')!;
    // The last-seen section wins in the byKey Map
    expect(ps.content).toBe('second');
  });
});

// ---------------------------------------------------------------------------
// KnowledgeDocError is exported and usable
// ---------------------------------------------------------------------------
describe('KnowledgeDocError', () => {
  it('is constructable with message and code', async () => {
    const { KnowledgeDocError } = await import('./knowledge-doc.js');
    const err = new KnowledgeDocError('test message', 'TEST_CODE');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('KnowledgeDocError');
    expect(err.message).toBe('test message');
    expect(err.code).toBe('TEST_CODE');
  });
});
