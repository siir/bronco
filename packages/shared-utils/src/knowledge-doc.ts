import type { PrismaClient } from '@bronco/db';
import {
  KNOWLEDGE_DOC_SECTION_MAX_CHARS,
  KNOWLEDGE_DOC_TEMPLATE_SECTIONS,
  KnowledgeDocSectionKey,
  KnowledgeDocUpdateMode,
  SUBSECTION_PARENTS,
  type KnowledgeDocSectionMeta,
  type KnowledgeDocSectionMetaEntry,
  type KnowledgeDocTocEntry,
  type KnowledgeDocUpdateMode as KnowledgeDocUpdateModeType,
} from '@bronco/shared-types';
import { withTicketLock, type PrismaTx } from './advisory-lock.js';

/**
 * Utilities for reading and mutating the templated knowledge document stored
 * on `Ticket.knowledgeDoc`. Shared between the copilot-api REST handlers, the
 * mcp-platform `kd_*` tool handlers, and the ticket-analyzer worker so every
 * writer enforces the same template + section cap + advisory-lock discipline.
 *
 * On-disk format: markdown with `## <title>` headers for top-level sections
 * (canonical set + order from `KNOWLEDGE_DOC_TEMPLATE_SECTIONS`) and `### <title>`
 * headers for subsections. Subsections are only legal under the three parents
 * in `SUBSECTION_PARENTS` (Evidence, Hypotheses, Open Questions).
 *
 * `knowledgeDocSectionMeta` is a cheap sidecar for TOC lookups without
 * re-parsing — updated atomically alongside `knowledgeDoc` on every write.
 */

export interface KdSection {
  key: string;
  title: string;
  /** Section body (content between this header and the next same-or-higher-level header). */
  content: string;
  subsections: KdSection[];
}

export interface KdReadSectionResult {
  content: string;
  lastUpdatedAt: string | null;
  length: number;
}

export class KnowledgeDocError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'KnowledgeDocError';
  }
}

const TITLE_BY_KEY = new Map<string, string>(
  KNOWLEDGE_DOC_TEMPLATE_SECTIONS.map(s => [s.key, s.title]),
);
const TOP_LEVEL_KEYS = new Set<string>(KNOWLEDGE_DOC_TEMPLATE_SECTIONS.map(s => s.key));

/** Build the empty skeleton doc with every template section header present. */
export function initEmptyKnowledgeDoc(): string {
  const parts: string[] = [];
  for (const { title } of KNOWLEDGE_DOC_TEMPLATE_SECTIONS) {
    parts.push(`## ${title}`);
    parts.push('');
    parts.push('');
  }
  return parts.join('\n').trimEnd() + '\n';
}

/** Generate a deterministic slug (lowercase, alnum + dashes, run-collapsed). */
export function slugify(title: string): string {
  const trimmed = title.trim().toLowerCase();
  const slug = trimmed.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'section';
}

function keyForTitle(title: string): string {
  for (const s of KNOWLEDGE_DOC_TEMPLATE_SECTIONS) {
    if (s.title === title) return s.key;
  }
  // Unknown title — slugify so TOC fallback doesn't blow up on corrupted docs.
  return slugify(title);
}

export function splitIntoSections(doc: string): KdSection[] {
  const lines = doc.split('\n');
  const topLevel: KdSection[] = [];
  let currentTop: KdSection | null = null;
  let currentSub: KdSection | null = null;
  let buffer: string[] = [];

  const flushBufferTo = (target: KdSection | null) => {
    if (!target) {
      buffer = [];
      return;
    }
    target.content = buffer.join('\n').replace(/^\n+|\n+$/g, '');
    buffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const h2Match = /^##\s+(.+?)\s*$/.exec(line);
    const h3Match = /^###\s+(.+?)\s*$/.exec(line);

    if (h2Match) {
      if (currentSub) {
        flushBufferTo(currentSub);
        currentSub = null;
      } else if (currentTop) {
        flushBufferTo(currentTop);
      }
      const title = h2Match[1].trim();
      const key = keyForTitle(title);
      currentTop = { key, title, content: '', subsections: [] };
      topLevel.push(currentTop);
      continue;
    }

    if (h3Match && currentTop) {
      if (currentSub) {
        flushBufferTo(currentSub);
      } else {
        flushBufferTo(currentTop);
      }
      const title = h3Match[1].trim();
      const parentKey = currentTop.key;
      // Dedup slug so two subsections with the same title round-trip to
      // distinct keys — matches the suffix scheme in addSubsection.
      const baseSlug = slugify(title);
      const existingSlugs = new Set(
        currentTop.subsections.map(s => {
          const idx = s.key.indexOf('.');
          return idx >= 0 ? s.key.slice(idx + 1) : s.key;
        }),
      );
      let slug = baseSlug;
      let suffix = 2;
      while (existingSlugs.has(slug)) {
        slug = `${baseSlug}-${suffix++}`;
      }
      const subKey = `${parentKey}.${slug}`;
      currentSub = { key: subKey, title, content: '', subsections: [] };
      currentTop.subsections.push(currentSub);
      continue;
    }

    buffer.push(line);
  }

  if (currentSub) flushBufferTo(currentSub);
  else if (currentTop) flushBufferTo(currentTop);

  return topLevel;
}

