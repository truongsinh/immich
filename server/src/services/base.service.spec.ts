import { EventEmitter } from 'node:events';
import { CacheControl } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { sendFile } from 'src/utils/file.js';
import { newTestService } from 'test/utils.js';

describe(BaseService.name, () => {
  let sut: BaseService;

  beforeEach(() => {
    ({ sut } = newTestService(BaseService));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('ensureLocalFile', () => {
    it('returns the path as-is with a no-op cleanup for absolute paths', async () => {
      const result = await (sut as any).ensureLocalFile('file:///var/lib/immich/upload/abc.jpg');
      expect(result.localPath).toBe('/var/lib/immich/upload/abc.jpg');
      await expect(result.cleanup()).resolves.not.toThrow();
    });

    it('downloads files on an S3 alias via its backend and returns its cleanup', async () => {
      const backendCleanup = vi.fn().mockResolvedValue(void 0);
      const backend = {
        downloadToTemp: vi.fn().mockResolvedValue({ tempPath: '/tmp/abc.jpg', cleanup: backendCleanup }),
      };
      const { StorageService } = await import('src/services/storage.service.js');
      vi.spyOn(StorageService, 'getAliasBackends').mockReturnValue(new Map([['default', backend]]) as any);

      const result = await (sut as any).ensureLocalFile('s3://default/upload/user/abc.jpg');

      expect(backend.downloadToTemp).toHaveBeenCalledWith('upload/user/abc.jpg');
      expect(result.localPath).toBe('/tmp/abc.jpg');
      await result.cleanup();
      expect(backendCleanup).toHaveBeenCalledOnce();
    });

    it('propagates errors from resolving the stored path without leaking cleanup', async () => {
      await expect((sut as any).ensureLocalFile('s3://unknown/foo')).rejects.toThrow('unknown storage alias');
    });

    it('propagates errors from downloadToTemp without leaking cleanup', async () => {
      const backend = { downloadToTemp: vi.fn().mockRejectedValue(new Error('S3 unavailable')) };
      const { StorageService } = await import('src/services/storage.service.js');
      vi.spyOn(StorageService, 'getAliasBackends').mockReturnValue(new Map([['default', backend]]) as any);

      await expect((sut as any).ensureLocalFile('s3://default/upload/user/abc.jpg')).rejects.toThrow('S3 unavailable');
    });
  });

  describe('serveFromBackend', () => {
    it('hands the backend the signal of the response it is serving', async () => {
      const backend = { getServeStrategy: vi.fn().mockResolvedValue({ type: 'redirect', url: 'https://s3/key' }) };
      const { StorageService } = await import('src/services/storage.service.js');
      vi.spyOn(StorageService, 'getAliasBackends').mockReturnValue(new Map([['default', backend]]) as any);
      const res = Object.assign(new EventEmitter(), { set: vi.fn(), redirect: vi.fn() }) as any;

      await sendFile(
        res,
        vi.fn(),
        () => (sut as any).serveFromBackend('s3://default/upload/user/abc.mp4', 'video/mp4', CacheControl.None),
        { debug: vi.fn(), error: vi.fn() } as unknown as LoggingRepository,
      );

      const { signal } = backend.getServeStrategy.mock.calls[0][1];
      expect(signal.aborted).toBe(false);
      res.emit('close');
      expect(signal.aborted).toBe(true);
    });
  });
});
