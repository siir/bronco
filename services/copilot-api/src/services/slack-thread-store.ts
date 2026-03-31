import { createLogger } from '@bronco/shared-utils';

const logger = createLogger('slack-thread-store');

export interface SlackThreadEntry {
  ticketId: string;
  channelId: string;
  /** Additional context about the notification (e.g. 'plan_approval', 'new_ticket', 'analysis_complete'). */
  context?: string;
  /** Issue job ID, if this thread is related to a plan approval notification. */
  issueJobId?: string;
}

/**
 * In-memory store mapping Slack thread timestamps to ticket metadata.
 *
 * Key format: `${channelId}:${threadTs}`
 *
 * This is sufficient for a single-operator tool where copilot-api is a single instance.
 * If multi-instance is needed in the future, this could be backed by Redis or the DB.
 */
const threadMap = new Map<string, SlackThreadEntry>();

function makeKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

export function storeThread(channelId: string, threadTs: string, entry: SlackThreadEntry): void {
  const key = makeKey(channelId, threadTs);
  threadMap.set(key, entry);
  logger.debug({ key, ticketId: entry.ticketId, context: entry.context }, 'Slack thread stored');
}

export function lookupThread(channelId: string, threadTs: string): SlackThreadEntry | undefined {
  return threadMap.get(makeKey(channelId, threadTs));
}

export function removeThread(channelId: string, threadTs: string): boolean {
  return threadMap.delete(makeKey(channelId, threadTs));
}

/** Get all stored threads (for debugging/monitoring). */
export function getThreadCount(): number {
  return threadMap.size;
}

/**
 * Evict entries older than the given max age.
 * Call periodically to prevent unbounded memory growth.
 */
const ENTRY_TIMESTAMPS = new Map<string, number>();

export function storeThreadWithTTL(channelId: string, threadTs: string, entry: SlackThreadEntry): void {
  const key = makeKey(channelId, threadTs);
  threadMap.set(key, entry);
  ENTRY_TIMESTAMPS.set(key, Date.now());
  logger.debug({ key, ticketId: entry.ticketId, context: entry.context }, 'Slack thread stored');
}

export function evictStaleThreads(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
  const cutoff = Date.now() - maxAgeMs;
  let evicted = 0;
  for (const [key, timestamp] of ENTRY_TIMESTAMPS) {
    if (timestamp < cutoff) {
      threadMap.delete(key);
      ENTRY_TIMESTAMPS.delete(key);
      evicted++;
    }
  }
  if (evicted > 0) {
    logger.info({ evicted, remaining: threadMap.size }, 'Evicted stale Slack thread entries');
  }
  return evicted;
}