/** Serialize a section tree back into canonical markdown (template-ordered). */
export function composeSections(sections: KdSection[]): string {
  const orderedKeys: string[] = KNOWLEDGE_DOC_TEMPLATE_SECTIONS.map(s => s.key);
  const orderedKeySet = new Set<string>(orderedKeys);
  const byKey = new Map<string, KdSection>();
  for (const s of sections) byKey.set(s.key, s);

  const ordered: KdSection[] = [];
  for (const key of orderedKeys) {
    const existing = byKey.get(key);
    if (existing) ordered.push(existing);
    else {
      const title = TITLE_BY_KEY.get(key) ?? key;
      ordered.push({ key, title, content: '', subsections: [] });
    }
  }
  for (const s of sections) {
    if (!orderedKeySet.has(s.key)) ordered.push(s);
  }

  const parts: string[] = [];
  for (const sec of ordered) {
    parts.push(`## ${sec.title}`);
    const body = sec.content.trim();
    if (body) {
      parts.push('');
      parts.push(body);
    }
    for (const sub of sec.subsections) {
      parts.push('');
      parts.push(`### ${sub.title}`);
      const subBody = sub.content.trim();
      if (subBody) {
        parts.push('');
        parts.push(subBody);
      }
    }
    parts.push('');
  }
  return parts.join('\n').trimEnd() + '\n';
}

