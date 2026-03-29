import type { PrismaClient } from '@bronco/db';
import type { EntityType, TicketEventType, TicketStatus } from '@bronco/shared-types';
import type { OperationalTaskEventType, OperationalTaskStatus } from '@bronco/shared-types';

/**
 * Context gathered from either a Ticket or an OperationalTask for AI prompting.
 */
export interface WorkflowContext {
  /** Entity ID (ticketId or operationalTaskId). */
  entityId: string;
  subject: string;
  description: string | null;
  priority: string;
  category: string | null;
  /** Client name — null for operational tasks (no client). */
  clientName: string | null;
  /** Client ID — undefined for operational tasks. */
  clientId?: string;
  events: { type: string; content: string | null; actor: string; createdAt: string }[];
}

/** Minimal event shape returned by {@link WorkflowTarget.getRecentEvents}. */
export interface RecentEvent {
  eventType: string;
  content: string | null;
  actor: string;
  createdAt: Date;
}

/**
 * Abstraction layer so the WorkflowEngine can operate on either
 * Tickets (per-client) or OperationalTasks (internal/global).
 */
export interface WorkflowTarget {
  /**
   * Entity type string used in logging and AI context.
   * 'ticket' for Ticket-backed targets, 'operational_task' for OperationalTask-backed targets.
   */
  readonly entityType: EntityType;

  /** Gather full context for AI prompting. */
  gatherContext(entityId: string): Promise<WorkflowContext>;

  /** Get recent events for the entity, ordered by createdAt desc. */
  getRecentEvents(entityId: string, take: number): Promise<RecentEvent[]>;

  /** Create an event/log entry on the entity. */
  createEvent(entityId: string, data: {
    eventType: string;
    content?: string | null;
    metadata?: Record<string, unknown>;
    actor?: string;
  }): Promise<void>;

  /** Update the entity's status. */
  updateStatus(entityId: string, status: string): Promise<void>;
}

/**
 * WorkflowTarget backed by the Ticket model (for per-client integrations).
 */
export class TicketWorkflowTarget implements WorkflowTarget {
  readonly entityType = 'ticket' as const;

  constructor(private db: PrismaClient) {}

  async gatherContext(ticketId: string): Promise<WorkflowContext> {
    const ticket = await this.db.ticket.findUniqueOrThrow({
      where: { id: ticketId },
      include: {
        events: { orderBy: { createdAt: 'asc' } },
        client: true,
        system: true,
      },
    });

    return {
      entityId: ticket.id,
      clientId: ticket.clientId,
      subject: ticket.subject,
      description: ticket.description,
      priority: ticket.priority,
      category: ticket.category,
      clientName: ticket.client.name,
      events: ticket.events.map((e) => ({
        type: e.eventType,
        content: e.content,
        actor: e.actor,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }

  async getRecentEvents(ticketId: string, take: number): Promise<RecentEvent[]> {
    return this.db.ticketEvent.findMany({
      where: { ticketId },
      orderBy: { createdAt: 'desc' },
      take,
      select: { eventType: true, content: true, actor: true, createdAt: true },
    });
  }

  async createEvent(ticketId: string, data: {
    eventType: string;
    content?: string | null;
    metadata?: Record<string, unknown>;
    actor?: string;
  }): Promise<void> {
    await this.db.ticketEvent.create({
      data: {
        ticketId,
        eventType: data.eventType as TicketEventType,
        content: data.content ?? null,
        metadata: data.metadata as never ?? undefined,
        actor: data.actor ?? 'system',
      },
    });
  }

  async updateStatus(ticketId: string, status: string): Promise<void> {
    await this.db.ticket.update({
      where: { id: ticketId },
      data: { status: status as TicketStatus },
    });
  }
}

/**
 * WorkflowTarget backed by the OperationalTask model (for global/internal integration).
 */
export class OperationalTaskWorkflowTarget implements WorkflowTarget {
  readonly entityType = 'operational_task' as const;

  constructor(private db: PrismaClient) {}

  async gatherContext(taskId: string): Promise<WorkflowContext> {
    const task = await this.db.operationalTask.findUniqueOrThrow({
      where: { id: taskId },
      include: {
        events: { orderBy: { createdAt: 'asc' } },
      },
    });

    return {
      entityId: task.id,
      subject: task.subject,
      description: task.description,
      priority: task.priority,
      category: null,
      clientName: null,
      events: task.events.map((e) => ({
        type: e.eventType,
        content: e.content,
        actor: e.actor,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }

  async getRecentEvents(taskId: string, take: number): Promise<RecentEvent[]> {
    return this.db.operationalTaskEvent.findMany({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
      take,
      select: { eventType: true, content: true, actor: true, createdAt: true },
    });
  }

  async createEvent(taskId: string, data: {
    eventType: string;
    content?: string | null;
    metadata?: Record<string, unknown>;
    actor?: string;
  }): Promise<void> {
    await this.db.operationalTaskEvent.create({
      data: {
        taskId,
        eventType: data.eventType as OperationalTaskEventType,
        content: data.content ?? null,
        metadata: data.metadata as never ?? undefined,
        actor: data.actor ?? 'system',
      },
    });
  }

  async updateStatus(taskId: string, status: string): Promise<void> {
    await this.db.operationalTask.update({
      where: { id: taskId },
      data: { status: status as OperationalTaskStatus },
    });
  }
}
