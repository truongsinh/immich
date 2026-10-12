# Storage Migration E2E Test

End-to-end test that validates migrating assets between local disk and S3 (MinIO) storage, and a library split
across several named S3 aliases (one MinIO bucket each).

## Running

```bash
cd e2e

# Full workflow, keep infrastructure up after run
./storage-migration.sh

# Full workflow, tear down infrastructure after run
./storage-migration.sh --cleanup

# Run a single phase (useful for debugging)
./storage-migration.sh --phase setup
./storage-migration.sh --phase migrate-to-s3
./storage-migration.sh --phase migrate-to-disk
./storage-migration.sh --phase split-aliases
./storage-migration.sh --phase unreachable-alias

# Show docker logs inline
./storage-migration.sh --verbose
```

## Phases

1. **setup** - Uploads test assets (image, live photo, person crop) to Immich running on local disk storage.
2. **migrate-to-s3** - Triggers migration from disk to S3 (MinIO), then validates the results.
3. **migrate-to-disk** - Triggers migration from S3 back to disk, then validates the results.
4. **video-trim-s3** - Uploads a video, forces a transcode, and trims it on an S3-backed server. Validates that
   the edited encoded video and its thumbnails are persisted to S3 under `_edited` keys, that the transcoded
   original is not overwritten, that nothing is left behind on local disk, that playback serves the trimmed
   video, and that undo removes the edited objects from the bucket. Covers gh#671.
5. **split-aliases** - Restarts the server with originals written to `s3://originals-eu` (bucket
   `immich-originals`) and generated files to `s3://previews-home` (bucket `immich-previews`). Uploads an image and
   checks that its original lands in the first bucket and its thumbnail and preview in the second, that download
   and view return the stored bytes unchanged, and that moving the originals to `s3://archive` (bucket
   `immich-archive`) with the migration job keeps the download byte-identical.
6. **unreachable-alias** - Restarts the server with the `previews-home` endpoint pointing at a host that does not
   resolve. Checks that the server starts, that the thumbnail on that alias fails with a 5xx and a log line naming
   its stored path, and that the original on the archive alias still downloads unchanged.

## What it validates (per migration direction)

- DB paths name their storage: `s3://default/<key>` (S3) or `file:///<path>` (disk)
- Assets accessible via Immich API (HTTP 200)
- Files exist in target storage (MinIO or disk) for all asset types:
  originals, thumbnails, previews, person thumbnails, profile images
- Files removed from source storage (`deleteSource: true`)
- Migration log entries created with the correct target and batch ID

## Known gaps

- No fullsize image testing
- No rollback endpoint testing
- No concurrent upload during migration testing
