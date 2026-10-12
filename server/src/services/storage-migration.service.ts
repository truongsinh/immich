import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { JobOf } from 'src/types.js';
import {
  StorageTarget,
  parseStorageTarget,
  storageTargetUri,
  toStorageUri,
} from 'src/backends/storage-backend.provider.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnJob } from 'src/decorators.js';
import { AssetFileType, JobName, JobStatus, QueueName } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { StorageService } from 'src/services/storage.service.js';

interface StorageMigrationFileTypes {
  originals: boolean;
  thumbnails: boolean;
  previews: boolean;
  fullsize: boolean;
  encodedVideos: boolean;
  sidecars: boolean;
  personThumbnails: boolean;
  profileImages: boolean;
}

@Injectable()
export class StorageMigrationService extends BaseService {
  /** The configured storage a migration moves files to, from `file://` or `s3://<alias>`. */
  private getTarget(uri: string): StorageTarget {
    let target: StorageTarget;
    try {
      target = parseStorageTarget(uri);
    } catch (error: any) {
      throw new BadRequestException(error.message);
    }

    if (target.type === 's3' && !StorageService.getAliasBackends().has(target.alias)) {
      throw new BadRequestException(`Storage alias "${target.alias}" is not configured`);
    }
    return target;
  }

  private async validateConnection(target: StorageTarget): Promise<void> {
    if (target.type === 'disk') {
      return;
    }

    try {
      await StorageService.getAliasBackends().get(target.alias)!.exists('__immich_connection_test__');
    } catch (error: any) {
      throw new BadRequestException(`S3 connection test failed for ${storageTargetUri(target)}: ${error.message}`);
    }
  }

  async getEstimate(targetUri: string) {
    const target = this.getTarget(targetUri);
    const [fileCounts, estimatedSizeBytes] = await Promise.all([
      this.storageMigrationRepository.getFileCounts(target),
      this.storageMigrationRepository.getOriginalsSizeEstimate(target),
    ]);

    const total =
      fileCounts.originals +
      fileCounts.thumbnails +
      fileCounts.previews +
      fileCounts.fullsize +
      fileCounts.sidecars +
      fileCounts.encodedVideos +
      fileCounts.personThumbnails +
      fileCounts.profileImages;

    return {
      target: storageTargetUri(target),
      fileCounts: { ...fileCounts, total },
      estimatedSizeBytes,
    };
  }

  async start(options: {
    target: string;
    deleteSource: boolean;
    fileTypes: StorageMigrationFileTypes;
    concurrency: number;
  }) {
    const target = this.getTarget(options.target);
    await this.validateConnection(target);

    const fileCounts = await this.storageMigrationRepository.getFileCounts(target);
    const total =
      fileCounts.originals +
      fileCounts.thumbnails +
      fileCounts.previews +
      fileCounts.fullsize +
      fileCounts.sidecars +
      fileCounts.encodedVideos +
      fileCounts.personThumbnails +
      fileCounts.profileImages;
    if (total === 0) {
      throw new BadRequestException('No files to migrate');
    }

    const isActive = await this.jobRepository.isActive(QueueName.StorageBackendMigration);
    if (isActive) {
      throw new BadRequestException('A storage migration is already in progress');
    }

    const batchId = randomUUID();

    await this.jobRepository.queue({
      name: JobName.StorageBackendMigrationQueueAll,
      data: { ...options, target: storageTargetUri(target), batchId },
    });

    return { batchId };
  }

  async getStatus() {
    const [isActive, counts] = await Promise.all([
      this.jobRepository.isActive(QueueName.StorageBackendMigration),
      this.jobRepository.getJobCounts(QueueName.StorageBackendMigration),
    ]);

    return { isActive, ...counts };
  }

