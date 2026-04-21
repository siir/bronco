import type { PrismaClient } from '@bronco/db';
import { Prisma } from '@bronco/db';
import { ToolRequestRationaleSource } from '@bronco/shared-types';

// Keep in sync with services/copilot-api/src/services/tool-request-registry.ts.
// Both services share behavior here; duplicated locally because mcp-platform
// can't import from copilot-api.

export interface RegisterToolRequestInput {
  clientId: string;
  ticketId?: string;
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
  isNew: boolean;
  normalizedName: string;
}

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
