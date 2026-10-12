import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const StorageMigrationTargetSchema = z
  .string()
  .regex(/^(file:\/\/|s3:\/\/[a-z0-9][a-z0-9-]*)$/)
  .describe('Storage to move files to: file:// for disk, or s3://<alias> for a configured S3 alias');

const StorageMigrationFileTypesSchema = z
  .object({
    originals: z.boolean().default(true).describe('Include original files'),
    thumbnails: z.boolean().default(true).describe('Include thumbnail files'),
    previews: z.boolean().default(true).describe('Include preview files'),
    fullsize: z.boolean().default(true).describe('Include full-size files'),
    encodedVideos: z.boolean().default(true).describe('Include encoded video files'),
    sidecars: z.boolean().default(true).describe('Include sidecar files'),
    personThumbnails: z.boolean().default(true).describe('Include person thumbnail files'),
    profileImages: z.boolean().default(true).describe('Include profile image files'),
  })
  .meta({ id: 'StorageMigrationFileTypesDto' });

const StorageMigrationStartSchema = z
  .object({
    target: StorageMigrationTargetSchema,
    deleteSource: z.boolean().default(false).describe('Delete source files after migration'),
    fileTypes: StorageMigrationFileTypesSchema.describe('File types to migrate'),
    concurrency: z.int().min(1).max(20).default(5).describe('Concurrency level'),
  })
  .meta({ id: 'StorageMigrationStartDto' });

const StorageMigrationEstimateQuerySchema = z
  .object({
    target: StorageMigrationTargetSchema,
  })
  .meta({ id: 'StorageMigrationEstimateQueryDto' });

const StorageMigrationBatchParamSchema = z
  .object({
    batchId: z.uuidv4().describe('Batch ID'),
  })
  .meta({ id: 'StorageMigrationBatchParamDto' });

export class StorageMigrationFileTypesDto extends createZodDto(StorageMigrationFileTypesSchema) {}
export class StorageMigrationStartDto extends createZodDto(StorageMigrationStartSchema) {}
export class StorageMigrationEstimateQueryDto extends createZodDto(StorageMigrationEstimateQuerySchema) {}
export class StorageMigrationBatchParamDto extends createZodDto(StorageMigrationBatchParamSchema) {}
