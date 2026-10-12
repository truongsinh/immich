# Storage Migration

Noodle Gallery has a built-in tool for moving files between disk and S3-compatible object storage. You name a target, either disk (`file://`) or a configured S3 alias (`s3://<alias>`), and every selected file that is not already there is moved to it: from disk to S3, from S3 back to disk, or from one S3 alias to another.

## Features

- Moves files to disk or to any configured S3 alias, including between two S3 aliases.
- You choose which file types to move: originals, thumbnails, previews, full-size images, encoded videos, sidecars, person thumbnails and profile images.
- An estimate before you start shows file counts and the data size to expect.
- An interrupted migration resumes. Start it again and the files already migrated are skipped.
- Running a migration several times is safe. Already-migrated files are detected and skipped.
- Every migration creates a batch ID, so you can roll a whole batch back to the original file paths.
- You set how many files migrate in parallel.
- Optimistic concurrency keeps the migration from colliding with files that are being uploaded while it runs.

## Prerequisites

1. Configure every S3 alias involved, as source or target, as described in the [S3 Storage documentation](/features/s3-storage). A migration to an alias that is not configured is refused.

2. Optionally point the write targets (`IMMICH_STORAGE_WRITE_ORIGINALS`, `IMMICH_STORAGE_WRITE_DERIVATIVES`) at the migration target, so files uploaded during the migration land there too. The migration itself does not depend on them.

3. Restart Gallery after changing environment variables.

## Using the Admin UI

### Starting a Migration

1. Go to **Administration > Storage Migration** in the web UI.
2. Enter the migration target: `file://` for disk, or `s3://<alias>` for a configured S3 alias (for example `s3://default`).
3. Click **Get Estimate** to see how many files will be migrated and the estimated data size.
4. Choose which file types to include (all are selected by default).
5. Set the concurrency level (default: 5). Higher values migrate faster but use more resources.
6. Choose whether to delete source files after successful migration.
7. Click **Start Migration**.

### Monitoring Progress

The status panel shows:

- Whether a migration is currently active
- Number of waiting, active, completed, and failed jobs

### Rolling Back

If you need to undo a migration:

1. Copy the **batch ID** from when the migration was started (shown in the UI and server logs).
2. Enter it in the **Rollback** section.
3. Click **Rollback**. This reverts all database path changes for that batch.

:::warning
Rollback only reverts the **database paths**. If you enabled "delete source files" during the migration, the original files are gone and rollback cannot bring them back. To fully revert, run a migration back to the original target.
:::

## Using the API

The migration tool exposes four API endpoints under `/storage-migration`:

### Get Estimate

```
GET /storage-migration/estimate?target=s3%3A%2F%2Fdefault
```

Returns the `target`, file counts by type for files not yet on that target, and the estimated total size in bytes.

### Start Migration

```
POST /storage-migration/start
Content-Type: application/json

{
  "target": "s3://default",
  "deleteSource": false,
  "concurrency": 5,
  "fileTypes": {
    "originals": true,
    "thumbnails": true,
    "previews": true,
    "fullsize": true,
    "encodedVideos": true,
    "sidecars": true,
    "personThumbnails": true,
    "profileImages": true
  }
}
```

Returns a `batchId` that can be used for rollback.

### Check Status

```
GET /storage-migration/status
```

Returns whether a migration is active and job counts.

### Rollback

```
POST /storage-migration/rollback/{batchId}
```

Reverts all path changes from the specified batch.

## Tips

- Back up your database before you start. The migration is built to be safe, but a backup is a cheap extra net.
- Start with a low concurrency (3 to 5) and raise it if your system handles it well.
- Leave "delete source" off for the first migration, so you can check that everything works before removing source files.
- Only one migration runs at a time. Starting a second one while the first is in progress returns an error.

## Technical Implementation

### Migration Log Table

Migrations are tracked in a dedicated `storage_migration_log` table:

```
┌─────────────────────────────┐
│   storage_migration_log     │
├─────────────────────────────┤
│ id (UUID PK)                │
│ entityType (varchar)        │  'asset', 'assetFile', 'person', 'user'
│ entityId (UUID)             │
│ fileType (varchar?)         │  'original', 'thumbnail', 'preview', etc.
│ oldPath (text)              │
│ newPath (text)              │
│ target (varchar)            │  'file://' or 's3://<alias>'
│ batchId (UUID, indexed)     │
│ migratedAt (timestamp)      │
└─────────────────────────────┘
```

Each migrated file gets one log row. The `batchId` groups every file from a single run, so rollback can work a whole batch at a time.

### Job Architecture

Migration uses BullMQ with a two-phase approach:

```
Admin clicks "Start"
        │
        ▼
┌───────────────────┐     ┌───────────────────┐
│ QueueAll job       │     │ Single job (×N)    │
│                   │     │                   │
│ Streams files from│────►│ 1. Check source   │
│ DB in batches of  │     │ 2. Check target   │
│ 1000, queues      │     │    (idempotency)  │
│ individual jobs   │     │ 3. Stream copy    │
│                   │     │ 4. Update DB path │
│ Sets concurrency  │     │ 5. Log migration  │
│ on the queue      │     │ 6. Delete source? │
└───────────────────┘     └───────────────────┘
```

The orchestrator job streams file records from 8 sources (assets, asset files by type, person thumbnails and user profile images), batches them and queues one migration job per file. Worker concurrency follows the value you set, from 1 to 20, default 5.

### Path Transformation

Every stored path names its storage (see [dual backend routing](/features/s3-storage#dual-backend-routing)), and the migration stores the new path with the target's scheme:

- Disk to S3: strip the media location prefix, so `file:///usr/src/app/upload/library/...` becomes `s3://<alias>/library/...`
- S3 to S3: keep the object key, so `s3://default/library/...` becomes `s3://archive/library/...`
- S3 to disk: join the key under the media location, so `s3://default/library/...` becomes `file:///usr/src/app/upload/library/...`

### Concurrency Safety

Each per-file job uses **optimistic concurrency** when updating the database: the UPDATE statement includes a WHERE clause matching the old path. If the path was changed by a concurrent upload or another migration job, the UPDATE affects 0 rows and the job logs a skip rather than corrupting data. This makes migrations safe to run while the system is serving live uploads.

### Rollback

Rollback reads every log entry for a given `batchId` and reverses each path update with the same optimistic concurrency pattern (UPDATE WHERE path = newPath, SET path = oldPath). If all reversals succeed, the log entries for that batch are deleted. If any fail, the log is kept for debugging. Rollback never moves files. It only reverts database paths, so if source files were deleted during the migration you need a migration back to the original target to bring the files back.
