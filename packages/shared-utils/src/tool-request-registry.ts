import type { PrismaClient } from '@bronco/db';
import { Prisma } from '@bronco/db';
import { ToolRequestRationaleSource } from '@bronco/shared-types';

export interface RegisterToolRequestInput {
  clientId: string;
  ticketId?: string;
  /** Raw snake_case tool name proposed by the agent (normalized on write). */
  requestedName: string;
  displayTitle: string;
  description: string;
  rationale: string;
  suggestedInputs?: Record<string, unknown>;
  exampleUsage?: string;
  source: ToolRequestRationaleSource;
}

export interface RegisterToolRequestResult {
  toolRequestId: string;
  /** True when this call created a new ToolRequest row (vs. appending to an existing one). */
  isNew: boolean;
  normalizedName: string;
}

/**
 * Normalize an agent-proposed tool name to lowercase snake_case with
 * only [a-z0-9_] characters. Throws if the result would be <3 or >100 chars.
 */
export function normalizeRequestedName(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
  if (normalized.length < 3 || normalized.length > 100) {
    throw new Error(
      `Invalid requestedName: normalized form must be 3–100 chars of [a-z0-9_], got "${normalized}"`,
    );
  }
  return normalized;
}

/**
 * Upsert a ToolRequest by (clientId, normalizedName) and always append a new
 * rationale row. When a matching ToolRequest already exists we only bump its
 * requestCount — core fields (displayTitle, description, suggestedInputs,
 * exampleUsage) stay as originally recorded so operator edits aren't clobbered.
 */
export async function registerToolRequest(
  db: PrismaClient,
  input: RegisterToolRequestInput,
): Promise<RegisterToolRequestResult> {
  const normalizedName = normalizeRequestedName(input.requestedName);
  return db.$transaction(async (tx) => {
    const existing = await tx.toolRequest.findUnique({
      where: {
        clientId_requestedName: { clientId: input.clientId, requestedName: normalizedName },
      },
    });
    let rowId: string;
    let isNew = false;
    if (!existing) {
      const created = await tx.toolRequest.create({
        data: {
          clientId: input.clientId,
          firstTicketId: input.ticketId,
          requestedName: normalizedName,
          displayTitle: input.displayTitle,
          description: input.description,
          suggestedInputs: (input.suggestedInputs ?? undefined) as Prisma.InputJsonValue | undefined,
          exampleUsage: input.exampleUsage,
        },
      });
      rowId = created.id;
      isNew = true;
    } else {
      const updated = await tx.toolRequest.update({
        where: { id: existing.id },
        data: { requestCount: { increment: 1 } },
      });
      rowId = updated.id;
    }
    await tx.toolRequestRationale.create({
      data: {
        toolRequestId: rowId,
        ticketId: input.ticketId,
        rationale: input.rationale,
        source: input.source,
      },
    });
    return { toolRequestId: rowId, isNew, normalizedName };
  });
}
