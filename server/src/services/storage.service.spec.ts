import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { buffer } from 'node:stream/consumers';
import {
  AssetFileType,
  AssetPathType,
  CacheControl,
  JobStatus,
  PathType,
  PersonPathType,
  SystemMetadataKey,
  UserPathType,
} from 'src/enum.js';
import { StorageService } from 'src/services/storage.service.js';
import { ImmichStartupError } from 'src/utils/misc.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const bootstrapWith = async (
  sut: StorageService,
  mocks: ServiceMocks,
  storage: Partial<ReturnType<typeof mockEnvData>['storage']>,
) => {
  mocks.systemMetadata.get.mockResolvedValue({ mountChecks: {} });
  mocks.asset.getFileSamples.mockResolvedValue([]);
  mocks.config.getEnv.mockReturnValue(mockEnvData({ storage: { mediaLocation: '/data', ...storage } }));
  await sut.onBootstrap();
};

const alias = (overrides: { bucket: string; endpoint: string; serveMode: 'proxy' | 'redirect' }) => ({
  region: 'us-east-1',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
  presignedUrlExpiry: 3600,
  ...overrides,
});

const serve = ({ backend, key }: ReturnType<typeof StorageService.resolve>) =>
  backend.getServeStrategy(key, { contentType: 'image/jpeg', cacheControl: CacheControl.PrivateWithCache });

