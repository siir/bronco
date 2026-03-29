import type { Job, Queue } from 'bullmq';
import { type PrismaClient, Prisma } from '@bronco/db';
import { Priority } from '@bronco/shared-types';
import type { TicketCreatedJob } from '@bronco/shared-types';
import { createLogger, AppLogger, createPrismaLogWriter } from '@bronco/shared-utils';
import type { AzDoClient, AzDoWorkItem } from './client.js';
import { BOT_MARKER, type WorkflowEngine } from './workflow.js';

const logger = createLogger('azdo-processor');
export const appLog = new AppLogger('azdo-processor');

export function initProcessorLogger(db: PrismaClient): void {
  appLog.setWriter(createPrismaLogWriter(db));
}

export interface DevOpsJob {
  workItemId: number;
  /** Set for per-client integration jobs (null/undefined for global). */
  integrationId?: string;
}

// Strip HTML tags from Azure DevOps rich-text fields
function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (match, code) => {
      const cp = parseInt(code, 10);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => {
      const cp = parseInt(hex, 16);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getField<T>(wi: AzDoWorkItem, field: string): T | undefined {
  return wi.fields[field] as T | undefined;
}

/** Default maximum length for description text stored in the ticket. */
const DEFAULT_MAX_DESCRIPTION_LENGTH = 2000;

/**
 * Map Azure DevOps priority (1–4, lower=higher) to our Priority enum.
 * DevOps: 1=Critical, 2=High, 3=Medium, 4=Low
 */
function mapPriority(azdoPriority: number | undefined): Priority {
  switch (azdoPriority) {
    case 1: return Priority.CRITICAL;
    case 2: return Priority.HIGH;
    case 3: return Priority.MEDIUM;
    case 4: return Priority.LOW;
    default: return Priority.MEDIUM;
  }
}

/**
 * Extract a numeric work item ID from a relation URL.
 * URLs look like: https://dev.azure.com/{org}/{project}/_apis/wit/workItems/123
 * Also handles URLs with trailing query params, fragments, or slashes.
 */
function extractWorkItemIdFromUrl(url: string): number | null {
  const match = url.match(/\/workItems\/(\d+)(?:[/?#]|$)/i);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Build the external reference string used to link tickets to DevOps work items.
 */
export function buildExternalRef(orgUrl: string, project: string, workItemId: number): string {
  let org: string;
  try {
    const parsed = new URL(orgUrl);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (parsed.hostname === 'dev.azure.com' && segments.length > 0) {
      org = segments[0];
    } else if (parsed.hostname.endsWith('.visualstudio.com')) {
      org = parsed.hostname.split('.')[0];
    } else {
      org = segments[segments.length - 1] ?? parsed.hostname;
    }
  } catch {
    const segments = orgUrl.replace(/\/+$/, '').split('/').filter(Boolean);
    org = segments[segments.length - 1] ?? orgUrl;
  }
  return `azdo:${org}/${project}/${workItemId}`;
}

export interface ProcessorOptions {
  maxDescriptionLength?: number;
  clientShortCode?: string;
  /** Set for per-client integration jobs; null for global config. */
  integrationId?: string | null;
  /** When 'operational-task', creates OperationalTask instead of Ticket (for global/internal integration). */
  mode?: 'ticket' | 'operational-task';
  /** Optional BullMQ queue for ticket-created events — when provided, newly created tickets are enqueued for route dispatch. */
  ticketCreatedQueue?: Queue<TicketCreatedJob>;
}

export function createDevOpsProcessor(
  db: PrismaClient,
  client: AzDoClient,
  workflow: WorkflowEngine,
  orgUrl: string,
  project: string,
  assignedUser: string,
  opts?: ProcessorOptions,
) {
  const maxDescriptionLength = opts?.maxDescriptionLength ?? DEFAULT_MAX_DESCRIPTION_LENGTH;
  const clientShortCode = opts?.clientShortCode;
  const integrationId = opts?.integrationId ?? null;
  const mode = opts?.mode ?? 'ticket';
  const ticketCreatedQueue = opts?.ticketCreatedQueue;
  const entityType = mode === 'operational-task' ? 'operational_task' : 'ticket';

  /** Build a where filter for DevOpsSyncState scoped by workItemId + integrationId. */
  function syncWhere(workItemId: number) {
    return { workItemId, integrationId } as const;
  }

  /**
   * Resolve or create the Client record that DevOps tickets belong to.
   */
  async function resolveClientId(): Promise<string> {
    const shortCode = clientShortCode ?? `azdo-${project.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;

    const record = await db.client.upsert({
      where: { shortCode },
      create: {
        name: clientShortCode ? shortCode : `Azure DevOps: ${project}`,
        shortCode,
        notes: `Auto-created for Azure DevOps project ${project}`,
      },
      update: {},
      select: { id: true },
    });

    return record.id;
  }

  /**
   * Check if a work item is assigned to the configured user.
   */
  function isAssignedToUs(wi: AzDoWorkItem): boolean {
    const assignedTo = getField<{ uniqueName?: string; displayName?: string }>(
      wi,
      'System.AssignedTo',
    );
    if (!assignedTo) return false;

    const lower = assignedUser.toLowerCase();
    return (
      (assignedTo.uniqueName?.toLowerCase() === lower) ||
      (assignedTo.displayName?.toLowerCase() === lower)
    );
  }

  return async function processWorkItem(job: Job<DevOpsJob>): Promise<void> {
    const { workItemId } = job.data;

    appLog.info(`Processing work item #${workItemId}`, { workItemId });

    // Fetch full work item details (may have changed since poll)
    const wi = await client.getWorkItem(workItemId);

    const title = getField<string>(wi, 'System.Title') ?? `Work Item ${workItemId}`;
    const description = stripHtml(getField<string>(wi, 'System.Description'));
    const workItemType = getField<string>(wi, 'System.WorkItemType') ?? 'Unknown';
    const state = getField<string>(wi, 'System.State') ?? 'Unknown';
    const priority = getField<number>(wi, 'Microsoft.VSTS.Common.Priority');
    const tags = getField<string>(wi, 'System.Tags') ?? null;
    const areaPath = getField<string>(wi, 'System.AreaPath') ?? null;
    const iterationPath = getField<string>(wi, 'System.IterationPath') ?? null;
    const externalRef = buildExternalRef(orgUrl, project, workItemId);
    const assignedTo = getField<{ uniqueName?: string; displayName?: string }>(
      wi,
      'System.AssignedTo',
    );
    const actionable = isAssignedToUs(wi);

    // Check if we already have a sync state for this work item (scoped by integration)
    const existingSync = await db.devOpsSyncState.findFirst({
      where: syncWhere(workItemId),
    });

    if (!existingSync) {
      // --- New work item ---
      let entityId: string;

      if (mode === 'operational-task') {
        // Create an operational task (internal/global integration)
        const task = await db.operationalTask.create({
          data: {
            subject: `[${workItemType}] ${title}`,
            description: description.slice(0, maxDescriptionLength) || null,
            source: 'AZURE_DEVOPS',
            priority: mapPriority(priority),
            externalRef,
          },
        });
        entityId = task.id;

        await db.devOpsSyncState.create({
          data: {
            operationalTaskId: task.id,
            workItemId,
            integrationId,
            revision: wi.rev,
            workItemType,
            isActionable: actionable,
            workflowState: 'idle',
          },
        });

        await db.operationalTaskEvent.create({
          data: {
            taskId: task.id,
            eventType: 'SYSTEM_NOTE',
            content: `Imported from Azure DevOps ${workItemType} #${workItemId}`,
            metadata: {
              workItemId, workItemType, state,
              assignedTo: assignedTo?.displayName ?? null,
              tags, areaPath, iterationPath,
              url: client.getWorkItemUrl(workItemId),
            },
            actor: 'system:devops-worker',
          },
        });

        const linkedContext = await fetchLinkedWorkItemContext(wi);
        if (linkedContext) {
          await db.operationalTaskEvent.create({
            data: {
              taskId: task.id,
              eventType: 'SYSTEM_NOTE',
              content: linkedContext,
              actor: 'system:devops-worker',
            },
          });
        }

        appLog.info(`Created operational task from work item #${workItemId}: actionable=${actionable}`, { taskId: task.id, workItemId, actionable, title, workItemType }, task.id, entityType);
      } else {
        // Create a ticket (per-client integration)
        const clientId = await resolveClientId();
        let ticket: { id: string };
        for (let attempt = 0; attempt <= 3; attempt++) {
          const lastAzdoTicket = await db.ticket.findFirst({
            where: { clientId, ticketNumber: { gt: 0 } },
            orderBy: { ticketNumber: 'desc' },
            select: { ticketNumber: true },
          });
          const azdoTicketNumber = (lastAzdoTicket?.ticketNumber ?? 0) + 1;

          try {
            ticket = await db.ticket.create({
              data: {
                clientId,
                subject: `[${workItemType}] ${title}`,
                description: description.slice(0, maxDescriptionLength) || null,
                source: 'AZURE_DEVOPS',
                priority: mapPriority(priority),
                externalRef,
                ticketNumber: azdoTicketNumber,
              },
            });
            break;
          } catch (err) {
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && attempt < 3) {
              logger.warn({ attempt, workItemId }, 'Ticket number conflict — retrying');
              continue;
            }
            throw err;
          }
        }
        ticket = ticket!;
        entityId = ticket.id;

        await db.devOpsSyncState.create({
          data: {
            ticketId: ticket.id,
            workItemId,
            integrationId,
            revision: wi.rev,
            workItemType,
            isActionable: actionable,
            workflowState: 'idle',
          },
        });

        await db.ticketEvent.create({
          data: {
            ticketId: ticket.id,
            eventType: 'SYSTEM_NOTE',
            content: `Imported from Azure DevOps ${workItemType} #${workItemId}`,
            metadata: {
              workItemId, workItemType, state,
              assignedTo: assignedTo?.displayName ?? null,
              tags, areaPath, iterationPath,
              url: client.getWorkItemUrl(workItemId),
            },
            actor: 'system:devops-worker',
          },
        });

        const linkedContext = await fetchLinkedWorkItemContext(wi);
        if (linkedContext) {
          await db.ticketEvent.create({
            data: {
              ticketId: ticket.id,
              eventType: 'SYSTEM_NOTE',
              content: linkedContext,
              actor: 'system:devops-worker',
            },
          });
        }

        if (ticketCreatedQueue) {
          await ticketCreatedQueue.add('ticket-created', {
            ticketId: ticket.id,
            clientId,
            source: 'AZURE_DEVOPS' as const,
            category: null,
          }, {
            jobId: `ticket-created-${ticket.id}`,
            attempts: 4,
            backoff: { type: 'exponential', delay: 30_000 },
          });
          logger.info({ ticketId: ticket.id, workItemId }, 'Enqueued ticket-created event');
        }

        appLog.info(`Created ticket from work item #${workItemId}: actionable=${actionable}`, { ticketId: ticket.id, workItemId, actionable, title, workItemType }, ticket.id, entityType);
      }

      // Sync comments from DevOps
      try {
        await syncComments(entityId, workItemId);
      } catch (err) {
        logger.error({ entityId, workItemId, err }, 'Failed to sync comments for new work item');
      }

      // If actionable, kick off the conversational workflow
      if (actionable) {
        appLog.info('Work item is actionable — starting workflow', { entityId, workItemId }, entityId, entityType);
        await workflow.onNewEntity(entityId, workItemId);
      } else {
        appLog.info('Work item is not actionable — no workflow started', { entityId, workItemId }, entityId, entityType);
      }
    } else {
      // --- Existing work item: check for changes ---
      // entityId is either ticketId or operationalTaskId
      const entityId = existingSync.ticketId ?? existingSync.operationalTaskId!;

      if (wi.rev > existingSync.revision) {
        if (mode === 'operational-task') {
          await db.operationalTaskEvent.create({
            data: {
              taskId: entityId,
              eventType: 'SYSTEM_NOTE',
              content: `Azure DevOps work item #${workItemId} updated (rev ${existingSync.revision} → ${wi.rev})`,
              metadata: { workItemId, state, assignedTo: assignedTo?.displayName ?? null, revision: wi.rev },
              actor: 'system:devops-worker',
            },
          });

          await db.operationalTask.update({
            where: { id: entityId },
            data: {
              subject: `[${workItemType}] ${title}`,
              description: description.slice(0, maxDescriptionLength) || undefined,
              priority: mapPriority(priority),
            },
          });
        } else {
          await db.ticketEvent.create({
            data: {
              ticketId: entityId,
              eventType: 'SYSTEM_NOTE',
              content: `Azure DevOps work item #${workItemId} updated (rev ${existingSync.revision} → ${wi.rev})`,
              metadata: { workItemId, state, assignedTo: assignedTo?.displayName ?? null, revision: wi.rev },
              actor: 'system:devops-worker',
            },
          });

          await db.ticket.update({
            where: { id: entityId },
            data: {
              subject: `[${workItemType}] ${title}`,
              description: description.slice(0, maxDescriptionLength) || undefined,
              priority: mapPriority(priority),
            },
          });

          // Check if assignment changed (ticket mode only — operational tasks don't have assignment events)
          const wasActionable = existingSync.isActionable;
          if (actionable !== wasActionable) {
            await db.ticketEvent.create({
              data: {
                ticketId: entityId,
                eventType: 'ASSIGNMENT',
                content: actionable
                  ? `Work item assigned to ${assignedUser}`
                  : `Work item unassigned from ${assignedUser}`,
                actor: 'system:devops-worker',
              },
            });
          }
        }

        await db.devOpsSyncState.update({
          where: { id: existingSync.id },
          data: {
            revision: wi.rev,
            isActionable: actionable,
            lastSyncedAt: new Date(),
          },
        });

        logger.info({ entityId, workItemId, newRev: wi.rev }, 'Updated entity from work item');
      }

      // Always sync comments (new comments may exist without a revision bump)
      try {
        await syncComments(entityId, workItemId);
      } catch (err) {
        logger.error({ entityId, workItemId, err }, 'Failed to sync comments for existing work item');
      }

      // Drive the workflow if actionable
      if (actionable) {
        appLog.info('Driving workflow for actionable work item update', { entityId, workItemId }, entityId, entityType);
        await workflow.onEntityUpdate(entityId, workItemId);
      } else {
        appLog.info('Work item not actionable — skipping workflow', { entityId, workItemId }, entityId, entityType);
      }
    }
  };

  /**
   * Fetch linked work items and build a context summary string.
   */
  async function fetchLinkedWorkItemContext(wi: AzDoWorkItem): Promise<string | null> {
    if (!wi.relations || wi.relations.length === 0) return null;

    const linkedIds: number[] = [];
    const relationMap: Map<number, string> = new Map();

    for (const rel of wi.relations) {
      const linkedId = extractWorkItemIdFromUrl(rel.url);
      if (linkedId) {
        linkedIds.push(linkedId);
        const relName = (rel.attributes?.name as string) ?? rel.rel;
        relationMap.set(linkedId, relName);
      }
    }

    if (linkedIds.length === 0) return null;

    const linkedItems = await client.getWorkItems(linkedIds);
    const lines: string[] = ['**Linked Work Items:**'];

    for (const linked of linkedItems) {
      const relName = relationMap.get(linked.id) ?? 'Related';
      const linkedTitle = getField<string>(linked, 'System.Title') ?? `#${linked.id}`;
      const linkedType = getField<string>(linked, 'System.WorkItemType') ?? '';
      const linkedState = getField<string>(linked, 'System.State') ?? '';
      const linkedDesc = stripHtml(getField<string>(linked, 'System.Description'));

      lines.push(`- **${relName}**: [${linkedType}] #${linked.id} — ${linkedTitle} (${linkedState})`);
      if (linkedDesc) {
        lines.push(`  ${linkedDesc.slice(0, 300)}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Sync comments from Azure DevOps into entity events.
   * Only imports comments newer than the last known comment ID.
   */
  async function syncComments(entityId: string, workItemId: number): Promise<void> {
    const syncState = await db.devOpsSyncState.findFirst({
      where: syncWhere(workItemId),
    });
    if (!syncState) return;

    const comments = await client.getComments(workItemId);

    // Filter to comments we haven't seen yet
    const newComments = comments.filter((c) => c.id > syncState.lastCommentId);

    if (newComments.length === 0) return;

    // Sort by ID ascending (oldest first) to preserve conversation order
    newComments.sort((a, b) => a.id - b.id);

    let maxCommentId = syncState.lastCommentId;
    const assignedUserLower = assignedUser.toLowerCase();

    for (const comment of newComments) {
      // Skip our own outbound comments — require both bot marker AND author match
      // to prevent external users from injecting the marker to bypass processing
      const hasBotMarker = comment.text.includes(BOT_MARKER);
      const authorUnique = comment.createdBy.uniqueName?.toLowerCase();
      const authorDisplay = comment.createdBy.displayName?.toLowerCase();
      const isBotAuthor = authorUnique === assignedUserLower || authorDisplay === assignedUserLower;
      if (hasBotMarker && isBotAuthor) {
        if (comment.id > maxCommentId) maxCommentId = comment.id;
        continue;
      }

      const eventData = {
        eventType: 'DEVOPS_INBOUND' as const,
        content: stripHtml(comment.text),
        metadata: {
          devopsCommentId: comment.id,
          workItemId,
          author: comment.createdBy.uniqueName,
          authorName: comment.createdBy.displayName,
        },
        actor: `devops:${comment.createdBy.uniqueName}`,
      };

      if (mode === 'operational-task') {
        await db.operationalTaskEvent.create({
          data: { taskId: entityId, ...eventData },
        });
      } else {
        await db.ticketEvent.create({
          data: { ticketId: entityId, ...eventData },
        });
      }

      if (comment.id > maxCommentId) maxCommentId = comment.id;
    }

    await db.devOpsSyncState.update({
      where: { id: syncState.id },
      data: { lastCommentId: maxCommentId, lastSyncedAt: new Date() },
    });

    appLog.info(`Synced ${newComments.length} comment(s) from DevOps`, { entityId, workItemId, newCommentCount: newComments.length }, entityId, entityType);
  }
}