function isKnowledgeDocSectionMeta(value: unknown): value is KnowledgeDocSectionMeta {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readMeta(raw: unknown): KnowledgeDocSectionMeta {
  return isKnowledgeDocSectionMeta(raw) ? { ...(raw as KnowledgeDocSectionMeta) } : {};
}

/**
 * Build a TOC for the knowledge doc.
 *
 * Always parses `knowledgeDoc` to discover subsection titles/keys — the
 * sidecar metadata only records per-key `length` / `updatedAt` / `updatedByRunId`,
 * not the titles or the subsection tree shape. We prefer the sidecar for
 * length + timestamps when both are available, so the TOC stays accurate
 * even before the next kd_* write refreshes the parsed body.
 */
export function buildToc(
  knowledgeDoc: string | null,
  sectionMeta: unknown,
): KnowledgeDocTocEntry[] {
  const meta = readMeta(sectionMeta);
  const sections = knowledgeDoc ? splitIntoSections(knowledgeDoc) : [];
  const byKey = new Map<string, KdSection>();
  for (const s of sections) byKey.set(s.key, s);

  const result: KnowledgeDocTocEntry[] = [];
  for (const { key, title } of KNOWLEDGE_DOC_TEMPLATE_SECTIONS) {
    const parsed = byKey.get(key);
    const metaEntry = meta[key];
    const content = parsed?.content ?? '';
    const entry: KnowledgeDocTocEntry = {
      sectionKey: key,
      title,
      length: metaEntry?.length ?? content.length,
      lastUpdatedAt: metaEntry?.updatedAt ?? null,
    };
    if (metaEntry?.updatedByRunId) entry.updatedByRunId = metaEntry.updatedByRunId;
    if (parsed && parsed.subsections.length > 0) {
      entry.subsections = parsed.subsections.map<KnowledgeDocTocEntry>(sub => {
        const subMeta = meta[sub.key];
        return {
          sectionKey: sub.key,
          title: sub.title,
          length: subMeta?.length ?? sub.content.length,
          lastUpdatedAt: subMeta?.updatedAt ?? null,
          ...(subMeta?.updatedByRunId ? { updatedByRunId: subMeta.updatedByRunId } : {}),
        };
      });
    }
    result.push(entry);
  }
  return result;
}

/**
 * Read a single section by key. Accepts both top-level and dotted subsection
 * keys. Returns empty result when the section isn't present yet.
 */
export function readSection(
  knowledgeDoc: string | null,
  sectionMeta: unknown,
  sectionKey: string,
): KdReadSectionResult {
  const meta = readMeta(sectionMeta);
  const metaEntry: KnowledgeDocSectionMetaEntry | undefined = meta[sectionKey];

  if (!knowledgeDoc) {
    return { content: '', lastUpdatedAt: metaEntry?.updatedAt ?? null, length: 0 };
  }
  const sections = splitIntoSections(knowledgeDoc);

  const dotIdx = sectionKey.indexOf('.');
  if (dotIdx === -1) {
    const top = sections.find(s => s.key === sectionKey);
    const content = top?.content ?? '';
    return { content, lastUpdatedAt: metaEntry?.updatedAt ?? null, length: content.length };
  }
  const parentKey = sectionKey.slice(0, dotIdx);
  const top = sections.find(s => s.key === parentKey);
  if (!top) return { content: '', lastUpdatedAt: metaEntry?.updatedAt ?? null, length: 0 };
  const sub = top.subsections.find(s => s.key === sectionKey);
  const content = sub?.content ?? '';
  return { content, lastUpdatedAt: metaEntry?.updatedAt ?? null, length: content.length };
}

async function loadTicketForWrite(
  tx: PrismaTx,
  ticketId: string,
): Promise<{ id: string; knowledgeDoc: string | null; knowledgeDocSectionMeta: unknown } | null> {
  return tx.ticket.findUnique({
    where: { id: ticketId },
    select: { id: true, knowledgeDoc: true, knowledgeDocSectionMeta: true },
  });
}

/** Update a top-level section. Subsection keys are rejected. */
export async function updateSection(
  db: PrismaClient,
  ticketId: string,
  sectionKey: string,
  content: string,
  mode: KnowledgeDocUpdateModeType,
  opts?: { updatedByRunId?: string },
): Promise<{ content: string; length: number; updatedAt: string }> {
  if (!TOP_LEVEL_KEYS.has(sectionKey)) {
    if (sectionKey.includes('.')) {
      throw new KnowledgeDocError(
        `ERROR: subsection keys are not supported here — use kd_add_subsection under ${[...SUBSECTION_PARENTS].join(' / ')}`,
        'INVALID_SECTION_KEY',
      );
    }
    throw new KnowledgeDocError(
      `ERROR: sectionKey "${sectionKey}" is not part of the template; valid keys: ${[...TOP_LEVEL_KEYS].join(', ')}`,
      'INVALID_SECTION_KEY',
    );
  }

  return withTicketLock(db, ticketId, async (tx) => {
    const ticket = await loadTicketForWrite(tx, ticketId);
    if (!ticket) throw new KnowledgeDocError('ERROR: ticket not found', 'TICKET_NOT_FOUND');

    const existingDoc = ticket.knowledgeDoc ?? initEmptyKnowledgeDoc();
    const sections = splitIntoSections(existingDoc);
    let target = sections.find(s => s.key === sectionKey);
    if (!target) {
      const title = TITLE_BY_KEY.get(sectionKey) ?? sectionKey;
      target = { key: sectionKey, title, content: '', subsections: [] };
      sections.push(target);
    }

    const nextContent = mode === KnowledgeDocUpdateMode.APPEND && target.content.trim().length > 0
      ? `${target.content.trim()}\n\n${content.trim()}`
      : content.trim();

    if (nextContent.length > KNOWLEDGE_DOC_SECTION_MAX_CHARS) {
      throw new KnowledgeDocError(
        `ERROR: section too long (${nextContent.length} chars), consider kd_add_subsection under Evidence / Hypotheses / Open Questions`,
        'SECTION_TOO_LONG',
      );
    }

    target.content = nextContent;

    const newDoc = composeSections(sections);
    const meta = readMeta(ticket.knowledgeDocSectionMeta);
    const updatedAt = new Date().toISOString();
    const metaEntry: KnowledgeDocSectionMetaEntry = {
      updatedAt,
      length: nextContent.length,
      ...(opts?.updatedByRunId ? { updatedByRunId: opts.updatedByRunId } : {}),
    };
    meta[sectionKey] = metaEntry;

    await tx.ticket.update({
      where: { id: ticketId },
      data: {
        knowledgeDoc: newDoc,
        knowledgeDocSectionMeta: meta as object,
      },
    });

    return { content: nextContent, length: nextContent.length, updatedAt };
  });
}

/** Append a subsection under one of the permitted parents. Returns the new dotted key. */
export async function addSubsection(
  db: PrismaClient,
  ticketId: string,
  parentSectionKey: string,
  title: string,
  content: string,
  opts?: { updatedByRunId?: string },
): Promise<{ sectionKey: string; title: string; content: string; length: number; updatedAt: string }> {
  if (!SUBSECTION_PARENTS.has(parentSectionKey)) {
    throw new KnowledgeDocError(
      `ERROR: subsections are only permitted under ${[...SUBSECTION_PARENTS].join(' / ')}`,
      'INVALID_PARENT',
    );
  }
  const cleanTitle = title.trim();
  if (!cleanTitle) {
    throw new KnowledgeDocError('ERROR: subsection title is required', 'INVALID_TITLE');
  }

  return withTicketLock(db, ticketId, async (tx) => {
    const ticket = await loadTicketForWrite(tx, ticketId);
    if (!ticket) throw new KnowledgeDocError('ERROR: ticket not found', 'TICKET_NOT_FOUND');

    const existingDoc = ticket.knowledgeDoc ?? initEmptyKnowledgeDoc();
    const sections = splitIntoSections(existingDoc);
    let parent = sections.find(s => s.key === parentSectionKey);
    if (!parent) {
      const parentTitle = TITLE_BY_KEY.get(parentSectionKey) ?? parentSectionKey;
      parent = { key: parentSectionKey, title: parentTitle, content: '', subsections: [] };
      sections.push(parent);
    }

    const baseSlug = slugify(cleanTitle);
    const existingSlugs = new Set(
      parent.subsections.map(s => {
        const idx = s.key.indexOf('.');
        return idx >= 0 ? s.key.slice(idx + 1) : s.key;
      }),
    );
    let slug = baseSlug;
    let suffix = 2;
    while (existingSlugs.has(slug)) {
      slug = `${baseSlug}-${suffix++}`;
    }
    const newKey = `${parentSectionKey}.${slug}`;

    const trimmedContent = content.trim();
    if (trimmedContent.length > KNOWLEDGE_DOC_SECTION_MAX_CHARS) {
      throw new KnowledgeDocError(
        `ERROR: subsection too long (${trimmedContent.length} chars), split the content into multiple subsections or trim it`,
        'SECTION_TOO_LONG',
      );
    }

    parent.subsections.push({
      key: newKey,
      title: cleanTitle,
      content: trimmedContent,
      subsections: [],
    });

    const newDoc = composeSections(sections);
    const meta = readMeta(ticket.knowledgeDocSectionMeta);
    const updatedAt = new Date().toISOString();
    const metaEntry: KnowledgeDocSectionMetaEntry = {
      updatedAt,
      length: trimmedContent.length,
      ...(opts?.updatedByRunId ? { updatedByRunId: opts.updatedByRunId } : {}),
    };
    meta[newKey] = metaEntry;
    meta[parentSectionKey] = {
      updatedAt,
      length: meta[parentSectionKey]?.length ?? parent.content.length,
      ...(opts?.updatedByRunId ? { updatedByRunId: opts.updatedByRunId } : {}),
    };

    await tx.ticket.update({
      where: { id: ticketId },
      data: {
        knowledgeDoc: newDoc,
        knowledgeDocSectionMeta: meta as object,
      },
    });

    return {
      sectionKey: newKey,
      title: cleanTitle,
      content: trimmedContent,
      length: trimmedContent.length,
      updatedAt,
    };
  });
}

/** Load the ticket's knowledge doc + sidecar. Returns null when ticket missing. */
export async function loadKnowledgeDoc(
  db: PrismaClient,
  ticketId: string,
): Promise<{ knowledgeDoc: string | null; knowledgeDocSectionMeta: unknown } | null> {
  return db.ticket.findUnique({
    where: { id: ticketId },
    select: { knowledgeDoc: true, knowledgeDocSectionMeta: true },
  });
}

/** Required top-level keys checked by the analyzer's fallback-fill pass. */
export const REQUIRED_SECTION_KEYS: ReadonlyArray<KnowledgeDocSectionKey> = [
  KnowledgeDocSectionKey.PROBLEM_STATEMENT,
  KnowledgeDocSectionKey.ROOT_CAUSE,
  KnowledgeDocSectionKey.RECOMMENDED_FIX,
];
