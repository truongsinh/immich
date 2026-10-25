// A put resolves only once its object answers HEAD with the uploaded size, because an S3 gateway may answer
// CompleteMultipartUpload before the object exists (versitygw's idempotent retry). Runs the real SDK and
// lib-storage against a scripted S3 server over HTTP; the module-mocked unit rows are in s3-storage.backend.spec.ts.
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { S3StorageBackend } from 'src/backends/s3-storage.backend.js';

type HeadAnswer = 'missing' | number;

const startS3 = async (heads: HeadAnswer[]) => {
  const seen = { heads: 0, singlePuts: 0, completes: 0 };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://s3');
    req.resume();
    req.on('end', () => {
      if (req.method === 'HEAD') {
        const answer = heads[Math.min(seen.heads++, heads.length - 1)];
        if (answer === 'missing') {
          res.writeHead(404).end();
        } else {
          res.writeHead(200, { 'content-length': answer, etag: '"o"' }).end();
        }
      } else if (req.method === 'POST' && url.searchParams.has('uploads')) {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end('<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>');
      } else if (req.method === 'PUT') {
        if (!url.searchParams.has('partNumber')) {
          seen.singlePuts++;
        }
        res.writeHead(200, { etag: '"p"' }).end();
      } else if (req.method === 'POST' && url.searchParams.has('uploadId')) {
        seen.completes++;
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end('<CompleteMultipartUploadResult><ETag>"c"</ETag></CompleteMultipartUploadResult>');
      } else {
        res.writeHead(400).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const backend = new S3StorageBackend({
    bucket: 'b',
    region: 'us-east-1',
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    accessKeyId: 'k',
    secretAccessKey: 's',
    presignedUrlExpiry: 60,
    serveMode: 'proxy',
    putVisibleTimeoutMs: 300,
  });
  return { backend, seen };
};

const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

const SMALL = 1024;
const MULTIPART = 6 * 1024 * 1024;

describe('S3StorageBackend.put waits for the object to be visible', () => {
  it.each([
    { name: 'visible at once', size: SMALL, heads: [SMALL], headsSeen: 1 },
    {
      name: 'complete answered before the object exists',
      size: SMALL,
      heads: ['missing', 'missing', 'missing', SMALL],
      headsSeen: 4,
    },
    { name: 'object visible short, then whole', size: SMALL, heads: [SMALL - 1, SMALL], headsSeen: 2 },
    { name: 'multipart upload, visible at once', size: MULTIPART, heads: [MULTIPART], headsSeen: 1 },
  ] as { name: string; size: number; heads: HeadAnswer[]; headsSeen: number }[])(
    'a put resolves only once the object answers HEAD with the uploaded size: $name',
    async ({ size, heads, headsSeen }) => {
      const { backend, seen } = await startS3(heads);

      await backend.put('encoded-video/a.mp4', Readable.from([Buffer.alloc(size)]));

      expect(seen.heads).toBe(headsSeen);
      expect(seen.singlePuts + seen.completes).toBe(1);
    },
  );

  it.each([
    { name: 'never found', heads: ['missing'] },
    { name: 'always short', heads: [SMALL - 1] },
  ] as { name: string; heads: HeadAnswer[] }[])(
    'a put whose object never becomes visible within the timeout rejects, naming the key: $name',
    async ({ heads }) => {
      const { backend } = await startS3(heads);

      await expect(backend.put('encoded-video/b.mp4', Buffer.alloc(SMALL))).rejects.toThrow('encoded-video/b.mp4');
    },
  );
});
