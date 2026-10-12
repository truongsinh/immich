import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Mock } from 'vitest';
import { DiskStorageBackend } from 'src/backends/disk-storage.backend.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetFileType, JobName, JobStatus, QueueName } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { StorageMigrationService } from 'src/services/storage-migration.service.js';
import { StorageService } from 'src/services/storage.service.js';
import { ServiceMocks, automock, makeStream, newTestService } from 'test/utils.js';

describe(StorageMigrationService.name, () => {
  let sut: StorageMigrationService;
  let mocks: ServiceMocks;

  let mockDiskBackend: {
    exists: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    getServeStrategy: ReturnType<typeof vi.fn>;
    downloadToTemp: ReturnType<typeof vi.fn>;
  };

  let mockS3Backend: {
    exists: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    put: Mock<(key: string, source: Readable) => Promise<unknown>>;
    delete: ReturnType<typeof vi.fn>;
    getServeStrategy: ReturnType<typeof vi.fn>;
    downloadToTemp: ReturnType<typeof vi.fn>;
  };

  let mockArchiveBackend: typeof mockS3Backend;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(StorageMigrationService));

    mockDiskBackend = {
      exists: vi.fn(),
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      getServeStrategy: vi.fn(),
      downloadToTemp: vi.fn(),
    };

    mockS3Backend = {
      exists: vi.fn(),
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      getServeStrategy: vi.fn(),
      downloadToTemp: vi.fn(),
    };

    vi.spyOn(StorageService, 'getDiskBackend').mockReturnValue(
      mockDiskBackend as unknown as ReturnType<typeof StorageService.getDiskBackend>,
    );
    mockArchiveBackend = {
      exists: vi.fn(),
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      getServeStrategy: vi.fn(),
      downloadToTemp: vi.fn(),
    };

    vi.spyOn(StorageService, 'getAliasBackends').mockReturnValue(
      new Map([
        ['default', mockS3Backend],
        ['archive', mockArchiveBackend],
      ]) as unknown as ReturnType<typeof StorageService.getAliasBackends>,
    );
    vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue('/usr/src/app/upload');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('getEstimate', () => {
    it('should return file counts and size from repository', async () => {
      const fileCounts = {
        originals: 100,
        thumbnails: 200,
        previews: 150,
        fullsize: 50,
        sidecars: 10,
        encodedVideos: 30,
        personThumbnails: 20,
        profileImages: 5,
      };
      mocks.storageMigration.getFileCounts.mockResolvedValue(fileCounts);
      mocks.storageMigration.getOriginalsSizeEstimate.mockResolvedValue(1_000_000);

      const result = await sut.getEstimate('s3://default');

      expect(result).toEqual({
        target: 's3://default',
        fileCounts: {
          ...fileCounts,
          total: 565,
        },
        estimatedSizeBytes: 1_000_000,
      });
      expect(mocks.storageMigration.getFileCounts).toHaveBeenCalledWith({ type: 's3', alias: 'default' });
      expect(mocks.storageMigration.getOriginalsSizeEstimate).toHaveBeenCalledWith({ type: 's3', alias: 'default' });
    });
  });

  describe('start', () => {
    const defaultOptions = {
      target: 's3://default',
      deleteSource: false,
      fileTypes: {
        originals: true,
        thumbnails: true,
        previews: true,
        fullsize: true,
        encodedVideos: true,
        sidecars: true,
        personThumbnails: true,
        profileImages: true,
      },
      concurrency: 4,
    };

    const nonZeroFileCounts = {
      originals: 10,
      thumbnails: 0,
      previews: 0,
      fullsize: 0,
      sidecars: 0,
      encodedVideos: 0,
      personThumbnails: 0,
      profileImages: 0,
    };

    it('should validate the target, check no active migration, queue orchestrator, and return batchId', async () => {
      mocks.job.isActive.mockResolvedValue(false);
      mockS3Backend.exists.mockResolvedValue(true);
      mocks.storageMigration.getFileCounts.mockResolvedValue(nonZeroFileCounts);

      const result = await sut.start(defaultOptions);

      expect(result).toHaveProperty('batchId');
      expect(typeof result.batchId).toBe('string');
      expect(mocks.job.isActive).toHaveBeenCalledWith(QueueName.StorageBackendMigration);
      expect(mocks.job.queue).toHaveBeenCalledWith(
        expect.objectContaining({
          name: JobName.StorageBackendMigrationQueueAll,
          data: expect.objectContaining({
            target: 's3://default',
            deleteSource: false,
            batchId: result.batchId,
          }),
        }),
      );
    });

    it.each(['s3://nowhere', 'nowhere', 's3://default/key'])('refuses the target %s', async (target) => {
      await expect(sut.start({ ...defaultOptions, target })).rejects.toThrow(/nowhere|Invalid storage target/);
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('should throw if migration already active', async () => {
      mocks.job.isActive.mockResolvedValue(true);
      mockS3Backend.exists.mockResolvedValue(true);
      mocks.storageMigration.getFileCounts.mockResolvedValue(nonZeroFileCounts);

      await expect(sut.start(defaultOptions)).rejects.toThrow('A storage migration is already in progress');
    });

    it('should throw if there are no files to migrate', async () => {
      mockS3Backend.exists.mockResolvedValue(true);
      mocks.storageMigration.getFileCounts.mockResolvedValue({
        originals: 0,
        thumbnails: 0,
        previews: 0,
        fullsize: 0,
        sidecars: 0,
        encodedVideos: 0,
        personThumbnails: 0,
        profileImages: 0,
      });

      await expect(sut.start(defaultOptions)).rejects.toThrow('No files to migrate');
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });
  });

  describe('handleQueueAll', () => {
    const baseJob = {
      target: 's3://default',
      deleteSource: false,
      batchId: 'batch-1',
      concurrency: 4,
    };

    const allFileTypes = {
      originals: true,
      thumbnails: true,
      previews: true,
      fullsize: true,
      encodedVideos: true,
      sidecars: true,
      personThumbnails: true,
      profileImages: true,
    };

    it('should stream files based on fileTypes flags and queue worker jobs', async () => {
      mocks.storageMigration.streamOriginals.mockReturnValue(
        makeStream([{ id: 'asset-1', originalPath: 'file:///usr/src/app/upload/library/user/ab/cd/file.jpg' }]),
      );
      mocks.storageMigration.streamAssetFiles.mockReturnValue(
        makeStream([
          {
            id: 'file-1',
            assetId: 'asset-1',
            path: 'file:///usr/src/app/upload/thumbs/user/ab/cd/thumb.webp',
            type: AssetFileType.Thumbnail,
          },
        ]),
      );
      mocks.storageMigration.streamEncodedVideos.mockReturnValue(
        makeStream([
          {
            id: 'file-2',
            assetId: 'asset-2',
            path: 'file:///usr/src/app/upload/encoded-video/user/ab/cd/video.mp4',
            type: AssetFileType.EncodedVideo,
          },
        ]),
      );
      mocks.storageMigration.streamPersonThumbnails.mockReturnValue(
        makeStream([
          {
            ownerId: 'owner-1',
            personGroupId: 'person-1',
            thumbnailPath: 'file:///usr/src/app/upload/thumbs/user/ab/cd/person.jpeg',
          },
        ]),
      );
      mocks.storageMigration.streamProfileImages.mockReturnValue(
        makeStream([{ id: 'user-1', profileImagePath: 'file:///usr/src/app/upload/profile/user/ab/cd/profile.jpg' }]),
      );

      const result = await sut.handleQueueAll({ ...baseJob, fileTypes: allFileTypes });

      expect(result).toBe(JobStatus.Success);
      expect(mocks.job.queueAll).toHaveBeenCalled();

      // Verify the jobs were queued
      const queuedJobs = mocks.job.queueAll.mock.calls.flat().flat();
      expect(queuedJobs).toHaveLength(5);
      expect(queuedJobs[0]).toEqual(
        expect.objectContaining({
          name: JobName.StorageBackendMigrationSingle,
          data: expect.objectContaining({
            entityType: 'asset',
            entityId: 'asset-1',
            fileType: 'original',
            sourcePath: 'file:///usr/src/app/upload/library/user/ab/cd/file.jpg',
          }),
        }),
      );
    });

    it('should only queue enabled file types (thumbnails=false skips thumbnails)', async () => {
      mocks.storageMigration.streamOriginals.mockReturnValue(
        makeStream([{ id: 'asset-1', originalPath: 'file:///usr/src/app/upload/library/user/ab/cd/file.jpg' }]),
      );
      mocks.storageMigration.streamAssetFiles.mockReturnValue(makeStream([]));
      mocks.storageMigration.streamEncodedVideos.mockReturnValue(makeStream([]));
      mocks.storageMigration.streamPersonThumbnails.mockReturnValue(makeStream([]));
      mocks.storageMigration.streamProfileImages.mockReturnValue(makeStream([]));

      const fileTypes = {
        originals: true,
        thumbnails: false,
        previews: false,
        fullsize: false,
        encodedVideos: false,
        sidecars: false,
        personThumbnails: false,
        profileImages: false,
      };

      const result = await sut.handleQueueAll({ ...baseJob, fileTypes });

      expect(result).toBe(JobStatus.Success);
      expect(mocks.storageMigration.streamOriginals).toHaveBeenCalledWith({ type: 's3', alias: 'default' });
      expect(mocks.storageMigration.streamAssetFiles).not.toHaveBeenCalled();
      expect(mocks.storageMigration.streamEncodedVideos).not.toHaveBeenCalled();
      expect(mocks.storageMigration.streamPersonThumbnails).not.toHaveBeenCalled();
      expect(mocks.storageMigration.streamProfileImages).not.toHaveBeenCalled();
    });

    it('should stream asset files for selected thumbnail types only', async () => {
      mocks.storageMigration.streamOriginals.mockReturnValue(makeStream([]));
      mocks.storageMigration.streamAssetFiles.mockReturnValue(makeStream([]));
      mocks.storageMigration.streamEncodedVideos.mockReturnValue(makeStream([]));
      mocks.storageMigration.streamPersonThumbnails.mockReturnValue(makeStream([]));
      mocks.storageMigration.streamProfileImages.mockReturnValue(makeStream([]));

      const fileTypes = {
        originals: false,
        thumbnails: true,
        previews: true,
        fullsize: false,
        encodedVideos: false,
        sidecars: false,
        personThumbnails: false,
        profileImages: false,
      };

      await sut.handleQueueAll({ ...baseJob, fileTypes });

      expect(mocks.storageMigration.streamOriginals).not.toHaveBeenCalled();
      expect(mocks.storageMigration.streamAssetFiles).toHaveBeenCalledWith({ type: 's3', alias: 'default' }, [
        AssetFileType.Thumbnail,
        AssetFileType.Preview,
      ]);
    });
  });

  describe('handleMigration', () => {
    const baseJob = {
      entityType: 'asset' as const,
      entityId: 'asset-1',
      fileType: 'original' as string | null,
      sourcePath: 'file:///usr/src/app/upload/library/user/ab/cd/file.jpg',
      batchId: 'batch-1',
      target: 's3://default',
      deleteSource: false,
    };
    const sourceDiskPath = '/usr/src/app/upload/library/user/ab/cd/file.jpg';

    it('moves a file to the named target and stores its new URI', async () => {
      const mockStream = Readable.from([]);
      mockDiskBackend.exists.mockResolvedValue(true);
      mockS3Backend.exists.mockResolvedValue(false);
      mockDiskBackend.get.mockResolvedValue({ stream: mockStream });
      mockS3Backend.put.mockResolvedValue(void 0);
      mocks.storageMigration.updateAssetOriginalPath.mockResolvedValue(true);
      mocks.storageMigration.createLogEntry.mockResolvedValue({} as any);

      const result = await sut.handleMigration(baseJob);

      expect(result).toBe(JobStatus.Success);
      expect(mockDiskBackend.exists).toHaveBeenCalledWith(sourceDiskPath);
      expect(mockS3Backend.exists).toHaveBeenCalledWith('library/user/ab/cd/file.jpg');
      expect(mockDiskBackend.get).toHaveBeenCalledWith(sourceDiskPath);
      expect(mockS3Backend.put).toHaveBeenCalledWith('library/user/ab/cd/file.jpg', mockStream);
      expect(mocks.storageMigration.updateAssetOriginalPath).toHaveBeenCalledWith(
        'asset-1',
        baseJob.sourcePath,
        's3://default/library/user/ab/cd/file.jpg',
      );
      expect(mocks.storageMigration.createLogEntry).toHaveBeenCalledWith({
        entityType: 'asset',
        entityId: 'asset-1',
        fileType: 'original',
        oldPath: baseJob.sourcePath,
        newPath: 's3://default/library/user/ab/cd/file.jpg',
        target: 's3://default',
        batchId: 'batch-1',
      });
    });

    it('should skip when source file not found and return Skipped', async () => {
      mockDiskBackend.exists.mockResolvedValue(false);

      const result = await sut.handleMigration(baseJob);

      expect(result).toBe(JobStatus.Skipped);
      expect(mockS3Backend.put).not.toHaveBeenCalled();
      expect(mocks.storageMigration.updateAssetOriginalPath).not.toHaveBeenCalled();
    });

    it.skipIf(process.getuid?.() === 0)(
      'should fail, not skip as missing, a disk source that exists but cannot be read',
      async () => {
        const mediaLocation = await mkdtemp(join(tmpdir(), 'gallery-migration-'));
        const sourcePath = join(mediaLocation, 'file.jpg');
        await writeFile(sourcePath, 'data', { mode: 0o000 });
        vi.spyOn(StorageService, 'getDiskBackend').mockReturnValue(
          new DiskStorageBackend(
            mediaLocation,
            // eslint-disable-next-line no-sparse-arrays
            new StorageRepository(automock(LoggingRepository, { args: [, { getEnv: () => ({}) }], strict: false })),
          ),
        );
        mockS3Backend.exists.mockResolvedValue(false);
        // read the source like S3's Upload does, which is where the permission error surfaces
        mockS3Backend.put.mockImplementation(async (_key: string, stream: Readable) => {
          await stream.toArray();
        });

        try {
          await expect(sut.handleMigration({ ...baseJob, sourcePath: `file://${sourcePath}` })).resolves.toBe(
            JobStatus.Failed,
          );
          expect(mocks.storageMigration.updateAssetOriginalPath).not.toHaveBeenCalled();
        } finally {
          await rm(mediaLocation, { recursive: true, force: true });
        }
      },
    );

    it('should skip copy when target already exists (idempotency) but still update DB and log', async () => {
      mockDiskBackend.exists.mockResolvedValue(true);
      mockS3Backend.exists.mockResolvedValue(true); // target already exists
      mocks.storageMigration.updateAssetOriginalPath.mockResolvedValue(true);
      mocks.storageMigration.createLogEntry.mockResolvedValue({} as any);

      const result = await sut.handleMigration(baseJob);

      expect(result).toBe(JobStatus.Success);
      // Should NOT copy
      expect(mockDiskBackend.get).not.toHaveBeenCalled();
      expect(mockS3Backend.put).not.toHaveBeenCalled();
      // But should update DB and log
      expect(mocks.storageMigration.updateAssetOriginalPath).toHaveBeenCalled();
      expect(mocks.storageMigration.createLogEntry).toHaveBeenCalled();
    });

    it('should skip on optimistic concurrency conflict (0 rows affected) and return Skipped', async () => {
      mockDiskBackend.exists.mockResolvedValue(true);
      mockS3Backend.exists.mockResolvedValue(false);
      mockDiskBackend.get.mockResolvedValue({
        stream: Readable.from([]),
      });
      mockS3Backend.put.mockResolvedValue(void 0);
      mocks.storageMigration.updateAssetOriginalPath.mockResolvedValue(false); // 0 rows

      const result = await sut.handleMigration(baseJob);

      expect(result).toBe(JobStatus.Skipped);
      expect(mocks.storageMigration.createLogEntry).not.toHaveBeenCalled();
    });

    it('should delete source when deleteSource is true', async () => {
      const mockStream = Readable.from([]);
      mockDiskBackend.exists.mockResolvedValue(true);
      mockS3Backend.exists.mockResolvedValue(false);
      mockDiskBackend.get.mockResolvedValue({ stream: mockStream });
      mockS3Backend.put.mockResolvedValue(void 0);
      mockDiskBackend.delete.mockResolvedValue(void 0);
      mocks.storageMigration.updateAssetOriginalPath.mockResolvedValue(true);
      mocks.storageMigration.createLogEntry.mockResolvedValue({} as any);

      const result = await sut.handleMigration({ ...baseJob, deleteSource: true });

      expect(result).toBe(JobStatus.Success);
      expect(mockDiskBackend.delete).toHaveBeenCalledWith(sourceDiskPath);
    });

    it('should not delete source when deleteSource is false', async () => {
      const mockStream = Readable.from([]);
      mockDiskBackend.exists.mockResolvedValue(true);
      mockS3Backend.exists.mockResolvedValue(false);
      mockDiskBackend.get.mockResolvedValue({ stream: mockStream });
      mockS3Backend.put.mockResolvedValue(void 0);
      mocks.storageMigration.updateAssetOriginalPath.mockResolvedValue(true);
      mocks.storageMigration.createLogEntry.mockResolvedValue({} as any);

      const result = await sut.handleMigration({ ...baseJob, deleteSource: false });

      expect(result).toBe(JobStatus.Success);
      expect(mockDiskBackend.delete).not.toHaveBeenCalled();
    });

    it('should return Failed when copy throws an error', async () => {
      mockDiskBackend.exists.mockResolvedValue(true);
      mockS3Backend.exists.mockResolvedValue(false);
      mockDiskBackend.get.mockRejectedValue(new Error('Read error'));

      const result = await sut.handleMigration(baseJob);

      expect(result).toBe(JobStatus.Failed);
    });

    it('should move a file from an S3 alias to disk', async () => {
      const toDiskJob = {
        entityType: 'asset' as const,
        entityId: 'asset-1',
        fileType: 'original' as string | null,
        sourcePath: 's3://default/library/user/ab/cd/file.jpg',
        batchId: 'batch-1',
        target: 'file://',
        deleteSource: false,
      };

      const mockStream = Readable.from([]);
      mockS3Backend.exists.mockResolvedValue(true);
      mockDiskBackend.exists.mockResolvedValue(false);
      mockS3Backend.get.mockResolvedValue({ stream: mockStream });
      mockDiskBackend.put.mockResolvedValue(void 0);
      mocks.storageMigration.updateAssetOriginalPath.mockResolvedValue(true);
      mocks.storageMigration.createLogEntry.mockResolvedValue({} as any);

      const result = await sut.handleMigration(toDiskJob);

      expect(result).toBe(JobStatus.Success);
      expect(mockS3Backend.exists).toHaveBeenCalledWith('library/user/ab/cd/file.jpg');
      expect(mockDiskBackend.exists).toHaveBeenCalledWith('/usr/src/app/upload/library/user/ab/cd/file.jpg');
      expect(mockS3Backend.get).toHaveBeenCalledWith('library/user/ab/cd/file.jpg');
      expect(mockDiskBackend.put).toHaveBeenCalledWith('/usr/src/app/upload/library/user/ab/cd/file.jpg', mockStream);
      expect(mocks.storageMigration.updateAssetOriginalPath).toHaveBeenCalledWith(
        'asset-1',
        toDiskJob.sourcePath,
        'file:///usr/src/app/upload/library/user/ab/cd/file.jpg',
      );
    });

    it('copies a file between two S3 aliases under the same key', async () => {
      const job = { ...baseJob, sourcePath: 's3://default/upload/user/ab/cd/file.jpg', target: 's3://archive' };
      const mockStream = Readable.from([]);
      mockS3Backend.exists.mockResolvedValue(true);
      mockArchiveBackend.exists.mockResolvedValue(false);
      mockS3Backend.get.mockResolvedValue({ stream: mockStream });
      mocks.storageMigration.updateAssetOriginalPath.mockResolvedValue(true);
      mocks.storageMigration.createLogEntry.mockResolvedValue({} as any);

      const result = await sut.handleMigration(job);

      expect(result).toBe(JobStatus.Success);
      expect(mockArchiveBackend.put).toHaveBeenCalledWith('upload/user/ab/cd/file.jpg', mockStream);
      expect(mocks.storageMigration.updateAssetOriginalPath).toHaveBeenCalledWith(
        'asset-1',
        job.sourcePath,
        's3://archive/upload/user/ab/cd/file.jpg',
      );
    });

    it('refuses a target on an unknown alias without touching the file', async () => {
      const result = await sut.handleMigration({ ...baseJob, target: 's3://nowhere' });

      expect(result).toBe(JobStatus.Failed);
      expect(mockDiskBackend.get).not.toHaveBeenCalled();
      expect(mocks.storageMigration.updateAssetOriginalPath).not.toHaveBeenCalled();
    });

    it('should update encoded video path for encodedVideo file type', async () => {
      const encodedVideoJob = {
        ...baseJob,
        fileType: 'encodedVideo',
        sourcePath: 'file:///usr/src/app/upload/encoded-video/user/ab/cd/video.mp4',
      };

      const mockStream = Readable.from([]);
      mockDiskBackend.exists.mockResolvedValue(true);
      mockS3Backend.exists.mockResolvedValue(false);
      mockDiskBackend.get.mockResolvedValue({ stream: mockStream });
      mockS3Backend.put.mockResolvedValue(void 0);
      mocks.storageMigration.updateAssetEncodedVideoPath.mockResolvedValue(true);
      mocks.storageMigration.createLogEntry.mockResolvedValue({} as any);

      const result = await sut.handleMigration(encodedVideoJob);

      expect(result).toBe(JobStatus.Success);
      expect(mocks.storageMigration.updateAssetEncodedVideoPath).toHaveBeenCalledWith(
        'asset-1',
        encodedVideoJob.sourcePath,
        's3://default/encoded-video/user/ab/cd/video.mp4',
      );
    });

    it('should update asset file path for assetFile entity type', async () => {
      const assetFileJob = {
        ...baseJob,
        entityType: 'assetFile' as const,
        entityId: 'file-1',
        fileType: AssetFileType.Thumbnail,
        sourcePath: 'file:///usr/src/app/upload/thumbs/user/ab/cd/thumb.webp',
      };

      const mockStream = Readable.from([]);
      mockDiskBackend.exists.mockResolvedValue(true);
      mockS3Backend.exists.mockResolvedValue(false);
      mockDiskBackend.get.mockResolvedValue({ stream: mockStream });
      mockS3Backend.put.mockResolvedValue(void 0);
      mocks.storageMigration.updateAssetFilePath.mockResolvedValue(true);
      mocks.storageMigration.createLogEntry.mockResolvedValue({} as any);

      const result = await sut.handleMigration(assetFileJob);

      expect(result).toBe(JobStatus.Success);
      expect(mocks.storageMigration.updateAssetFilePath).toHaveBeenCalledWith(
        'file-1',
        assetFileJob.sourcePath,
        's3://default/thumbs/user/ab/cd/thumb.webp',
      );
    });

    it('should update person thumbnail path for person entity type', async () => {
      const personJob = {
        ...baseJob,
        entityType: 'person' as const,
        entityId: 'person-1',
        fileType: null,
        sourcePath: 'file:///usr/src/app/upload/thumbs/user/ab/cd/person.jpeg',
      };

      const mockStream = Readable.from([]);
      mockDiskBackend.exists.mockResolvedValue(true);
      mockS3Backend.exists.mockResolvedValue(false);
      mockDiskBackend.get.mockResolvedValue({ stream: mockStream });
      mockS3Backend.put.mockResolvedValue(void 0);
      mocks.storageMigration.updatePersonThumbnailPath.mockResolvedValue(true);
      mocks.storageMigration.createLogEntry.mockResolvedValue({} as any);

      const result = await sut.handleMigration(personJob);

      expect(result).toBe(JobStatus.Success);
      expect(mocks.storageMigration.updatePersonThumbnailPath).toHaveBeenCalledWith(
        'person-1',
        personJob.sourcePath,
        's3://default/thumbs/user/ab/cd/person.jpeg',
      );
    });

    it('should update user profile image path for user entity type', async () => {
      const userJob = {
        ...baseJob,
        entityType: 'user' as const,
        entityId: 'user-1',
        fileType: null,
        sourcePath: 'file:///usr/src/app/upload/profile/user/ab/cd/profile.jpg',
      };

      const mockStream = Readable.from([]);
      mockDiskBackend.exists.mockResolvedValue(true);
      mockS3Backend.exists.mockResolvedValue(false);
      mockDiskBackend.get.mockResolvedValue({ stream: mockStream });
      mockS3Backend.put.mockResolvedValue(void 0);
      mocks.storageMigration.updateUserProfileImagePath.mockResolvedValue(true);
      mocks.storageMigration.createLogEntry.mockResolvedValue({} as any);

      const result = await sut.handleMigration(userJob);

      expect(result).toBe(JobStatus.Success);
      expect(mocks.storageMigration.updateUserProfileImagePath).toHaveBeenCalledWith(
        'user-1',
        userJob.sourcePath,
        's3://default/profile/user/ab/cd/profile.jpg',
      );
    });
  });

  describe('rollback', () => {
    it('should revert paths from migration log and delete log entries', async () => {
      const entries = [
        {
          id: 'log-1',
          entityType: 'asset',
          entityId: 'asset-1',
          fileType: 'original',
          oldPath: 'file:///usr/src/app/upload/library/user/ab/cd/file.jpg',
          newPath: 's3://default/library/user/ab/cd/file.jpg',
          target: 's3://default',
          batchId: 'batch-1',
          createdAt: new Date(),
        },
        {
          id: 'log-2',
          entityType: 'assetFile',
          entityId: 'file-1',
          fileType: AssetFileType.Thumbnail,
          oldPath: 'file:///usr/src/app/upload/thumbs/user/ab/cd/thumb.webp',
          newPath: 's3://default/thumbs/user/ab/cd/thumb.webp',
          target: 's3://default',
          batchId: 'batch-1',
          createdAt: new Date(),
        },
      ];

      mocks.storageMigration.getLogEntriesByBatch.mockResolvedValue(entries as any);
      mocks.storageMigration.updateAssetOriginalPath.mockResolvedValue(true);
      mocks.storageMigration.updateAssetFilePath.mockResolvedValue(true);
      mocks.storageMigration.deleteLogEntriesByBatch.mockResolvedValue(undefined as any);

      const result = await sut.rollback('batch-1');

      expect(result).toEqual({ rolledBack: 2, failed: 0, total: 2 });
      // Rollback swaps newPath -> oldPath
      expect(mocks.storageMigration.updateAssetOriginalPath).toHaveBeenCalledWith(
        'asset-1',
        's3://default/library/user/ab/cd/file.jpg',
        'file:///usr/src/app/upload/library/user/ab/cd/file.jpg',
      );
      expect(mocks.storageMigration.updateAssetFilePath).toHaveBeenCalledWith(
        'file-1',
        's3://default/thumbs/user/ab/cd/thumb.webp',
        'file:///usr/src/app/upload/thumbs/user/ab/cd/thumb.webp',
      );
      expect(mocks.storageMigration.deleteLogEntriesByBatch).toHaveBeenCalledWith('batch-1');
    });

    it('should return zero counts when no entries found for batchId', async () => {
      mocks.storageMigration.getLogEntriesByBatch.mockResolvedValue([]);
      mocks.storageMigration.deleteLogEntriesByBatch.mockResolvedValue(undefined as any);

      const result = await sut.rollback('nonexistent-batch');

      expect(result).toEqual({ rolledBack: 0, failed: 0, total: 0 });
      expect(mocks.storageMigration.deleteLogEntriesByBatch).toHaveBeenCalledWith('nonexistent-batch');
    });

    it('should track failed rollbacks and NOT delete log entries if any fail', async () => {
      const entries = [
        {
          id: 'log-1',
          entityType: 'asset',
          entityId: 'asset-1',
          fileType: 'original',
          oldPath: 'file:///usr/src/app/upload/library/user/ab/cd/file.jpg',
          newPath: 's3://default/library/user/ab/cd/file.jpg',
          target: 's3://default',
          batchId: 'batch-1',
          createdAt: new Date(),
        },
        {
          id: 'log-2',
          entityType: 'asset',
          entityId: 'asset-2',
          fileType: 'original',
          oldPath: 'file:///usr/src/app/upload/library/user/ef/gh/file2.jpg',
          newPath: 's3://default/library/user/ef/gh/file2.jpg',
          target: 's3://default',
          batchId: 'batch-1',
          createdAt: new Date(),
        },
      ];

      mocks.storageMigration.getLogEntriesByBatch.mockResolvedValue(entries as any);
      // First succeeds, second fails due to concurrency conflict
      mocks.storageMigration.updateAssetOriginalPath.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      const result = await sut.rollback('batch-1');

      expect(result).toEqual({ rolledBack: 1, failed: 1, total: 2 });
      // Should NOT delete log entries when there are failures
      expect(mocks.storageMigration.deleteLogEntriesByBatch).not.toHaveBeenCalled();
    });

    it('should track failed rollbacks when updatePath throws an error', async () => {
      const entries = [
        {
          id: 'log-1',
          entityType: 'asset',
          entityId: 'asset-1',
          fileType: 'original',
          oldPath: 'file:///usr/src/app/upload/library/user/ab/cd/file.jpg',
          newPath: 's3://default/library/user/ab/cd/file.jpg',
          target: 's3://default',
          batchId: 'batch-1',
          createdAt: new Date(),
        },
      ];

      mocks.storageMigration.getLogEntriesByBatch.mockResolvedValue(entries as any);
      mocks.storageMigration.updateAssetOriginalPath.mockRejectedValue(new Error('DB error'));

      const result = await sut.rollback('batch-1');

      expect(result).toEqual({ rolledBack: 0, failed: 1, total: 1 });
      expect(mocks.storageMigration.deleteLogEntriesByBatch).not.toHaveBeenCalled();
    });
  });
});
