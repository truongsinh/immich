/**
 * The one-off data migration that gives every stored file path a storage scheme, and its down migration,
 * run against a real database seeded with paths in the format that predates schemes.
 */
import { Kysely, sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { AssetFileType, IntegrityReport } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ClusterGroupRepository } from 'src/repositories/cluster-group.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import {
  down as downMigration,
  up as upMigration,
} from 'src/schema/migrations-gallery/1798000000000-StoredPathsCarryStorageScheme.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;

const up = () => upMigration(db as unknown as Kysely<unknown>);
const down = () => downMigration(db as unknown as Kysely<unknown>);

const STORED_PATH_COLUMNS = [
  { table: 'asset', column: 'originalPath' },
  { table: 'asset_file', column: 'path' },
  { table: 'person', column: 'thumbnailPath' },
  { table: 'user', column: 'profileImagePath' },
  { table: 'storage_migration_log', column: 'oldPath' },
  { table: 'storage_migration_log', column: 'newPath' },
  { table: 'integrity_report', column: 'path' },
];

const OLD_FORMAT = [
  { old: '/data/library/admin/2024/IMG 1#?.jpg', schemed: 'file:///data/library/admin/2024/IMG 1#?.jpg' },
  { old: 'upload/admin/ab/cd/Ảnh 100%.jpg', schemed: 's3://default/upload/admin/ab/cd/Ảnh 100%.jpg' },
];
const ALREADY_SCHEMED = ['file:///data/library/admin/kept.jpg', 's3://archive/upload/admin/kept.jpg'];

const valuesOf = async (table: string, column: string) => {
  const { rows } = await sql<{ value: string }>`SELECT ${sql.ref(column)} AS value FROM ${sql.table(table)}`.execute(db);
  return rows.map(({ value }) => value).filter(Boolean);
};

const seed = async (path: string) => {
  const { ctx } = newMediumService(BaseService, {
    database: db,
    real: [AssetRepository, ClusterGroupRepository, PersonRepository, UserRepository],
    mock: [LoggingRepository],
  });
  const { user } = await ctx.newUser({ profileImagePath: path });
  const { asset } = await ctx.newAsset({ ownerId: user.id, originalPath: path });
  await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Thumbnail, path });
  await ctx.newPerson({ ownerId: user.id, thumbnailPath: path });
  await sql`
    INSERT INTO "storage_migration_log" ("entityType", "entityId", "fileType", "oldPath", "newPath", "direction", "batchId")
    VALUES ('asset', ${asset.id}, 'original', ${path}, ${path}, 'toS3', ${asset.id})
  `.execute(db);
  await sql`INSERT INTO "integrity_report" ("type", "path") VALUES (${IntegrityReport.UntrackedFile}, ${path})`.execute(db);
};

beforeAll(async () => {
  db = await getKyselyDB();
  await down();
  for (const path of [...OLD_FORMAT.map(({ old }) => old), ...ALREADY_SCHEMED]) {
    await seed(path);
  }
  await up();
});

describe('stored path scheme migration', () => {
  it.each(STORED_PATH_COLUMNS)(
    'gives every $table.$column a scheme: file:// for absolute paths, s3://default/ for keys',
    async ({ table, column }) => {
      const values = await valuesOf(table, column);

      expect(values.toSorted()).toEqual([...OLD_FORMAT.map(({ schemed }) => schemed), ...ALREADY_SCHEMED].toSorted());
    },
  );

  it('records the target each logged file was moved to', async () => {
    expect(await valuesOf('storage_migration_log', 'target')).toEqual(Array.from({ length: 4 }, () => 's3://default'));
  });

  it.each(STORED_PATH_COLUMNS)('restores the old $table.$column on the way down', async ({ table, column }) => {
    await down();
    try {
      const values = await valuesOf(table, column);

      expect(values).toEqual(expect.arrayContaining(OLD_FORMAT.map(({ old }) => old)));
    } finally {
      await up();
    }
  });
});
