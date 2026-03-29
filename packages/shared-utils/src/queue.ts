import { Queue, Worker } from 'bullmq';
import type { Processor, ConnectionOptions } from 'bullmq';

export function createQueue<T = unknown>(name: string, redisUrl: string): Queue<T> {
  const connection: ConnectionOptions = {
    url: redisUrl,
    maxRetriesPerRequest: null,
  } as ConnectionOptions;
  return new Queue(name, { connection });
}

export function createWorker<T = unknown, R = unknown>(
  name: string,
  redisUrl: string,
  processor: Processor<T, R>,
): Worker<T, R> {
  const connection: ConnectionOptions = {
    url: redisUrl,
    maxRetriesPerRequest: null,
  } as ConnectionOptions;
  return new Worker(name, processor, { connection });
}
