/**
 * Gives every stored file path a storage scheme: an absolute disk path becomes `file://<path>` and a
 * relative S3 key becomes `s3://default/<key>`, the alias the legacy IMMICH_S3_* settings define.
 * The migration log's `direction` becomes the `target` URI the file was moved to.
 */
import { Kysely, sql } from 'kysely';

const STORED_PATH_COLUMNS = [
  { table: 'asset', column: 'originalPath' },
  { table: 'asset_file', column: 'path' },
  { table: 'person', column: 'thumbnailPath' },
  { table: 'user', column: 'profileImagePath' },
  { table: 'storage_migration_log', column: 'oldPath' },
  { table: 'storage_migration_log', column: 'newPath' },
  { table: 'integrity_report', column: 'path' },
];

// a path rewrite changes nothing a client syncs, so it must not bump every row's updateId
const UPDATED_AT_TRIGGERS: Record<string, string> = {
  asset: 'asset_updatedAt',
  asset_file: 'asset_file_updatedAt',
  person: 'person_updatedAt',
  user: 'user_updatedAt',
};

const rewrite = async (db: Kysely<any>, table: string, assignment: string) => {
  const trigger = UPDATED_AT_TRIGGERS[table];
  if (trigger) {
    await sql.raw(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`).execute(db);
  }
  await sql.raw(`UPDATE "${table}" SET ${assignment}`).execute(db);
  if (trigger) {
    await sql.raw(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`).execute(db);
  }
};

export async function up(db: Kysely<any>): Promise<void> {
  for (const { table, column } of STORED_PATH_COLUMNS) {
    await rewrite(
      db,
      table,
      `"${column}" = CASE WHEN "${column}" LIKE '/%' THEN 'file://' || "${column}" ELSE 's3://default/' || "${column}" END
       WHERE "${column}" <> '' AND "${column}" NOT LIKE 'file://%' AND "${column}" NOT LIKE 's3://%'`,
    );
  }

  await sql`ALTER TABLE "storage_migration_log" RENAME COLUMN "direction" TO "target"`.execute(db);
  await sql`
    UPDATE "storage_migration_log"
    SET "target" = CASE "target" WHEN 'toS3' THEN 's3://default' WHEN 'toDisk' THEN 'file://' ELSE "target" END
  `.execute(db);
}

// Only the two schemes the old format can express are stripped; a path on any other alias stays as it is.
export async function down(db: Kysely<any>): Promise<void> {
  for (const { table, column } of STORED_PATH_COLUMNS) {
    await rewrite(
      db,
      table,
      `"${column}" = CASE WHEN "${column}" LIKE 'file://%' THEN substr("${column}", 8) ELSE substr("${column}", 14) END
       WHERE "${column}" LIKE 'file://%' OR "${column}" LIKE 's3://default/%'`,
    );
  }

  await sql`
    UPDATE "storage_migration_log"
    SET "target" = CASE "target" WHEN 's3://default' THEN 'toS3' WHEN 'file://' THEN 'toDisk' ELSE "target" END
  `.execute(db);
  await sql`ALTER TABLE "storage_migration_log" RENAME COLUMN "target" TO "direction"`.execute(db);
}
