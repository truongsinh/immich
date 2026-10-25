import { Injectable } from '@nestjs/common';
import { join } from 'node:path';
import type { PathType } from 'src/enum.js';
import type { EnvData } from 'src/repositories/config.repository.js';
import type { JobOf, SystemFlags } from 'src/types.js';
import { DiskStorageBackend } from 'src/backends/disk-storage.backend.js';
import { S3StorageBackend } from 'src/backends/s3-storage.backend.js';
import {
  StorageTarget,
  diskPathOf,
  resolveStoredPath,
  storageTargetUri,
} from 'src/backends/storage-backend.provider.js';
import { ErrorMessages } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  AssetFileType,
  AssetPathType,
  BootstrapEventPriority,
  DatabaseLock,
  JobName,
  JobStatus,
  QueueName,
  StorageFolder,
  SystemMetadataKey,
  UserPathType,
} from 'src/enum.js';
import { StorageBackend } from 'src/interfaces/storage-backend.interface.js';
import { BaseService } from 'src/services/base.service.js';
import { ImmichStartupError } from 'src/utils/misc.js';

const docsMessage = `Please see https://docs.immich.app/administration/system-integrity#folder-checks for more information.`;

const ORIGINALS: ReadonlySet<PathType> = new Set([AssetPathType.Original, AssetFileType.Sidecar, UserPathType.Profile]);

@Injectable()
export class StorageService extends BaseService {
  private static diskBackend: DiskStorageBackend;
  private static aliasBackends = new Map<string, S3StorageBackend>();
  private static writeTargets: EnvData['storage']['writeTargets'] = {
    originals: { type: 'disk' },
    derivatives: { type: 'disk' },
    encodedVideo: { type: 'disk' },
  };

  static getDiskBackend(): DiskStorageBackend {
    return StorageService.diskBackend;
  }

  static getAliasBackends(): ReadonlyMap<string, S3StorageBackend> {
    return StorageService.aliasBackends;
  }

  /** The backend and key behind a stored path; `disk` lets a caller keep disk I/O on its own repository. */
  static resolve(path: string, disk: StorageBackend = StorageService.getDiskBackend()) {
    return resolveStoredPath(path, { disk, aliases: StorageService.getAliasBackends() });
  }

  /** Where a new file of this kind is written: originals, sidecars and profile images; encoded video; other generated files. */
  static getWriteTarget(pathType: PathType): StorageTarget {
    if (ORIGINALS.has(pathType)) {
      return StorageService.writeTargets.originals;
    }
    return pathType === AssetFileType.EncodedVideo
      ? StorageService.writeTargets.encodedVideo
      : StorageService.writeTargets.derivatives;
  }

  /** Upload staging and backups always live on disk; the other folders only while their write target is disk. */
  private static isKeptOnDisk(folder: StorageFolder): boolean {
    switch (folder) {
      case StorageFolder.Library:
      case StorageFolder.Profile: {
        return StorageService.writeTargets.originals.type === 'disk';
      }
      case StorageFolder.Thumbnails: {
        return StorageService.writeTargets.derivatives.type === 'disk';
      }
      case StorageFolder.EncodedVideo: {
        return StorageService.writeTargets.encodedVideo.type === 'disk';
      }
      default: {
        return true;
      }
    }
  }

  private detectMediaLocation(): string {
    const envData = this.configRepository.getEnv();
    if (envData.storage.mediaLocation) {
      return envData.storage.mediaLocation;
    }

    const targets: string[] = [];
    const candidates = ['/data', '/usr/src/app/upload'];

    for (const candidate of candidates) {
      const isExists = this.storageRepository.existsSync(candidate);
      if (isExists) {
        targets.push(candidate);
      }
    }

    if (targets.length === 1) {
      return targets[0];
    }

    return '/usr/src/app/upload';
  }

