import type { Queue } from 'bullmq';
import { createLogger } from '@bronco/shared-utils';

const logger = createLogger('artifact-name-queue');

/** BullMQ queue name for artifact display-name generation jobs. */
export const ARTIFACT_NAME_QUEUE_NAME = 'artifact-name-generation';

export interface ArtifactNameJob {
  artifactId: string;
}

let activeQueue: Queue<ArtifactNameJob> | null = null;

/** Register the queue at service startup so the trigger sites can enqueue lazily. */
export function registerArtifactNameQueue(queue: Queue<ArtifactNameJob>): void {
  activeQueue = queue;
}

/**
 * Enqueue a friendly-name generation job for an artifact. Best-effort —
 * never throws. Skips silently if the queue hasn't been registered yet
 * (e.g., during tests or pre-startup) so callers can drop this in safely.
 */
export async function enqueueArtifactNameGeneration(artifactId: string): Promise<void> {
  if (!activeQueue) {
    // Queue not yet registered — no-op. Phase 1 templated default remains.
    return;
  }
  try {
    await activeQueue.add(
      'generate',
      { artifactId },
      { removeOnComplete: 100, removeOnFail: 50 },
    );
  } catch (err) {
    logger.warn({ err, artifactId }, 'Failed to enqueue artifact-name generation — continuing');
  }
}
