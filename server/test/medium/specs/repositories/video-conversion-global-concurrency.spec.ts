// Q-2: BullMQ's global concurrency, which JobRepository.setGlobalConcurrency sets on the videoConversion queue, holds
// across separate worker processes. Each pod's local Worker concurrency alone lets every pod run its own transcode.
import { Queue, Worker } from 'bullmq';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueName } from 'src/enum.js';

describe('videoConversion global concurrency', () => {
  let redis: StartedTestContainer;
  let connection: { host: string; port: number };

  beforeAll(async () => {
    redis = await new GenericContainer('redis:7.4-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start();
    connection = { host: redis.getHost(), port: redis.getMappedPort(6379) };
  }, 120_000);

  afterAll(async () => {
    await redis?.stop();
  });

  it('two workers never run two video conversions at once under a global concurrency of 1', async () => {
    const queue = new Queue(QueueName.VideoConversion, { prefix: 'immich_bull', connection });
    await queue.setGlobalConcurrency(1);
    let active = 0;
    let maxActive = 0;
    const processor = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 200));
      active--;
    };
    const workers = [1, 2].map(
      () => new Worker(QueueName.VideoConversion, processor, { prefix: 'immich_bull', connection, concurrency: 4 }),
    );
    const done = new Promise<void>((resolve) => {
      let completed = 0;
      for (const worker of workers) {
        worker.on('completed', () => ++completed === 6 && resolve());
      }
    });

    await queue.addBulk([1, 2, 3, 4, 5, 6].map((n) => ({ name: 'video-conversion', data: { n } })));
    await done;

    expect(maxActive).toBe(1);
    await Promise.all([...workers.map((worker) => worker.close()), queue.close()]);
  }, 60_000);
});