  @OnJob({ name: JobName.StorageBackendMigrationQueueAll, queue: QueueName.StorageBackendMigration })
  async handleQueueAll(job: JobOf<JobName.StorageBackendMigrationQueueAll>): Promise<JobStatus> {
    const { deleteSource, fileTypes, concurrency, batchId } = job;

    const target = this.getTarget(job.target);
    this.jobRepository.setConcurrency(QueueName.StorageBackendMigration, concurrency);

    let totalQueued = 0;
    const batch: Array<{
      name: JobName.StorageBackendMigrationSingle;
      data: JobOf<JobName.StorageBackendMigrationSingle>;
    }> = [];

    const flushBatch = async () => {
      if (batch.length === 0) {
        return;
      }
      await this.jobRepository.queueAll([...batch]);
      totalQueued += batch.length;
      this.logger.log(`Queued ${totalQueued} files for migration`);
      batch.length = 0;
    };

    const enqueue = async (data: JobOf<JobName.StorageBackendMigrationSingle>) => {
      batch.push({ name: JobName.StorageBackendMigrationSingle, data });
      if (batch.length >= 1000) {
        await flushBatch();
      }
    };

    // Stream originals
    if (fileTypes.originals) {
      for await (const row of this.storageMigrationRepository.streamOriginals(target)) {
        await enqueue({
          entityType: 'asset',
          entityId: row.id,
          fileType: 'original',
          sourcePath: row.originalPath,
          batchId,
          target: job.target,
          deleteSource,
        });
      }
    }

    // Stream asset files (thumbnails, previews, fullsize, sidecars)
    const assetFileTypes: AssetFileType[] = [];
    if (fileTypes.thumbnails) {
      assetFileTypes.push(AssetFileType.Thumbnail);
    }
    if (fileTypes.previews) {
      assetFileTypes.push(AssetFileType.Preview);
    }
    if (fileTypes.fullsize) {
      assetFileTypes.push(AssetFileType.FullSize);
    }
    if (fileTypes.sidecars) {
      assetFileTypes.push(AssetFileType.Sidecar);
    }

    if (assetFileTypes.length > 0) {
      for await (const row of this.storageMigrationRepository.streamAssetFiles(target, assetFileTypes)) {
        await enqueue({
          entityType: 'assetFile',
          entityId: row.id,
          fileType: row.type,
          sourcePath: row.path,
          batchId,
          target: job.target,
          deleteSource,
        });
      }
    }

    // Stream encoded videos
    if (fileTypes.encodedVideos) {
      for await (const row of this.storageMigrationRepository.streamEncodedVideos(target)) {
        await enqueue({
          entityType: 'asset',
          entityId: row.assetId,
          fileType: 'encodedVideo',
          sourcePath: row.path,
          batchId,
          target: job.target,
          deleteSource,
        });
      }
    }

    // Stream person thumbnails
    if (fileTypes.personThumbnails) {
      for await (const row of this.storageMigrationRepository.streamPersonThumbnails(target)) {
        await enqueue({
          entityType: 'person',
          entityId: row.personGroupId,
          fileType: null,
          sourcePath: row.thumbnailPath,
          batchId,
          target: job.target,
          deleteSource,
        });
      }
    }

    // Stream profile images
    if (fileTypes.profileImages) {
      for await (const row of this.storageMigrationRepository.streamProfileImages(target)) {
        await enqueue({
          entityType: 'user',
          entityId: row.id,
          fileType: null,
          sourcePath: row.profileImagePath,
          batchId,
          target: job.target,
          deleteSource,
        });
      }
    }

    // Flush remaining
    await flushBatch();

    this.logger.log(`Finished queueing ${totalQueued} files for storage migration (batchId=${batchId})`);
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.StorageBackendMigrationSingle, queue: QueueName.StorageBackendMigration })
  async handleMigration(job: JobOf<JobName.StorageBackendMigrationSingle>): Promise<JobStatus> {
    const { entityType, entityId, fileType, sourcePath, batchId, deleteSource } = job;

    try {
      const target = this.getTarget(job.target);
      const source = StorageService.resolve(sourcePath);
      const targetPath = toStorageUri(target, this.getTargetKey(source.target, source.key, target));
      const destination = StorageService.resolve(targetPath);

      // Check source exists
      const sourceExists = await source.backend.exists(source.key);
      if (!sourceExists) {
        this.logger.warn(`Source file not found, skipping: ${sourcePath}`);
        return JobStatus.Skipped;
      }

      // Idempotency: check if target already exists
      const targetExists = await destination.backend.exists(destination.key);
      if (!targetExists) {
        // Copy: get stream from source, put to target
        const { stream } = await source.backend.get(source.key);
        await destination.backend.put(destination.key, stream);
      }

      // Update DB path with optimistic concurrency
      const updated = await this.updatePath(entityType, entityId, fileType, sourcePath, targetPath);
      if (!updated) {
        this.logger.warn(
          `Path was concurrently modified, skipping DB update: ${entityType}/${entityId} (${sourcePath} -> ${targetPath})`,
        );
        return JobStatus.Skipped;
      }

      // Write to migration log
      await this.storageMigrationRepository.createLogEntry({
        entityType,
        entityId,
        fileType,
        oldPath: sourcePath,
        newPath: targetPath,
        target: job.target,
        batchId,
      });

      // Optionally delete source
      if (deleteSource) {
        try {
          await source.backend.delete(source.key);
        } catch (error: any) {
          this.logger.warn(`Failed to delete source file after migration: ${sourcePath}: ${error.message}`);
        }
      }

      return JobStatus.Success;
    } catch (error: any) {
      this.logger.error(`Failed to migrate file ${sourcePath}: ${error.message}`, error.stack);
      return JobStatus.Failed;
    }
  }

  async rollback(batchId: string) {
    const entries = await this.storageMigrationRepository.getLogEntriesByBatch(batchId);

    let rolledBack = 0;
    let failed = 0;
    const total = entries.length;

    for (const entry of entries) {
      try {
        const updated = await this.updatePath(
          entry.entityType,
          entry.entityId,
          entry.fileType,
          entry.newPath,
          entry.oldPath,
        );
        if (updated) {
          rolledBack++;
        } else {
          this.logger.warn(
            `Rollback: path was concurrently modified for ${entry.entityType}/${entry.entityId}, skipping`,
          );
          failed++;
        }
      } catch (error: any) {
        this.logger.error(`Rollback failed for ${entry.entityType}/${entry.entityId}: ${error.message}`, error.stack);
        failed++;
      }
    }

    if (failed === 0) {
      await this.storageMigrationRepository.deleteLogEntriesByBatch(batchId);
    }

    return { rolledBack, failed, total };
  }

  /**
   * An S3 key mirrors the file's place under the media location, so a file keeps its key when it
   * moves between aliases and returns to the same disk path it came from.
   */
  private getTargetKey(source: StorageTarget, key: string, target: StorageTarget): string {
    const mediaLocation = StorageCore.getMediaLocation();
    if (target.type === 'disk') {
      return source.type === 'disk' ? key : join(mediaLocation, key);
    }
    if (source.type === 's3') {
      return key;
    }

    const prefix = mediaLocation.endsWith('/') ? mediaLocation : `${mediaLocation}/`;
    // a disk file outside the media location (an external library) keeps its absolute layout
    return key.startsWith(prefix) ? key.slice(prefix.length) : key.slice(1);
  }

  private async updatePath(
    entityType: string,
    entityId: string,
    fileType: string | null,
    oldPath: string,
    newPath: string,
  ): Promise<boolean> {
    switch (entityType) {
      case 'asset': {
        if (fileType === 'encodedVideo') {
          return this.storageMigrationRepository.updateAssetEncodedVideoPath(entityId, oldPath, newPath);
        }
        return this.storageMigrationRepository.updateAssetOriginalPath(entityId, oldPath, newPath);
      }
      case 'assetFile': {
        return this.storageMigrationRepository.updateAssetFilePath(entityId, oldPath, newPath);
      }
      case 'person': {
        return this.storageMigrationRepository.updatePersonThumbnailPath(entityId, oldPath, newPath);
      }
      case 'user': {
        return this.storageMigrationRepository.updateUserProfileImagePath(entityId, oldPath, newPath);
      }
      default: {
        this.logger.warn(`Unknown entity type: ${entityType}`);
        return false;
      }
    }
  }
}
