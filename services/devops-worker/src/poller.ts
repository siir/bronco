import { createLogger } from '@bronco/shared-utils';
import type { AzDoClient, AzDoWorkItem } from './client.js';

const logger = createLogger('azdo-poller');

/**
 * Polls Azure DevOps for work items that have changed since the last poll.
 * On first run (no watermark), fetches all work items in the project.
 *
 * Returns the full work item objects (with relations) for processing.
 */
export async function pollWorkItems(
  client: AzDoClient,
  since?: Date,
): Promise<AzDoWorkItem[]> {
  const ids = await client.queryWorkItems(since);

  if (ids.length === 0) {
    logger.debug('No changed work items found');
    return [];
  }

  logger.info({ count: ids.length, since: since?.toISOString() ?? 'initial' }, 'Found changed work items');

  const workItems = await client.getWorkItems(ids);
  return workItems;
}