  @OnEvent({ name: 'AppBootstrap', priority: BootstrapEventPriority.StorageService })
  async onBootstrap() {
    StorageCore.setMediaLocation(this.detectMediaLocation());

    const { storage } = this.configRepository.getEnv();
    StorageService.diskBackend = new DiskStorageBackend(StorageCore.getMediaLocation(), this.storageRepository);
    // building a client opens no connection, so an unreachable alias cannot hold up startup
    StorageService.aliasBackends = new Map(
      Object.entries(storage.aliases).map(([alias, config]) => [alias, new S3StorageBackend(config)]),
    );
    StorageService.writeTargets = storage.writeTargets;
    for (const [alias, config] of Object.entries(storage.aliases)) {
      this.logger.log(`Storage alias ${alias}: bucket ${config.bucket}, ${config.serveMode} mode`);
    }
    this.logger.log(
      `Storage write targets: originals ${storageTargetUri(storage.writeTargets.originals)}, derivatives ${storageTargetUri(storage.writeTargets.derivatives)}, encoded video ${storageTargetUri(storage.writeTargets.encodedVideo)}`,
    );

    await this.databaseRepository.withLock(DatabaseLock.SystemFileMounts, async () => {
      const flags =
        (await this.systemMetadataRepository.get(SystemMetadataKey.SystemFlags)) ||
        ({ mountChecks: {} } as SystemFlags);

      if (!flags.mountChecks) {
        flags.mountChecks = {};
      }

      let isUpdated = false;

      this.logger.log(`Verifying system mount folder checks, current state: ${JSON.stringify(flags)}`);

      try {
        // check each folder exists and is writable
        for (const folder of Object.values(StorageFolder)) {
          if (!StorageService.isKeptOnDisk(folder)) {
            continue;
          }

          if (!flags.mountChecks[folder]) {
            this.logger.log(`Writing initial mount file for the ${folder} folder`);
            await this.createMountFile(folder);
          }

          await this.verifyReadAccess(folder);
          await this.verifyWriteAccess(folder);

          if (flags.mountChecks[folder]) {
            continue;
          }

          flags.mountChecks[folder] = true;
          isUpdated = true;
        }

        if (isUpdated) {
          await this.systemMetadataRepository.set(SystemMetadataKey.SystemFlags, flags);
          this.logger.log('Successfully enabled system mount folders checks');
        }

        this.logger.log('Successfully verified system mount folder checks');
      } catch (error) {
        const envData = this.configRepository.getEnv();
        if (envData.storage.ignoreMountCheckErrors) {
          this.logger.error(error as Error);
          this.logger.warn('Ignoring mount folder errors');
        } else {
          throw error;
        }
      }
    });

    await this.databaseRepository.withLock(DatabaseLock.MediaLocation, async () => {
      const current = StorageCore.getMediaLocation();
      const samples = await this.assetRepository.getFileSamples();
      const savedValue = await this.systemMetadataRepository.get(SystemMetadataKey.MediaLocation);
      const path = samples.map((sample) => diskPathOf(sample.path)).find((diskPath) => diskPath !== undefined);
      if (path) {
        let previous = savedValue?.location || '';

        if (!previous && this.configRepository.getEnv().storage.mediaLocation) {
          previous = current;
        }

        if (!previous) {
          previous = '/usr/src/app/upload';
        }

        if (previous !== current) {
          this.logger.log(`Media location changed (from=${previous}, to=${current})`);

          if (!path.startsWith(previous)) {
            throw new Error(ErrorMessages.InconsistentMediaLocation);
          }

          this.logger.warn(
            `Detected a change to media location, performing an automatic migration of file paths from ${previous} to ${current}, this may take awhile`,
          );
          await this.databaseRepository.migrateFilePaths(previous, current);
        }
      }

      // Only set MediaLocation in systemMetadataRepository if needed
      if (savedValue?.location !== current) {
        await this.systemMetadataRepository.set(SystemMetadataKey.MediaLocation, { location: current });
      }
    });
  }

  @OnJob({ name: JobName.FileDelete, queue: QueueName.BackgroundTask })
  async handleDeleteFiles(job: JobOf<JobName.FileDelete>): Promise<JobStatus> {
    const { files } = job;

    // TODO: one job per file
    for (const file of files) {
      if (!file) {
        continue;
      }

      try {
        const { backend, key } = await this.resolveStored(file);
        await backend.delete(key);
      } catch (error: any) {
        this.logger.warn('Unable to remove file', error);
      }
    }

    return JobStatus.Success;
  }

  private async verifyReadAccess(folder: StorageFolder) {
    const { internalPath, externalPath } = this.getMountFilePaths(folder);
    try {
      await this.storageRepository.readFile(internalPath);
    } catch (error) {
      this.logger.error(`Failed to read (${internalPath}): ${error}`);
      throw new ImmichStartupError(`Failed to read: "${externalPath} (${internalPath}) - ${docsMessage}"`);
    }
  }

  private async createMountFile(folder: StorageFolder) {
    const { folderPath, internalPath, externalPath } = this.getMountFilePaths(folder);
    try {
      this.storageRepository.mkdirSync(folderPath);
      await this.storageRepository.createFile(internalPath, Buffer.from(Date.now().toString()));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        this.logger.warn('Found existing mount file, skipping creation');
        return;
      }
      this.logger.error(`Failed to create ${internalPath}: ${error}`);
      throw new ImmichStartupError(`Failed to create "${externalPath} - ${docsMessage}"`);
    }
  }

  private async verifyWriteAccess(folder: StorageFolder) {
    const { internalPath, externalPath } = this.getMountFilePaths(folder);
    try {
      await this.storageRepository.overwriteFile(internalPath, Buffer.from(Date.now().toString()));
    } catch (error) {
      this.logger.error(`Failed to write ${internalPath}: ${error}`);
      throw new ImmichStartupError(`Failed to write "${externalPath} - ${docsMessage}"`);
    }
  }

  private getMountFilePaths(folder: StorageFolder) {
    const folderPath = StorageCore.getBaseFolder(folder);
    const internalPath = join(folderPath, '.immich');
    const externalPath = `<UPLOAD_LOCATION>/${folder}/.immich`;

    return { folderPath, internalPath, externalPath };
  }
}