describe(StorageService.name, () => {
  let sut: StorageService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(StorageService));
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('onBootstrap', () => {
    it('should enable mount folder checking', async () => {
      mocks.systemMetadata.get.mockResolvedValue(null);
      mocks.asset.getFileSamples.mockResolvedValue([]);
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({
          storage: {
            ignoreMountCheckErrors: false,
            mediaLocation: '/data',
          },
        }),
      );

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.SystemFlags, {
        mountChecks: {
          backups: true,
          'encoded-video': true,
          library: true,
          profile: true,
          thumbs: true,
          upload: true,
        },
      });
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/encoded-video'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/library'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/profile'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/thumbs'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/upload'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/backups'));
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/encoded-video/.immich'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/library/.immich'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/profile/.immich'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/thumbs/.immich'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/upload/.immich'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/backups/.immich'),
        expect.any(Buffer),
      );
    });

    it('should enable mount folder checking for a new folder type', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        mountChecks: {
          backups: false,
          'encoded-video': true,
          library: false,
          profile: true,
          thumbs: true,
          upload: true,
        },
      });
      mocks.asset.getFileSamples.mockResolvedValue([]);
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({
          storage: {
            ignoreMountCheckErrors: false,
            mediaLocation: '/data',
          },
        }),
      );

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.SystemFlags, {
        mountChecks: {
          backups: true,
          'encoded-video': true,
          library: true,
          profile: true,
          thumbs: true,
          upload: true,
        },
      });
      expect(mocks.storage.mkdirSync).toHaveBeenCalledTimes(2);
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/library'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/backups'));
      expect(mocks.storage.createFile).toHaveBeenCalledTimes(2);
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/library/.immich'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/backups/.immich'),
        expect.any(Buffer),
      );
    });

    it('should throw an error if .immich is missing', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ mountChecks: { upload: true } });
      mocks.storage.readFile.mockRejectedValue(new Error("ENOENT: no such file or directory, open '/app/.immich'"));

      await expect(sut.onBootstrap()).rejects.toThrow('Failed to read');

      expect(mocks.storage.createOrOverwriteFile).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('should throw an error if .immich is present but read-only', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ mountChecks: { upload: true } });
      mocks.storage.overwriteFile.mockRejectedValue(
        new Error("ENOENT: no such file or directory, open '/app/.immich'"),
      );

      await expect(sut.onBootstrap()).rejects.toThrow('Failed to write');

      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('should skip mount file creation if file already exists', async () => {
      const error = new Error('Error creating file') as any;
      error.code = 'EEXIST';
      mocks.systemMetadata.get.mockResolvedValue({ mountChecks: {} });
      mocks.storage.createFile.mockRejectedValue(error);
      mocks.asset.getFileSamples.mockResolvedValue([]);

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.logger.warn).toHaveBeenCalledWith('Found existing mount file, skipping creation');
    });

    it('should throw an error if mount file could not be created', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ mountChecks: {} });
      mocks.storage.createFile.mockRejectedValue(new Error('Error creating file'));

      await expect(sut.onBootstrap()).rejects.toBeInstanceOf(ImmichStartupError);
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('should startup if checks are disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ mountChecks: { upload: true } });
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({
          storage: { ignoreMountCheckErrors: true },
        }),
      );
      mocks.asset.getFileSamples.mockResolvedValue([]);
      mocks.storage.overwriteFile.mockRejectedValue(
        new Error("ENOENT: no such file or directory, open '/app/.immich'"),
      );

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.systemMetadata.set).not.toHaveBeenCalledWith(SystemMetadataKey.SystemFlags, expect.anything());
    });

    it('should detect media location from /data when it exists', async () => {
      mocks.systemMetadata.get.mockResolvedValue(null);
      mocks.asset.getFileSamples.mockResolvedValue([]);
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({
          storage: {
            ignoreMountCheckErrors: false,
          },
        }),
      );
      mocks.storage.existsSync.mockImplementation((path: string) => path === '/data');

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/'));
    });

    it('should fall back to /usr/src/app/upload when both candidates exist', async () => {
      mocks.systemMetadata.get.mockResolvedValue(null);
      mocks.asset.getFileSamples.mockResolvedValue([]);
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({
          storage: {
            ignoreMountCheckErrors: false,
          },
        }),
      );
      mocks.storage.existsSync.mockReturnValue(true);

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/usr/src/app/upload/'));
    });

    it('should fall back to /usr/src/app/upload when no candidates exist', async () => {
      mocks.systemMetadata.get.mockResolvedValue(null);
      mocks.asset.getFileSamples.mockResolvedValue([]);
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({
          storage: {
            ignoreMountCheckErrors: false,
          },
        }),
      );
      mocks.storage.existsSync.mockReturnValue(false);

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/usr/src/app/upload/'));
    });

    it('should migrate file paths when media location changes', async () => {
      mocks.systemMetadata.get.mockImplementation((key: string) => {
        if (key === SystemMetadataKey.SystemFlags) {
          return Promise.resolve({
            mountChecks: {
              backups: true,
              'encoded-video': true,
              library: true,
              profile: true,
              thumbs: true,
              upload: true,
            },
          });
        }
        if (key === SystemMetadataKey.MediaLocation) {
          return Promise.resolve({ location: '/usr/src/app/upload' });
        }
        return Promise.resolve(null);
      });
      mocks.asset.getFileSamples.mockResolvedValue([
        { path: 'file:///usr/src/app/upload/library/some-file.jpg' } as any,
      ]);
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({
          storage: {
            ignoreMountCheckErrors: false,
            mediaLocation: '/data',
          },
        }),
      );

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.database.migrateFilePaths).toHaveBeenCalledWith('/usr/src/app/upload', '/data');
    });

    it('should not migrate file paths when media location has not changed', async () => {
      mocks.systemMetadata.get.mockImplementation((key: string) => {
        if (key === SystemMetadataKey.SystemFlags) {
          return Promise.resolve({
            mountChecks: {
              backups: true,
              'encoded-video': true,
              library: true,
              profile: true,
              thumbs: true,
              upload: true,
            },
          });
        }
        if (key === SystemMetadataKey.MediaLocation) {
          return Promise.resolve({ location: '/data' });
        }
        return Promise.resolve(null);
      });
      mocks.asset.getFileSamples.mockResolvedValue([{ path: 'file:///data/library/some-file.jpg' } as any]);
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({
          storage: {
            ignoreMountCheckErrors: false,
            mediaLocation: '/data',
          },
        }),
      );

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.database.migrateFilePaths).not.toHaveBeenCalled();
    });

    it('should throw an error for inconsistent media location', async () => {
      mocks.systemMetadata.get.mockImplementation((key: string) => {
        if (key === SystemMetadataKey.SystemFlags) {
          return Promise.resolve({
            mountChecks: {
              backups: true,
              'encoded-video': true,
              library: true,
              profile: true,
              thumbs: true,
              upload: true,
            },
          });
        }
        if (key === SystemMetadataKey.MediaLocation) {
          return Promise.resolve({ location: '/old-location' });
        }
        return Promise.resolve(null);
      });
      mocks.asset.getFileSamples.mockResolvedValue([
        { path: 'file:///totally-different/library/some-file.jpg' } as any,
      ]);
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({
          storage: {
            ignoreMountCheckErrors: false,
            mediaLocation: '/data',
          },
        }),
      );

      await expect(sut.onBootstrap()).rejects.toThrow('Detected an inconsistent media location');
    });

    it('should use saved media location value if it matches current', async () => {
      mocks.systemMetadata.get.mockImplementation((key: string) => {
        if (key === SystemMetadataKey.SystemFlags) {
          return Promise.resolve({
            mountChecks: {
              backups: true,
              'encoded-video': true,
              library: true,
              profile: true,
              thumbs: true,
              upload: true,
            },
          });
        }
        if (key === SystemMetadataKey.MediaLocation) {
          return Promise.resolve({ location: '/data' });
        }
        return Promise.resolve(null);
      });
      mocks.asset.getFileSamples.mockResolvedValue([]);
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({
          storage: {
            ignoreMountCheckErrors: false,
            mediaLocation: '/data',
          },
        }),
      );

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.systemMetadata.set).not.toHaveBeenCalledWith(SystemMetadataKey.MediaLocation, expect.anything());
    });

    it('should save new media location when it differs from saved value', async () => {
      mocks.systemMetadata.get.mockImplementation((key: string) => {
        if (key === SystemMetadataKey.SystemFlags) {
          return Promise.resolve({
            mountChecks: {
              backups: true,
              'encoded-video': true,
              library: true,
              profile: true,
              thumbs: true,
              upload: true,
            },
          });
        }
        if (key === SystemMetadataKey.MediaLocation) {
          return Promise.resolve(null);
        }
        return Promise.resolve(null);
      });
      mocks.asset.getFileSamples.mockResolvedValue([]);
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({
          storage: {
            ignoreMountCheckErrors: false,
            mediaLocation: '/data',
          },
        }),
      );

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.MediaLocation, { location: '/data' });
    });

    it('should not skip mount checks when all flags are already set', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        mountChecks: {
          backups: true,
          'encoded-video': true,
          library: true,
          profile: true,
          thumbs: true,
          upload: true,
        },
      });
      mocks.asset.getFileSamples.mockResolvedValue([]);
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({
          storage: {
            ignoreMountCheckErrors: false,
            mediaLocation: '/data',
          },
        }),
      );

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      // Should not create new mount files since all flags are already set
      expect(mocks.storage.createFile).not.toHaveBeenCalled();
      // Should not update system flags since nothing changed
      expect(mocks.systemMetadata.set).not.toHaveBeenCalledWith(SystemMetadataKey.SystemFlags, expect.anything());
    });
  });

  describe('handleDeleteFiles', () => {
    it('should handle null values', async () => {
      await sut.handleDeleteFiles({ files: [undefined, null] });

      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });

    it('should handle an error removing a file', async () => {
      mocks.storage.unlink.mockRejectedValue(new Error('something-went-wrong'));

      await sut.handleDeleteFiles({ files: ['file:///path/to/something'] });

      expect(mocks.storage.unlink).toHaveBeenCalledWith('/path/to/something');
    });

    it('should remove the file', async () => {
      await sut.handleDeleteFiles({ files: ['file:///path/to/something'] });

      expect(mocks.storage.unlink).toHaveBeenCalledWith('/path/to/something');
    });

    it('should return JobStatus.Success', async () => {
      const result = await sut.handleDeleteFiles({ files: ['file:///path/to/something'] });
      expect(result).toBe(JobStatus.Success);
    });

    it('should handle multiple files including null values', async () => {
      await sut.handleDeleteFiles({
        files: ['file:///path/to/file1', null, undefined, 'file:///path/to/file2'],
      });

      expect(mocks.storage.unlink).toHaveBeenCalledTimes(2);
      expect(mocks.storage.unlink).toHaveBeenCalledWith('/path/to/file1');
      expect(mocks.storage.unlink).toHaveBeenCalledWith('/path/to/file2');
    });

    it('should continue deleting files even if one fails', async () => {
      mocks.storage.unlink.mockRejectedValueOnce(new Error('first-file-error')).mockResolvedValueOnce();

      await sut.handleDeleteFiles({ files: ['file:///path/to/file1', 'file:///path/to/file2'] });

      expect(mocks.storage.unlink).toHaveBeenCalledTimes(2);
      expect(mocks.storage.unlink).toHaveBeenCalledWith('/path/to/file1');
      expect(mocks.storage.unlink).toHaveBeenCalledWith('/path/to/file2');
    });
  });

  describe('storage aliases', () => {
    it.each<{ kind: PathType; alias: string }>([
      { kind: AssetPathType.Original, alias: 'originals-eu' },
      { kind: AssetFileType.Sidecar, alias: 'originals-eu' },
      { kind: UserPathType.Profile, alias: 'originals-eu' },
      { kind: AssetFileType.Thumbnail, alias: 'previews-home' },
      { kind: AssetFileType.Preview, alias: 'previews-home' },
      { kind: AssetFileType.FullSize, alias: 'previews-home' },
      { kind: AssetFileType.EncodedVideo, alias: 'previews-home' },
      { kind: PersonPathType.Face, alias: 'previews-home' },
    ])('writes a new $kind file to $alias', async ({ kind, alias: expected }) => {
      await bootstrapWith(sut, mocks, {
        aliases: {
          'originals-eu': alias({ bucket: 'originals', endpoint: 'https://s3.eu.example', serveMode: 'redirect' }),
          'previews-home': alias({ bucket: 'previews', endpoint: 'https://minio.home:9000', serveMode: 'proxy' }),
        },
        writeTargets: {
          originals: { type: 's3', alias: 'originals-eu' },
          derivatives: { type: 's3', alias: 'previews-home' },
          encodedVideo: { type: 's3', alias: 'previews-home' },
        },
      });

      expect(StorageService.getWriteTarget(kind)).toEqual({ type: 's3', alias: expected });
    });

    it.each<{ kind: PathType; alias: string }>([{ kind: AssetFileType.EncodedVideo, alias: 'quill' }])(
      'writes a new $kind file to $alias when encoded video has its own target',
      async ({ kind, alias: expected }) => {
        await bootstrapWith(sut, mocks, {
          aliases: {
            'originals-eu': alias({ bucket: 'originals', endpoint: 'https://s3.eu.example', serveMode: 'redirect' }),
            'previews-home': alias({ bucket: 'previews', endpoint: 'https://minio.home:9000', serveMode: 'proxy' }),
            quill: alias({ bucket: 'immich-derivatives', endpoint: 'http://quill:9310', serveMode: 'proxy' }),
          },
          writeTargets: {
            originals: { type: 's3', alias: 'originals-eu' },
            derivatives: { type: 's3', alias: 'previews-home' },
            encodedVideo: { type: 's3', alias: 'quill' },
          },
        });

        expect(StorageService.getWriteTarget(kind)).toEqual({ type: 's3', alias: expected });
      },
    );

    it.each([
      {
        targets: { derivatives: { type: 'disk' as const }, encodedVideo: { type: 's3' as const, alias: 'quill' } },
        checked: ['thumbs'],
        skipped: ['encoded-video'],
      },
      {
        targets: { derivatives: { type: 's3' as const, alias: 'quill' }, encodedVideo: { type: 'disk' as const } },
        checked: ['encoded-video'],
        skipped: ['thumbs'],
      },
    ])(
      'keeps encoded video on disk only when its own target is disk, and thumbnails only when the derivatives target is: $checked',
      async ({ targets, checked, skipped }) => {
        await bootstrapWith(sut, mocks, {
          aliases: {
            quill: alias({ bucket: 'immich-derivatives', endpoint: 'http://quill:9310', serveMode: 'proxy' }),
          },
          writeTargets: { originals: { type: 'disk' }, ...targets },
        });

        const markers = mocks.storage.createFile.mock.calls.map(([path]) => path);
        for (const folder of checked) {
          expect(markers).toContainEqual(expect.stringContaining(`/data/${folder}/.immich`));
        }
        for (const folder of skipped) {
          expect(markers).not.toContainEqual(expect.stringContaining(`/data/${folder}/.immich`));
        }
      },
    );

    it('serves each alias in its own mode: proxy streams the file, redirect signs against its own endpoint', async () => {
      const server = createServer((request, response) => {
        response.end(
          new URL(request.url!, 'http://localhost').pathname === '/previews/thumbs/user/photo.webp'
            ? 'preview bytes'
            : '',
        );
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      await bootstrapWith(sut, mocks, {
        aliases: {
          'originals-eu': alias({ bucket: 'originals', endpoint: 'https://s3.eu.example', serveMode: 'redirect' }),
          'previews-home': alias({ bucket: 'previews', endpoint: `http://127.0.0.1:${port}`, serveMode: 'proxy' }),
        },
      });
      try {
        const proxied = await serve(StorageService.resolve('s3://previews-home/thumbs/user/photo.webp'));
        const redirected = await serve(StorageService.resolve('s3://originals-eu/upload/user/photo.jpg'));

        const proxiedBytes = proxied.type === 'stream' ? await buffer(proxied.stream) : undefined;

        expect(proxiedBytes?.toString()).toBe('preview bytes');
        expect(redirected.type === 'redirect' && redirected.url).toMatch(
          /^https:\/\/s3\.eu\.example\/originals\/upload\/user\/photo\.jpg\?.*X-Amz-Signature=/,
        );
      } finally {
        server.close();
      }
    });
  });
});
