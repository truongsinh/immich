import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PNG } from 'pngjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));
const E2E_DIR = resolve(__dirname, '..');
const BASE_URL = 'http://127.0.0.1:2285/api';
const DB_URL = 'postgres://postgres:postgres@127.0.0.1:5435/immich';
const COMPOSE = 'docker compose -f docker-compose.yml -f docker-compose.storage-migration.yml';
// Must match the server container's IMMICH_MEDIA_LOCATION (default in Docker)
const MEDIA_LOCATION = '/usr/src/app/upload';
// Cross-phase state file (persists asset IDs, content hashes, user credentials)
const STATE_FILE = resolve(E2E_DIR, '.storage-migration-state.json');

// ---------------------------------------------------------------------------
// File Generators
// ---------------------------------------------------------------------------
let pngCounter = 0;

export function createPng(): Buffer {
  const r = pngCounter % 256;
  const g = Math.floor(pngCounter / 256) % 256;
  const b = Math.floor(pngCounter / 65_536) % 256;
  pngCounter++;

  const image = new PNG({ width: 1, height: 1 });
  image.data[0] = r;
  image.data[1] = g;
  image.data[2] = b;
  image.data[3] = 255;
  return PNG.sync.write(image);
}

export function createXmpSidecar(): Buffer {
  const xmp = `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:description>Test sidecar for storage migration e2e</dc:description>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>`;
  return Buffer.from(xmp, 'utf8');
}

// ---------------------------------------------------------------------------
// Cross-Phase State Helpers
// ---------------------------------------------------------------------------
function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function saveState(data: Record<string, unknown>): void {
  const existing = loadState();
  writeFileSync(STATE_FILE, JSON.stringify({ ...existing, ...data }, null, 2));
}

function loadState(): Record<string, any> {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  }
  return {};
}

// ---------------------------------------------------------------------------
// API Helpers
// ---------------------------------------------------------------------------
interface ApiOptions {
  body?: unknown;
  formData?: FormData;
  token?: string;
}

export async function api(method: string, path: string, opts?: ApiOptions): Promise<any> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {};

  if (opts?.token) {
    headers['Authorization'] = `Bearer ${opts.token}`;
  }

  let fetchBody: BodyInit | undefined;

  if (opts?.formData) {
    fetchBody = opts.formData;
  } else if (opts?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    fetchBody = JSON.stringify(opts.body);
  }

  const res = await fetch(url, { method, headers, body: fetchBody });

  const contentType = res.headers.get('content-type') ?? '';
  const responseBody = await (contentType.includes('application/json') ? res.json() : res.text());

  if (!res.ok) {
    throw new Error(`API ${method} ${path} failed: ${res.status} ${JSON.stringify(responseBody)}`);
  }

  return responseBody;
}

const ADMIN_EMAIL = 'admin@immich.cloud';
const ADMIN_PASSWORD = 'password';
const ADMIN_NAME = 'Admin';

export async function signUpAdmin(): Promise<string> {
  await api('POST', '/auth/admin-sign-up', {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: ADMIN_NAME },
  });
  const loginRes = await api('POST', '/auth/login', {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  return loginRes.accessToken;
}

export async function loginAdmin(): Promise<string> {
  const loginRes = await api('POST', '/auth/login', {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  return loginRes.accessToken;
}

export async function uploadAsset(
  token: string,
  filename: string,
  data: Buffer,
  sidecar?: Buffer,
  extraFields?: Record<string, string>,
): Promise<{ id: string; status: number }> {
  const form = new FormData();
  form.append('assetData', new Blob([new Uint8Array(data)]), filename);
  form.append('deviceAssetId', `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  form.append('deviceId', 'e2e-storage-migration');
  form.append('fileCreatedAt', new Date().toISOString());
  form.append('fileModifiedAt', new Date().toISOString());

  if (sidecar) {
    form.append('sidecarData', new Blob([new Uint8Array(sidecar)]), `${filename}.xmp`);
  }

  if (extraFields) {
    for (const [k, v] of Object.entries(extraFields)) {
      form.append(k, v);
    }
  }

  const url = `${BASE_URL}/assets`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  const body = await res.json();

  if (!res.ok) {
    throw new Error(`Upload asset failed: ${res.status} ${JSON.stringify(body)}`);
  }

  return { id: body.id, status: res.status };
}

export async function uploadProfileImage(token: string, data: Buffer): Promise<void> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(data)]), 'profile.png');

  await api('POST', '/users/profile-image', { formData: form, token });
}

export async function createUser(adminToken: string, email: string, password: string, name: string): Promise<string> {
  await api('POST', '/admin/users', {
    body: { email, password, name },
    token: adminToken,
  });
  const loginRes = await api('POST', '/auth/login', {
    body: { email, password },
  });
  return loginRes.accessToken;
}

export async function loginUser(email: string, password: string): Promise<string> {
  const loginRes = await api('POST', '/auth/login', {
    body: { email, password },
  });
  return loginRes.accessToken;
}

export async function downloadAssetOriginal(token: string, assetId: string): Promise<Buffer> {
  const res = await fetch(`${BASE_URL}/assets/${assetId}/original`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.ok(res.status === 200, `Expected 200 for asset ${assetId} original, got ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForProcessing(token: string, timeoutMs = 60_000): Promise<void> {
  await sleep(2000);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const jobs = await api('GET', '/jobs', { token });

    let allIdle = true;
    for (const [, queueData] of Object.entries(jobs) as [string, any][]) {
      const counts = queueData.jobCounts;
      if (counts && (counts.active > 0 || counts.waiting > 0 || counts.delayed > 0)) {
        allIdle = false;
        break;
      }
    }

    if (allIdle) {
      return;
    }

    await sleep(500);
  }

  throw new Error(`waitForProcessing timed out after ${timeoutMs}ms`);
}

interface MigrationOptions {
  deleteSource?: boolean;
  fileTypes?: Partial<{
    originals: boolean;
    thumbnails: boolean;
    previews: boolean;
    fullsize: boolean;
    encodedVideos: boolean;
    sidecars: boolean;
    personThumbnails: boolean;
    profileImages: boolean;
  }>;
  concurrency?: number;
}

const ALL_FILE_TYPES = {
  originals: true,
  thumbnails: true,
  previews: true,
  fullsize: true,
  encodedVideos: true,
  sidecars: true,
  personThumbnails: true,
  profileImages: true,
};

export async function startMigration(token: string, target: string, options?: MigrationOptions): Promise<string> {
  const body = {
    target,
    deleteSource: options?.deleteSource ?? true,
    fileTypes: { ...ALL_FILE_TYPES, ...options?.fileTypes },
    concurrency: options?.concurrency ?? 5,
  };

  const res = await api('POST', '/storage-migration/start', { body, token });
  return res.batchId;
}

export async function waitForMigration(token: string, timeoutMs = 120_000): Promise<void> {
  // BullMQ queue counts are ephemeral — fast-completing jobs may finish before
  // we can poll. Instead, poll until the queue is idle AND stays idle for a
  // stabilization period, indicating all jobs (including the orchestrator that
  // queues worker jobs) have completed.
  await sleep(5000);

  const deadline = Date.now() + timeoutMs;
  let idleSince: number | null = null;
  const stabilizationMs = 5000; // queue must be idle for this long

  while (Date.now() < deadline) {
    const status = await api('GET', '/storage-migration/status', { token });
    const active = status.active ?? 0;
    const waiting = status.waiting ?? 0;

    console.log(`  migration status: active=${active} waiting=${waiting} isActive=${status.isActive}`);

    const isIdle = !status.isActive && active === 0 && waiting === 0;

    if (isIdle) {
      if (idleSince === null) {
        idleSince = Date.now();
      } else if (Date.now() - idleSince >= stabilizationMs) {
        return;
      }
    } else {
      idleSince = null;
    }

    await sleep(1000);
  }

  throw new Error(`waitForMigration timed out after ${timeoutMs}ms`);
}

export async function setStorageTemplate(token: string, opts: { enabled?: boolean; template?: string }): Promise<void> {
  const config = await api('GET', '/system-config', { token });
  if (opts.enabled !== undefined) {
    config.storageTemplate.enabled = opts.enabled;
  }
  if (opts.template !== undefined) {
    config.storageTemplate.template = opts.template;
  }
  await api('PUT', '/system-config', { body: config, token });
}

export async function triggerQueueCommand(token: string, queueName: string): Promise<void> {
  await api('PUT', `/jobs/${queueName}`, { body: { command: 'start' }, token });
}

export async function countMoveHistory(assetId?: string): Promise<number> {
  const rows = assetId
    ? await queryDb<{ c: string }>('SELECT COUNT(*)::text c FROM move_history WHERE "entityId" = $1', [assetId])
    : await queryDb<{ c: string }>('SELECT COUNT(*)::text c FROM move_history');
  return Number(rows[0].c);
}

export function captureContainerLogsSince(service: string, sinceMs: number): string {
  // docker compose --since accepts ISO-8601 OR a relative duration (e.g. "42s").
  // Bare epoch seconds are NOT accepted — compute elapsed seconds.
  // Substring matches work regardless of JSON vs plaintext logger mode;
  // the warning text appears verbatim in either.
  const elapsedSec = Math.max(1, Math.ceil((Date.now() - sinceMs) / 1000));
  return execSync(`${COMPOSE} logs --since ${elapsedSec}s --no-color ${service}`, {
    cwd: E2E_DIR,
    timeout: 30_000,
    encoding: 'utf8',
  });
}

export function assertNoMoveEnoent(logs: string, phaseTag: string): void {
  const bad = logs.split('\n').filter((l) => l.includes('Unable to complete move') || /ENOENT.*rename/.test(l));
  assert.equal(bad.length, 0, `[${phaseTag}] unexpected ENOENT/move warnings:\n${bad.join('\n')}`);
}

// ---------------------------------------------------------------------------
// DB Helpers
// ---------------------------------------------------------------------------
let db: pg.Client;

export async function connectDb(): Promise<void> {
  db = new pg.Client(DB_URL);
  await db.connect();
}

export async function queryDb<T>(sql: string, params?: unknown[]): Promise<T[]> {
  const result = await db.query(sql, params);
  return result.rows as T[];
}

export async function disconnectDb(): Promise<void> {
  if (db) {
    await db.end();
  }
}

export interface MigrationState {
  assets: { id: string; originalPath: string }[];
  assetFiles: { id: string; path: string; type: string }[];
  persons: { id: string; thumbnailPath: string }[];
  users: { id: string; profileImagePath: string }[];
  migrationLogs: { id: string; entityType: string; target: string; batchId: string }[];
}

export async function captureState(): Promise<MigrationState> {
  const [assets, assetFiles, persons, users, migrationLogs] = await Promise.all([
    queryDb<{ id: string; originalPath: string }>('SELECT id, "originalPath" FROM asset ORDER BY id'),
    queryDb<{ id: string; path: string; type: string }>('SELECT id, path, type FROM asset_file ORDER BY id'),
    queryDb<{ id: string; thumbnailPath: string }>(
      'SELECT "personGroupId" AS id, "thumbnailPath" FROM person WHERE "thumbnailPath" != \'\' ORDER BY "personGroupId"',
    ),
    queryDb<{ id: string; profileImagePath: string }>(
      'SELECT id, "profileImagePath" FROM "user" WHERE "profileImagePath" != \'\' ORDER BY id',
    ),
    queryDb<{ id: string; entityType: string; target: string; batchId: string }>(
      'SELECT id, "entityType", target, "batchId" FROM storage_migration_log ORDER BY id',
    ),
  ]);

  return { assets, assetFiles, persons, users, migrationLogs };
}

// ---------------------------------------------------------------------------
// Docker Exec Helpers
// ---------------------------------------------------------------------------
export function dockerExec(service: string, cmd: string): string {
  const escaped = cmd.replaceAll("'", String.raw`'\''`);
  return execSync(`${COMPOSE} exec -T ${service} sh -c '${escaped}'`, {
    cwd: E2E_DIR,
    timeout: 30_000,
    encoding: 'utf8',
  }).trim();
}

// Stored paths name their storage: `file:///abs/path` on disk, `s3://<alias>/<key>` on an S3 alias.
export const ALIAS_BUCKETS: Record<string, string> = {
  default: 'immich-test',
  'originals-eu': 'immich-originals',
  'previews-home': 'immich-previews',
  archive: 'immich-archive',
};

export const isOnDisk = (path: string): boolean => path.startsWith('file:///');

export const isOnAlias = (path: string, alias = 'default'): boolean => path.startsWith(`s3://${alias}/`);

/** The object key of a stored `s3://` path. */
export const keyOf = (path: string): string => path.slice(path.indexOf('/', 's3://'.length) + 1);

/** The `mc` path of a stored `s3://` path, or of a bare key in the default bucket. */
export function minioObject(path: string): string {
  if (!path.startsWith('s3://')) {
    return `local/${ALIAS_BUCKETS.default}/${path}`;
  }
  const alias = path.slice('s3://'.length, path.indexOf('/', 's3://'.length));
  return `local/${ALIAS_BUCKETS[alias]}/${keyOf(path)}`;
}

/** The filesystem path of a stored `file://` path; a bare path is returned unchanged. */
export const diskPathOf = (path: string): string => (path.startsWith('file://') ? path.slice('file://'.length) : path);

export function minioFileExists(key: string): boolean {
  try {
    dockerExec('minio', `mc stat ${minioObject(key)}`);
    return true;
  } catch {
    return false;
  }
}

export function diskFileExists(path: string): boolean {
  try {
    dockerExec('immich-server', `test -f "${diskPathOf(path)}"`);
    return true;
  } catch {
    return false;
  }
}

export function minioReadFile(key: string): string {
  return dockerExec('minio', `mc cat ${minioObject(key)}`);
}

/** Raw bytes of a stored `s3://` object; `mc cat` through `dockerExec` would decode them as text. */
export function minioReadBytes(path: string): Buffer {
  return execSync(`${COMPOSE} exec -T minio mc cat ${minioObject(path)}`, { cwd: E2E_DIR, timeout: 30_000 });
}

export function minioSetupAlias(): void {
  dockerExec('minio', 'mc alias set local http://localhost:9000 minioadmin minioadmin');
}

export function minioCountPrefix(prefix: string): number {
  try {
    const out = dockerExec('minio', `mc ls --recursive local/immich-test/${prefix} 2>/dev/null | wc -l`);
    return Number(out);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Setup
// ---------------------------------------------------------------------------
async function phaseSetup(): Promise<void> {
  console.log('=== Phase 1: Setup ===');

  // Create admin user
  console.log('  Signing up admin...');
  const adminToken = await signUpAdmin();

  const contentHashes: Record<string, string> = {};

  // Upload test assets as admin
  console.log('  Uploading image asset...');
  const png1 = createPng();
  const asset1 = await uploadAsset(adminToken, 'test-image.png', png1);
  contentHashes[asset1.id] = sha256(png1);
  console.log(`  Uploaded asset: ${asset1.id}`);

  console.log('  Uploading image with XMP sidecar...');
  const png2 = createPng();
  const sidecar = createXmpSidecar();
  const asset2 = await uploadAsset(adminToken, 'test-sidecar.png', png2, sidecar);
  contentHashes[asset2.id] = sha256(png2);
  const sidecarHash = sha256(sidecar);
  console.log(`  Uploaded asset with sidecar: ${asset2.id}`);

  // Upload profile image for admin
  console.log('  Uploading profile image...');
  await uploadProfileImage(adminToken, createPng());

  // Create a person with a real thumbnail file
  console.log('  Creating person with thumbnail...');
  const person = await api('POST', '/people', { body: { name: 'Test Person' }, token: adminToken });
  console.log(`  Created person: ${person.id}`);

  dockerExec('immich-server', 'mkdir -p /usr/src/app/upload/thumbs');
  const pngBase64 = createPng().toString('base64');
  dockerExec('immich-server', `echo '${pngBase64}' | base64 -d > /usr/src/app/upload/thumbs/person-test.png`);
  await queryDb('UPDATE person SET "thumbnailPath" = $1 WHERE "personGroupId" = $2', [
    'file:///usr/src/app/upload/thumbs/person-test.png',
    person.id,
  ]);
  console.log('  Person thumbnail written and DB updated');

  // Create second user with their own assets
  console.log('  Creating second user...');
  const user2Email = 'user2@immich.cloud';
  const user2Password = 'password';
  const user2Token = await createUser(adminToken, user2Email, user2Password, 'User Two');

  console.log('  Uploading asset as second user...');
  const png3 = createPng();
  const asset3 = await uploadAsset(user2Token, 'user2-image.png', png3);
  contentHashes[asset3.id] = sha256(png3);
  console.log(`  Uploaded user2 asset: ${asset3.id}`);

  console.log('  Uploading profile image for second user...');
  await uploadProfileImage(user2Token, createPng());

  // Wait for processing (thumbnails, previews, etc.)
  console.log('  Waiting for job processing...');
  await waitForProcessing(adminToken);

  // Verify initial state
  console.log('  Capturing and verifying initial state...');
  const state = await captureState();

  assert.ok(state.assets.length >= 3, `Expected >= 3 assets, got ${state.assets.length}`);
  assert.ok(state.assetFiles.length > 0, `Expected > 0 asset files, got ${state.assetFiles.length}`);

  for (const asset of state.assets) {
    assert.ok(isOnDisk(asset.originalPath), `Asset originalPath is not on disk (file://): ${asset.originalPath}`);
  }
  for (const af of state.assetFiles) {
    assert.ok(isOnDisk(af.path), `AssetFile path is not on disk (file://): ${af.path}`);
  }
  for (const p of state.persons) {
    assert.ok(isOnDisk(p.thumbnailPath), `Person thumbnailPath is not on disk (file://): ${p.thumbnailPath}`);
  }
  for (const u of state.users) {
    if (u.profileImagePath) {
      assert.ok(isOnDisk(u.profileImagePath), `User profileImagePath is not on disk (file://): ${u.profileImagePath}`);
    }
  }

  // Verify multi-user: both users have profile images
  assert.ok(state.users.length >= 2, `Expected >= 2 users with profile images, got ${state.users.length}`);

  // Save state for later phases
  saveState({
    contentHashes,
    sidecarHash,
    sidecarAssetId: asset2.id,
    user2: { email: user2Email, password: user2Password },
    adminAssetIds: [asset1.id, asset2.id],
    user2AssetIds: [asset3.id],
  });

  console.log(`  Assets: ${state.assets.length}`);
  console.log(`  Asset files: ${state.assetFiles.length}`);
  console.log(`  Persons with thumbnails: ${state.persons.length}`);
  console.log(`  Users with profile images: ${state.users.length}`);
  console.log(`  Content hashes stored: ${Object.keys(contentHashes).length}`);
  console.log('=== Phase 1: Setup complete ===');
}

// ---------------------------------------------------------------------------
// Phase 2: Migrate to S3
// ---------------------------------------------------------------------------
async function phaseMigrateToS3(): Promise<void> {
  console.log('=== Phase 2: Migrate to S3 ===');

  // Login as both users (server was restarted, old sessions invalid)
  console.log('  Logging in as admin...');
  const token = await loginAdmin();
  const savedState = loadState();
  const user2Token = savedState.user2 ? await loginUser(savedState.user2.email, savedState.user2.password) : null;

  // Get migration estimate
  console.log('  Getting migration estimate...');
  const estimate = await api('GET', '/storage-migration/estimate?target=s3%3A%2F%2Fdefault', { token });
  const counts = estimate.fileCounts;
  console.log(
    `  Estimate: total=${counts.total} originals=${counts.originals ?? 0} thumbnails=${counts.thumbnails ?? 0}`,
  );
  assert.ok(counts.total > 0, `Expected estimate total > 0, got ${counts.total}`);

  // Start migration
  console.log('  Starting migration to S3...');
  const batchId = await startMigration(token, 's3://default');
  console.log(`  Batch ID: ${batchId}`);

  // Wait for migration to complete
  console.log('  Waiting for migration to complete...');
  await waitForMigration(token);

  // Set up minio mc alias
  console.log('  Setting up MinIO mc alias...');
  minioSetupAlias();

  // Validate
  console.log('  Capturing and validating post-migration state...');
  const state = await captureState();

  // DB paths should name the default S3 alias
  for (const asset of state.assets) {
    assert.ok(
      isOnAlias(asset.originalPath),
      `Asset originalPath should be on s3://default after S3 migration: ${asset.originalPath}`,
    );
  }
  for (const af of state.assetFiles) {
    assert.ok(isOnAlias(af.path), `AssetFile path should be on s3://default after S3 migration: ${af.path}`);
  }
  for (const p of state.persons) {
    assert.ok(
      isOnAlias(p.thumbnailPath),
      `Person thumbnailPath should be on s3://default after S3 migration: ${p.thumbnailPath}`,
    );
  }
  for (const u of state.users) {
    if (u.profileImagePath) {
      assert.ok(
        isOnAlias(u.profileImagePath),
        `User profileImagePath should be on s3://default after S3 migration: ${u.profileImagePath}`,
      );
    }
  }

  // Multi-user verification: both users' assets migrated
  if (savedState.adminAssetIds && savedState.user2AssetIds) {
    const allUploadedIds = [...savedState.adminAssetIds, ...savedState.user2AssetIds];
    for (const id of allUploadedIds) {
      const asset = state.assets.find((a: { id: string }) => a.id === id);
      assert.ok(asset, `Expected uploaded asset ${id} to exist in DB`);
      assert.ok(
        isOnAlias(asset.originalPath),
        `Uploaded asset ${id} should be on s3://default after S3 migration: ${asset.originalPath}`,
      );
    }
    console.log(`  Multi-user: all ${allUploadedIds.length} uploaded assets are on s3://default`);
  }

  // Multi-user verification: both users' profile images migrated
  assert.ok(
    state.users.length >= 2,
    `Expected >= 2 users with profile images after migration, got ${state.users.length}`,
  );
  for (const u of state.users) {
    if (u.profileImagePath) {
      assert.ok(
        isOnAlias(u.profileImagePath),
        `User ${u.id} profileImagePath should be on s3://default: ${u.profileImagePath}`,
      );
    }
  }

  // API access: admin can access their own assets
  if (savedState.adminAssetIds) {
    console.log('  Verifying API access to assets (admin)...');
    for (const id of savedState.adminAssetIds as string[]) {
      const res = await fetch(`${BASE_URL}/assets/${id}/original`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status !== 200) {
        const body = await res.text();
        assert.fail(`Expected 200 for admin asset ${id} original, got ${res.status}: ${body}`);
      }
      await res.arrayBuffer();
    }
  }

  // API access: user2 can access their own assets
  if (user2Token && savedState.user2AssetIds) {
    console.log('  Verifying API access to assets (user2)...');
    for (const id of savedState.user2AssetIds as string[]) {
      const res: Response = await fetch(`${BASE_URL}/assets/${id}/original`, {
        headers: { Authorization: `Bearer ${user2Token as string}` },
      });
      if (res.status !== 200) {
        const body = await res.text();
        assert.fail(`Expected 200 for user2 asset ${id} original, got ${res.status}: ${body}`);
      }
      await res.arrayBuffer();
    }
  }

  // Content integrity: download originals and compare SHA-256 hashes (each user downloads their own)
  if (savedState.contentHashes) {
    console.log('  Verifying content integrity (SHA-256)...');
    const adminIds = new Set(savedState.adminAssetIds as string[]);
    for (const [assetId, expectedHash] of Object.entries(savedState.contentHashes)) {
      const dlToken = adminIds.has(assetId) ? token : (user2Token ?? token);
      const content = await downloadAssetOriginal(dlToken, assetId);
      const actualHash = sha256(content);
      assert.equal(
        actualHash,
        expectedHash,
        `Content hash mismatch for asset ${assetId}: expected ${expectedHash}, got ${actualHash}`,
      );
    }
    console.log(`  Content integrity verified for ${Object.keys(savedState.contentHashes).length} assets`);
  }

  // MinIO files exist (originals, asset files, person thumbnails, profile images)
  console.log('  Verifying MinIO files exist...');
  for (const asset of state.assets) {
    assert.ok(minioFileExists(asset.originalPath), `Expected MinIO file to exist: ${asset.originalPath}`);
  }
  for (const af of state.assetFiles) {
    assert.ok(minioFileExists(af.path), `Expected MinIO asset file to exist: ${af.path}`);
  }
  for (const p of state.persons) {
    assert.ok(minioFileExists(p.thumbnailPath), `Expected MinIO person thumbnail to exist: ${p.thumbnailPath}`);
  }
  for (const u of state.users) {
    if (u.profileImagePath) {
      assert.ok(minioFileExists(u.profileImagePath), `Expected MinIO profile image to exist: ${u.profileImagePath}`);
    }
  }

  // Disk files gone (deleteSource: true)
  console.log('  Verifying disk files are removed...');
  for (const asset of state.assets) {
    assert.ok(
      !diskFileExists(`${MEDIA_LOCATION}/${keyOf(asset.originalPath)}`),
      `Expected disk file to be deleted: ${MEDIA_LOCATION}/${keyOf(asset.originalPath)}`,
    );
  }

  // Migration log validation
  const s3Logs = state.migrationLogs.filter((l) => l.target === 's3://default');
  assert.ok(s3Logs.length > 0, `Expected migration logs with target=s3://default, got ${s3Logs.length}`);
  const batchLogs = s3Logs.filter((l) => l.batchId === batchId);
  assert.ok(batchLogs.length > 0, `Expected migration logs with batchId=${batchId}, got ${batchLogs.length}`);

  // Save batchId for rollback phase
  saveState({ lastToS3BatchId: batchId });

  console.log(`  Assets: ${state.assets.length}, Asset files: ${state.assetFiles.length}`);
  console.log(`  Persons: ${state.persons.length}, Users with profile: ${state.users.length}`);
  console.log(`  Migration log entries (toS3): ${s3Logs.length}`);
  console.log('=== Phase 2: Migrate to S3 complete ===');
}

// ---------------------------------------------------------------------------
// Phase 3: Migrate to Disk
// ---------------------------------------------------------------------------
async function phaseMigrateToDisk(): Promise<void> {
  console.log('=== Phase 3: Migrate to Disk ===');

  // Login as both users
  console.log('  Logging in as admin...');
  const token = await loginAdmin();
  const savedState = loadState();
  const user2Token = savedState.user2 ? await loginUser(savedState.user2.email, savedState.user2.password) : null;

  // Start migration
  console.log('  Starting migration to disk...');
  const batchId = await startMigration(token, 'file://');
  console.log(`  Batch ID: ${batchId}`);

  // Wait for migration to complete
  console.log('  Waiting for migration to complete...');
  await waitForMigration(token);

  // Validate
  console.log('  Capturing and validating post-migration state...');
  const state = await captureState();

  // DB paths should name disk
  for (const asset of state.assets) {
    assert.ok(
      isOnDisk(asset.originalPath),
      `Asset originalPath should be on disk (file://) after disk migration: ${asset.originalPath}`,
    );
  }
  for (const af of state.assetFiles) {
    assert.ok(isOnDisk(af.path), `AssetFile path should be on disk (file://) after disk migration: ${af.path}`);
  }
  for (const p of state.persons) {
    assert.ok(
      isOnDisk(p.thumbnailPath),
      `Person thumbnailPath should be on disk (file://) after disk migration: ${p.thumbnailPath}`,
    );
  }
  for (const u of state.users) {
    if (u.profileImagePath) {
      assert.ok(
        isOnDisk(u.profileImagePath),
        `User profileImagePath should be on disk (file://) after disk migration: ${u.profileImagePath}`,
      );
    }
  }

  // Multi-user verification: both users' assets migrated back
  if (savedState.adminAssetIds && savedState.user2AssetIds) {
    const allUploadedIds = [...savedState.adminAssetIds, ...savedState.user2AssetIds];
    for (const id of allUploadedIds) {
      const asset = state.assets.find((a: { id: string }) => a.id === id);
      assert.ok(asset, `Expected uploaded asset ${id} to exist in DB`);
      assert.ok(
        isOnDisk(asset.originalPath),
        `Uploaded asset ${id} should be on disk (file://) after disk migration: ${asset.originalPath}`,
      );
    }
    console.log(`  Multi-user: all ${allUploadedIds.length} uploaded assets are on disk (file://)`);
  }

  // Multi-user verification: both users' profile images migrated back
  assert.ok(
    state.users.length >= 2,
    `Expected >= 2 users with profile images after migration, got ${state.users.length}`,
  );

  // API access: admin can access their own assets
  if (savedState.adminAssetIds) {
    console.log('  Verifying API access to assets (admin)...');
    for (const id of savedState.adminAssetIds as string[]) {
      const res = await fetch(`${BASE_URL}/assets/${id}/original`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status !== 200) {
        const body = await res.text();
        assert.fail(`Expected 200 for admin asset ${id} original, got ${res.status}: ${body}`);
      }
      await res.arrayBuffer();
    }
  }

  // API access: user2 can access their own assets
  if (user2Token && savedState.user2AssetIds) {
    console.log('  Verifying API access to assets (user2)...');
    for (const id of savedState.user2AssetIds as string[]) {
      const res: Response = await fetch(`${BASE_URL}/assets/${id}/original`, {
        headers: { Authorization: `Bearer ${user2Token as string}` },
      });
      if (res.status !== 200) {
        const body = await res.text();
        assert.fail(`Expected 200 for user2 asset ${id} original, got ${res.status}: ${body}`);
      }
      await res.arrayBuffer();
    }
  }

  // Content integrity: download originals and compare SHA-256 hashes (each user downloads their own)
  if (savedState.contentHashes) {
    console.log('  Verifying content integrity (SHA-256)...');
    const adminIds = new Set(savedState.adminAssetIds as string[]);
    for (const [assetId, expectedHash] of Object.entries(savedState.contentHashes)) {
      const dlToken = adminIds.has(assetId) ? token : (user2Token ?? token);
      const content = await downloadAssetOriginal(dlToken, assetId);
      const actualHash = sha256(content);
      assert.equal(
        actualHash,
        expectedHash,
        `Content hash mismatch for asset ${assetId}: expected ${expectedHash}, got ${actualHash}`,
      );
    }
    console.log(`  Content integrity verified for ${Object.keys(savedState.contentHashes).length} assets`);
  }

  // Disk files exist (originals, asset files, person thumbnails, profile images)
  console.log('  Verifying disk files exist...');
  for (const asset of state.assets) {
    assert.ok(diskFileExists(asset.originalPath), `Expected disk file to exist: ${asset.originalPath}`);
  }
  for (const af of state.assetFiles) {
    assert.ok(diskFileExists(af.path), `Expected disk asset file to exist: ${af.path}`);
  }
  for (const p of state.persons) {
    assert.ok(diskFileExists(p.thumbnailPath), `Expected disk person thumbnail to exist: ${p.thumbnailPath}`);
  }
  for (const u of state.users) {
    if (u.profileImagePath) {
      assert.ok(diskFileExists(u.profileImagePath), `Expected disk profile image to exist: ${u.profileImagePath}`);
    }
  }

  // MinIO files gone (deleteSource: true)
  console.log('  Setting up MinIO mc alias...');
  minioSetupAlias();

  console.log('  Verifying MinIO files are removed...');
  const mediaPrefix = new RegExp(`^${MEDIA_LOCATION}/`);
  for (const asset of state.assets) {
    const s3Key = diskPathOf(asset.originalPath).replace(mediaPrefix, '');
    assert.ok(!minioFileExists(s3Key), `Expected MinIO file to be deleted: ${s3Key}`);
  }

  // Migration log validation
  const diskLogs = state.migrationLogs.filter((l) => l.target === 'file://');
  assert.ok(diskLogs.length > 0, `Expected migration logs with target=file://, got ${diskLogs.length}`);

  // Save batchId for potential rollback testing
  saveState({ lastToDiskBatchId: batchId });

  console.log(`  Assets: ${state.assets.length}, Asset files: ${state.assetFiles.length}`);
  console.log(`  Persons: ${state.persons.length}, Users with profile: ${state.users.length}`);
  console.log(`  Migration log entries (toDisk): ${diskLogs.length}`);
  console.log('=== Phase 3: Migrate to Disk complete ===');
}

// ---------------------------------------------------------------------------
// Phase: Estimate Validation
// Precondition: files are on disk (run after setup or after migrate-to-disk)
// Backend: either disk or s3 (estimate is a DB query, no backend validation)
// ---------------------------------------------------------------------------
async function phaseEstimate(): Promise<void> {
  console.log('=== Phase: Estimate Validation ===');
  const token = await loginAdmin();

  // toS3 estimate: files are on disk, so should have counts
  console.log('  Getting toS3 estimate...');
  const toS3 = await api('GET', '/storage-migration/estimate?target=s3%3A%2F%2Fdefault', { token });
  console.log(
    `  toS3: total=${toS3.fileCounts.total} originals=${toS3.fileCounts.originals} thumbnails=${toS3.fileCounts.thumbnails} previews=${toS3.fileCounts.previews}`,
  );
  assert.ok(toS3.fileCounts.total > 0, `Expected toS3 total > 0, got ${toS3.fileCounts.total}`);
  assert.ok(
    toS3.fileCounts.originals >= 3,
    `Expected originals >= 3 (3 uploaded assets), got ${toS3.fileCounts.originals}`,
  );
  assert.ok(toS3.fileCounts.thumbnails > 0, `Expected thumbnails > 0, got ${toS3.fileCounts.thumbnails}`);
  assert.ok(toS3.fileCounts.previews > 0, `Expected previews > 0, got ${toS3.fileCounts.previews}`);
  assert.ok(
    toS3.fileCounts.personThumbnails > 0,
    `Expected personThumbnails > 0, got ${toS3.fileCounts.personThumbnails}`,
  );
  assert.ok(toS3.fileCounts.profileImages >= 2, `Expected profileImages >= 2, got ${toS3.fileCounts.profileImages}`);
  assert.ok(toS3.estimatedSizeBytes > 0, `Expected estimatedSizeBytes > 0, got ${toS3.estimatedSizeBytes}`);

  // Verify total matches sum of individual counts
  const expectedTotal =
    toS3.fileCounts.originals +
    toS3.fileCounts.thumbnails +
    toS3.fileCounts.previews +
    toS3.fileCounts.fullsize +
    toS3.fileCounts.sidecars +
    toS3.fileCounts.encodedVideos +
    toS3.fileCounts.personThumbnails +
    toS3.fileCounts.profileImages;
  assert.equal(toS3.fileCounts.total, expectedTotal, `Total ${toS3.fileCounts.total} != sum ${expectedTotal}`);

  // toDisk estimate: files are already on disk, so should be 0
  console.log('  Getting toDisk estimate...');
  const toDisk = await api('GET', '/storage-migration/estimate?target=file%3A%2F%2F', { token });
  console.log(`  toDisk: total=${toDisk.fileCounts.total}`);
  assert.equal(toDisk.fileCounts.total, 0, `Expected toDisk total = 0, got ${toDisk.fileCounts.total}`);
  assert.equal(toDisk.fileCounts.originals, 0, `Expected toDisk originals = 0, got ${toDisk.fileCounts.originals}`);

  // Save estimate for later comparison
  saveState({ initialEstimate: toS3 });

  console.log('=== Phase: Estimate Validation complete ===');
}

// ---------------------------------------------------------------------------
// Phase: Rollback
// Precondition: files are on S3 (run after migrate-to-s3)
// Backend: s3
// ---------------------------------------------------------------------------
async function phaseRollback(): Promise<void> {
  console.log('=== Phase: Rollback ===');
  const token = await loginAdmin();
  const savedState = loadState();

  const batchId = savedState.lastToS3BatchId;
  assert.ok(batchId, 'No lastToS3BatchId in state — run migrate-to-s3 first');

  // Capture pre-rollback state (paths should be on S3)
  const preState = await captureState();
  for (const asset of preState.assets) {
    assert.ok(
      isOnAlias(asset.originalPath),
      `Pre-rollback: asset path should be on s3://default: ${asset.originalPath}`,
    );
  }

  // Perform rollback
  console.log(`  Rolling back batch ${batchId}...`);
  const result = await api('POST', `/storage-migration/rollback/${batchId}`, { token });
  console.log(`  Rollback result: rolledBack=${result.rolledBack} failed=${result.failed} total=${result.total}`);

  assert.ok(result.total > 0, `Expected rollback total > 0, got ${result.total}`);
  assert.equal(result.failed, 0, `Expected 0 rollback failures, got ${result.failed}`);
  assert.equal(
    result.rolledBack,
    result.total,
    `Expected all ${result.total} entries rolled back, got ${result.rolledBack}`,
  );

  // Verify paths reverted to disk
  console.log('  Verifying paths reverted to disk...');
  const postState = await captureState();

  for (const asset of postState.assets) {
    assert.ok(
      isOnDisk(asset.originalPath),
      `Post-rollback: asset originalPath should be on disk: ${asset.originalPath}`,
    );
  }
  for (const af of postState.assetFiles) {
    assert.ok(isOnDisk(af.path), `Post-rollback: assetFile path should be on disk: ${af.path}`);
  }
  for (const p of postState.persons) {
    assert.ok(isOnDisk(p.thumbnailPath), `Post-rollback: person thumbnailPath should be on disk: ${p.thumbnailPath}`);
  }
  for (const u of postState.users) {
    if (u.profileImagePath) {
      assert.ok(
        isOnDisk(u.profileImagePath),
        `Post-rollback: user profileImagePath should be on disk: ${u.profileImagePath}`,
      );
    }
  }

  // Note: rollback only reverts DB paths, NOT file locations.
  // Files are still on S3, so API access via disk paths will fail until re-migrated.
  // This is expected — rollback is a DB-only operation.
  console.log('  Verifying files still exist in MinIO (rollback is DB-only)...');
  minioSetupAlias();
  for (const asset of preState.assets) {
    assert.ok(
      minioFileExists(asset.originalPath),
      `MinIO file should still exist after rollback: ${asset.originalPath}`,
    );
  }

  // Verify migration log entries were deleted (successful rollback cleans up)
  const logEntries = postState.migrationLogs.filter((l) => l.batchId === batchId);
  assert.equal(
    logEntries.length,
    0,
    `Expected migration logs for batch ${batchId} to be deleted after rollback, got ${logEntries.length}`,
  );

  // Verify rollback of already-rolled-back batch returns zero counts
  console.log('  Verifying double-rollback returns zero...');
  const doubleResult = await api('POST', `/storage-migration/rollback/${batchId}`, { token });
  assert.equal(doubleResult.total, 0, `Expected double-rollback total = 0, got ${doubleResult.total}`);
  assert.equal(doubleResult.rolledBack, 0, `Expected double-rollback rolledBack = 0, got ${doubleResult.rolledBack}`);

  console.log('=== Phase: Rollback complete ===');
}

// ---------------------------------------------------------------------------
// Phase: No Files to Migrate
// Precondition: all files are already on S3 (run after migrate-to-s3)
// Backend: s3
// ---------------------------------------------------------------------------
async function phaseNoFiles(): Promise<void> {
  console.log('=== Phase: No Files to Migrate ===');
  const token = await loginAdmin();

  // Verify estimate shows 0 files for toS3 (everything already there)
  const estimate = await api('GET', '/storage-migration/estimate?target=s3%3A%2F%2Fdefault', { token });
  console.log(`  toS3 estimate after migration: total=${estimate.fileCounts.total}`);
  assert.equal(estimate.fileCounts.total, 0, `Expected 0 files to migrate toS3, got ${estimate.fileCounts.total}`);

  // Verify toDisk estimate shows files (they're on S3, can be migrated back)
  const toDiskEstimate = await api('GET', '/storage-migration/estimate?target=file%3A%2F%2F', { token });
  console.log(`  toDisk estimate: total=${toDiskEstimate.fileCounts.total}`);
  assert.ok(toDiskEstimate.fileCounts.total > 0, `Expected toDisk total > 0, got ${toDiskEstimate.fileCounts.total}`);

  // Try starting toS3 migration — should fail with "No files to migrate"
  console.log('  Attempting toS3 migration (should fail)...');
  try {
    await startMigration(token, 's3://default');
    assert.fail('Expected startMigration to throw "No files to migrate"');
  } catch (error: any) {
    assert.ok(
      error.message.includes('No files to migrate'),
      `Expected "No files to migrate" error, got: ${error.message}`,
    );
    console.log('  Correctly rejected: No files to migrate');
  }

  console.log('=== Phase: No Files to Migrate complete ===');
}

// ---------------------------------------------------------------------------
// Phase: Concurrent Migration Rejection
// Precondition: files need migrating (run after setup, migrate-to-disk, or rollback)
// Backend: s3
// ---------------------------------------------------------------------------
async function phaseConcurrentRejection(): Promise<void> {
  console.log('=== Phase: Concurrent Migration Rejection ===');
  const token = await loginAdmin();

  // Start first migration with low concurrency to widen the race window
  console.log('  Starting first migration (concurrency=1)...');
  const batchId = await startMigration(token, 's3://default', { concurrency: 1 });
  console.log(`  First migration started: ${batchId}`);

  // Immediately try to start a second migration
  console.log('  Attempting second concurrent migration...');
  try {
    await startMigration(token, 's3://default', { concurrency: 1 });
    // If we get here, the first migration completed before our second call.
    // This is acceptable — verify the second one also completed.
    console.log('  Note: first migration completed before second call (race not caught)');
  } catch (error: any) {
    const msg = error.message;
    // Accept either "already in progress" (caught the race) or "No files to migrate" (first completed)
    assert.ok(
      msg.includes('already in progress') || msg.includes('No files to migrate'),
      `Expected concurrent rejection or no-files error, got: ${msg}`,
    );
    console.log(`  Second migration correctly rejected: ${msg}`);
  }

  // Wait for the first migration to complete
  console.log('  Waiting for migration to complete...');
  await waitForMigration(token);

  // Save the batchId
  saveState({ lastToS3BatchId: batchId });

  console.log('=== Phase: Concurrent Migration Rejection complete ===');
}

// ---------------------------------------------------------------------------
// Phase: Selective Migration (originals only)
// Precondition: files are on disk (run after setup or migrate-to-disk)
// Backend: s3
// ---------------------------------------------------------------------------
async function phaseSelectiveToS3(): Promise<void> {
  console.log('=== Phase: Selective Migration (originals only) ===');
  const token = await loginAdmin();

  // Capture pre-migration state
  const preState = await captureState();

  // Verify all paths are on disk
  for (const asset of preState.assets) {
    assert.ok(
      isOnDisk(asset.originalPath),
      `Pre-selective: asset originalPath should be on disk: ${asset.originalPath}`,
    );
  }

  // Start migration with ONLY originals enabled
  console.log('  Starting selective migration (originals only)...');
  const batchId = await startMigration(token, 's3://default', {
    fileTypes: {
      originals: true,
      thumbnails: false,
      previews: false,
      fullsize: false,
      encodedVideos: false,
      sidecars: false,
      personThumbnails: false,
      profileImages: false,
    },
  });
  console.log(`  Batch ID: ${batchId}`);

  await waitForMigration(token);

  // Verify post-migration state
  console.log('  Verifying selective migration results...');
  const postState = await captureState();

  // Originals should be on S3
  for (const asset of postState.assets) {
    assert.ok(
      isOnAlias(asset.originalPath),
      `After selective migration: asset originalPath should be on s3://default: ${asset.originalPath}`,
    );
  }

  // Asset files (thumbnails, previews) should still be on disk (NOT migrated)
  for (const af of postState.assetFiles) {
    assert.ok(
      isOnDisk(af.path),
      `After selective migration: assetFile path should still be on disk (not migrated): ${af.path}`,
    );
  }

  // Person thumbnails should still be on disk
  for (const p of postState.persons) {
    assert.ok(
      isOnDisk(p.thumbnailPath),
      `After selective migration: person thumbnailPath should still be on disk: ${p.thumbnailPath}`,
    );
  }

  // User profile images should still be on disk
  for (const u of postState.users) {
    if (u.profileImagePath) {
      assert.ok(
        isOnDisk(u.profileImagePath),
        `After selective migration: user profileImagePath should still be on disk: ${u.profileImagePath}`,
      );
    }
  }

  // Verify originals exist in MinIO
  console.log('  Verifying originals exist in MinIO...');
  minioSetupAlias();
  for (const asset of postState.assets) {
    assert.ok(minioFileExists(asset.originalPath), `Expected MinIO original to exist: ${asset.originalPath}`);
  }

  // Verify thumbnails still exist on disk
  console.log('  Verifying thumbnails still on disk...');
  for (const af of postState.assetFiles) {
    assert.ok(diskFileExists(af.path), `Expected disk asset file to still exist: ${af.path}`);
  }

  // Verify estimate: originals should be 0, but thumbnails/previews should remain
  const estimate = await api('GET', '/storage-migration/estimate?target=s3%3A%2F%2Fdefault', { token });
  console.log(
    `  Remaining toS3 estimate: total=${estimate.fileCounts.total} originals=${estimate.fileCounts.originals}`,
  );
  assert.equal(
    estimate.fileCounts.originals,
    0,
    `Expected 0 originals remaining, got ${estimate.fileCounts.originals}`,
  );
  assert.ok(
    estimate.fileCounts.total > 0,
    `Expected remaining files (thumbnails, etc.) > 0, got ${estimate.fileCounts.total}`,
  );

  // Migration log should only contain original-type entries
  const batchLogs = postState.migrationLogs.filter((l) => l.batchId === batchId);
  assert.ok(batchLogs.length > 0, `Expected migration logs for batch ${batchId}`);
  for (const log of batchLogs) {
    assert.equal(
      log.entityType,
      'asset',
      `Selective migration should only have asset entity type, got ${log.entityType}`,
    );
  }

  saveState({ selectiveBatchId: batchId });

  console.log('=== Phase: Selective Migration complete ===');
}

// ---------------------------------------------------------------------------
// Phase: Selective Cleanup (migrate remaining file types)
// Precondition: originals on S3, other files on disk (run after selective-to-s3)
// Backend: s3
// ---------------------------------------------------------------------------
async function phaseSelectiveCleanup(): Promise<void> {
  console.log('=== Phase: Selective Cleanup ===');
  const token = await loginAdmin();

  // Migrate remaining file types (everything except originals)
  console.log('  Starting cleanup migration (everything except originals)...');
  const batchId = await startMigration(token, 's3://default', {
    fileTypes: {
      originals: false,
      thumbnails: true,
      previews: true,
      fullsize: true,
      encodedVideos: true,
      sidecars: true,
      personThumbnails: true,
      profileImages: true,
    },
  });
  console.log(`  Batch ID: ${batchId}`);

  await waitForMigration(token);

  // Verify all paths are now on S3
  console.log('  Verifying all paths are on S3...');
  const state = await captureState();

  for (const asset of state.assets) {
    assert.ok(
      isOnAlias(asset.originalPath),
      `After cleanup: asset originalPath should be on s3://default: ${asset.originalPath}`,
    );
  }
  for (const af of state.assetFiles) {
    assert.ok(isOnAlias(af.path), `After cleanup: assetFile path should be on s3://default: ${af.path}`);
  }
  for (const p of state.persons) {
    assert.ok(
      isOnAlias(p.thumbnailPath),
      `After cleanup: person thumbnailPath should be on s3://default: ${p.thumbnailPath}`,
    );
  }
  for (const u of state.users) {
    if (u.profileImagePath) {
      assert.ok(
        isOnAlias(u.profileImagePath),
        `After cleanup: user profileImagePath should be on s3://default: ${u.profileImagePath}`,
      );
    }
  }

  // Verify estimate shows 0 for toS3
  const estimate = await api('GET', '/storage-migration/estimate?target=s3%3A%2F%2Fdefault', { token });
  assert.equal(estimate.fileCounts.total, 0, `Expected 0 remaining files, got ${estimate.fileCounts.total}`);

  saveState({ lastToS3BatchId: batchId });

  console.log('=== Phase: Selective Cleanup complete ===');
}

// ---------------------------------------------------------------------------
// Phase: Delete Source False
// Precondition: files are on disk (run after setup or migrate-to-disk)
// Backend: s3
// ---------------------------------------------------------------------------
async function phaseDeleteSourceFalse(): Promise<void> {
  console.log('=== Phase: Delete Source False ===');
  const token = await loginAdmin();

  // Capture pre-migration state (all on disk)
  const preState = await captureState();
  const diskPaths = preState.assets.map((a) => a.originalPath);
  for (const path of diskPaths) {
    assert.ok(isOnDisk(path), `Pre-migration: asset path should be on disk: ${path}`);
    assert.ok(diskFileExists(path), `Pre-migration: disk file should exist: ${path}`);
  }

  // Start migration with deleteSource=false
  console.log('  Starting migration with deleteSource=false...');
  const batchId = await startMigration(token, 's3://default', { deleteSource: false });
  console.log(`  Batch ID: ${batchId}`);

  await waitForMigration(token);

  // Verify DB paths are now on S3
  console.log('  Verifying DB paths updated to S3...');
  const postState = await captureState();
  for (const asset of postState.assets) {
    assert.ok(
      isOnAlias(asset.originalPath),
      `After migration: asset originalPath should be on s3://default: ${asset.originalPath}`,
    );
  }
  for (const af of postState.assetFiles) {
    assert.ok(isOnAlias(af.path), `After migration: assetFile path should be on s3://default: ${af.path}`);
  }

  // Verify S3 files exist
  console.log('  Verifying S3 files exist...');
  minioSetupAlias();
  for (const asset of postState.assets) {
    assert.ok(minioFileExists(asset.originalPath), `Expected MinIO file to exist: ${asset.originalPath}`);
  }
  for (const af of postState.assetFiles) {
    assert.ok(minioFileExists(af.path), `Expected MinIO asset file to exist: ${af.path}`);
  }

  // CRITICAL: Verify disk files ALSO still exist (deleteSource=false)
  console.log('  Verifying disk files still exist (deleteSource=false)...');
  for (const path of diskPaths) {
    assert.ok(diskFileExists(path), `Disk file should still exist after deleteSource=false migration: ${path}`);
  }

  // Also check asset files on disk
  for (const af of preState.assetFiles) {
    assert.ok(diskFileExists(af.path), `Disk asset file should still exist: ${af.path}`);
  }
  for (const p of preState.persons) {
    assert.ok(diskFileExists(p.thumbnailPath), `Disk person thumbnail should still exist: ${p.thumbnailPath}`);
  }
  for (const u of preState.users) {
    if (u.profileImagePath) {
      assert.ok(diskFileExists(u.profileImagePath), `Disk profile image should still exist: ${u.profileImagePath}`);
    }
  }

  // API access should work (served from S3 now) — each user accesses their own assets
  const savedStateLocal = loadState();
  if (savedStateLocal.adminAssetIds) {
    console.log('  Verifying API access works (admin)...');
    for (const id of savedStateLocal.adminAssetIds as string[]) {
      const res = await fetch(`${BASE_URL}/assets/${id}/original`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status !== 200) {
        const body = await res.text();
        assert.fail(`Expected 200 for admin asset ${id} original, got ${res.status}: ${body}`);
      }
      await res.arrayBuffer();
    }
  }

  saveState({ lastToS3BatchId: batchId });

  console.log('=== Phase: Delete Source False complete ===');
}

// ---------------------------------------------------------------------------
// Phase: Content Verification
// Precondition: files are on S3 (run after migrate-to-s3)
// Backend: s3
// ---------------------------------------------------------------------------
async function phaseContentVerify(): Promise<void> {
  console.log('=== Phase: Content Verification ===');
  const token = await loginAdmin();
  const savedState = loadState();

  assert.ok(savedState.contentHashes, 'No contentHashes in state — run setup first');

  const contentHashes: Record<string, string> = savedState.contentHashes;

  // Download every asset original via API and compare SHA-256 hashes (each user downloads their own)
  const adminIds = new Set(savedState.adminAssetIds as string[]);
  const user2Token = savedState.user2 ? await loginUser(savedState.user2.email, savedState.user2.password) : null;

  console.log(`  Verifying content integrity for ${Object.keys(contentHashes).length} assets...`);
  for (const [assetId, expectedHash] of Object.entries(contentHashes)) {
    const dlToken = adminIds.has(assetId) ? token : (user2Token ?? token);
    const content = await downloadAssetOriginal(dlToken, assetId);
    const actualHash = sha256(content);
    assert.equal(
      actualHash,
      expectedHash,
      `Content hash mismatch for asset ${assetId}: expected ${expectedHash}, got ${actualHash}`,
    );
    console.log(`  Asset ${assetId}: hash verified (${actualHash.slice(0, 12)}...)`);
  }

  // Verify thumbnail download works (via /assets/:id/thumbnail) — each user's own assets
  console.log('  Verifying thumbnail API access...');
  if (savedState.adminAssetIds) {
    for (const id of savedState.adminAssetIds as string[]) {
      const res = await fetch(`${BASE_URL}/assets/${id}/thumbnail`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.ok(res.status === 200, `Expected 200 for admin asset ${id} thumbnail, got ${res.status}`);
      const body = await res.arrayBuffer();
      assert.ok(body.byteLength > 0, `Expected non-empty thumbnail for asset ${id}`);
    }
  }
  if (user2Token && savedState.user2AssetIds) {
    for (const id of savedState.user2AssetIds as string[]) {
      const res = await fetch(`${BASE_URL}/assets/${id}/thumbnail`, {
        headers: { Authorization: `Bearer ${user2Token}` },
      });
      assert.ok(res.status === 200, `Expected 200 for user2 asset ${id} thumbnail, got ${res.status}`);
      const body = await res.arrayBuffer();
      assert.ok(body.byteLength > 0, `Expected non-empty thumbnail for asset ${id}`);
    }
  }

  // Range requests: this stack runs with IMMICH_S3_SERVE_MODE=proxy, so the server streams
  // the object itself instead of redirecting. It used to drop the Range header and answer
  // 200 with the whole body, which makes WebKit abort <video> playback and breaks seeking.
  const [rangeAssetId] = Object.keys(contentHashes);
  if (rangeAssetId) {
    const rangeToken = adminIds.has(rangeAssetId) ? token : (user2Token ?? token);
    const expected = await downloadAssetOriginal(rangeToken, rangeAssetId);

    console.log('  Verifying proxied range requests...');
    const partial = await fetch(`${BASE_URL}/assets/${rangeAssetId}/original`, {
      headers: { Authorization: `Bearer ${rangeToken}`, Range: 'bytes=0-9' },
    });
    assert.equal(partial.status, 206, `Expected 206 for a ranged proxy read, got ${partial.status}`);
    assert.equal(
      partial.headers.get('content-range'),
      `bytes 0-9/${expected.length}`,
      'Expected the proxied response to relay S3 Content-Range',
    );
    assert.equal(partial.headers.get('accept-ranges'), 'bytes', 'Expected the proxied response to accept ranges');
    assert.equal(partial.headers.get('content-length'), '10', 'Expected Content-Length to cover only the range');
    const partialBody = Buffer.from(await partial.arrayBuffer());
    assert.equal(partialBody.length, 10, `Expected 10 bytes, got ${partialBody.length}`);
    assert.ok(partialBody.equals(expected.subarray(0, 10)), 'Ranged bytes do not match the start of the object');

    // a suffix range: S3 resolves it, we relay it — nothing in the server parses ranges
    const suffix = await fetch(`${BASE_URL}/assets/${rangeAssetId}/original`, {
      headers: { Authorization: `Bearer ${rangeToken}`, Range: 'bytes=-5' },
    });
    assert.equal(suffix.status, 206, `Expected 206 for a suffix range, got ${suffix.status}`);
    const suffixBody = Buffer.from(await suffix.arrayBuffer());
    assert.ok(suffixBody.equals(expected.subarray(-5)), 'Suffix range bytes do not match the end of the object');

    // unsatisfiable ranges must surface as 416, not as a masked 404
    const unsatisfiable = await fetch(`${BASE_URL}/assets/${rangeAssetId}/original`, {
      headers: { Authorization: `Bearer ${rangeToken}`, Range: `bytes=${expected.length + 1000}-` },
    });
    assert.equal(unsatisfiable.status, 416, `Expected 416 for an unsatisfiable range, got ${unsatisfiable.status}`);
    console.log(`  Range requests verified (206 partial, suffix range, 416 unsatisfiable) for ${rangeAssetId}`);
  }

  console.log('=== Phase: Content Verification complete ===');
}

// ---------------------------------------------------------------------------
// Phase: Sidecar Verification
// Precondition: files are on S3 (run after migrate-to-s3)
// Backend: s3
// ---------------------------------------------------------------------------
async function phaseSidecarVerify(): Promise<void> {
  console.log('=== Phase: Sidecar Verification ===');
  const savedState = loadState();

  assert.ok(savedState.sidecarAssetId, 'No sidecarAssetId in state — run setup first');
  assert.ok(savedState.sidecarHash, 'No sidecarHash in state — run setup first');

  const sidecarAssetId: string = savedState.sidecarAssetId;
  const expectedHash: string = savedState.sidecarHash;

  // Find the sidecar file in the asset_files table
  const sidecarFiles = await queryDb<{ id: string; path: string; type: string }>(
    `SELECT af.id, af.path, af.type FROM asset_file af
     JOIN asset a ON af."assetId" = a.id
     WHERE a.id = $1 AND af.type = 'sidecar'`,
    [sidecarAssetId],
  );

  assert.ok(sidecarFiles.length > 0, `Expected sidecar file for asset ${sidecarAssetId}, found none`);
  const sidecarFile = sidecarFiles[0];
  console.log(`  Sidecar file: ${sidecarFile.path} (type: ${sidecarFile.type})`);

  // Verify path is on S3
  assert.ok(
    isOnAlias(sidecarFile.path),
    `Sidecar path should be on s3://default after S3 migration: ${sidecarFile.path}`,
  );

  // Verify sidecar exists in MinIO
  minioSetupAlias();
  assert.ok(minioFileExists(sidecarFile.path), `Expected MinIO sidecar to exist: ${sidecarFile.path}`);

  // Read sidecar content from MinIO and verify hash
  console.log('  Reading sidecar content from MinIO...');
  const sidecarContent = minioReadFile(sidecarFile.path);
  const actualHash = sha256(Buffer.from(sidecarContent, 'utf8'));
  assert.equal(actualHash, expectedHash, `Sidecar content hash mismatch: expected ${expectedHash}, got ${actualHash}`);

  // Verify the sidecar content is valid XMP
  assert.ok(
    sidecarContent.includes('x:xmpmeta'),
    `Sidecar should contain XMP metadata: ${sidecarContent.slice(0, 100)}`,
  );
  assert.ok(
    sidecarContent.includes('Test sidecar for storage migration e2e'),
    'Sidecar should contain our test description',
  );

  console.log('  Sidecar content verified: hash matches and XMP content valid');
  console.log('=== Phase: Sidecar Verification complete ===');
}

// ---------------------------------------------------------------------------
// Phase: Template bulk migration skips S3 assets (regression for #383)
// Precondition: S3 backend, assets already on S3
// ---------------------------------------------------------------------------
async function phaseTemplateS3BulkSkipped(): Promise<void> {
  console.log('=== Phase: template-s3-bulk-skipped ===');
  const token = await loginAdmin();
  await setStorageTemplate(token, { enabled: false }); // invariant reset
  const startMs = Date.now();
  const preCount = await countMoveHistory();
  const preState = await captureState();

  // Precondition: every asset has an S3 path
  for (const a of preState.assets) {
    assert.ok(isOnAlias(a.originalPath), `Precondition failed: asset ${a.id} path is on disk`);
  }

  try {
    await setStorageTemplate(token, { enabled: true, template: '{{y}}/{{MM}}/{{filename}}' });
    await triggerQueueCommand(token, 'storageTemplateMigration');
    await waitForProcessing(token);

    const postState = await captureState();

    // Every asset path unchanged
    for (const pre of preState.assets) {
      const post = postState.assets.find((a) => a.id === pre.id);
      assert.ok(post, `Asset ${pre.id} disappeared`);
      assert.equal(post.originalPath, pre.originalPath, `Path changed for asset ${pre.id}`);
    }

    // MinIO keys still exist
    minioSetupAlias();
    for (const a of postState.assets) {
      assert.ok(minioFileExists(a.originalPath), `MinIO key missing: ${a.originalPath}`);
    }

    // No new move_history rows
    const postCount = await countMoveHistory();
    assert.equal(postCount, preCount, `move_history grew from ${preCount} to ${postCount}`);

    // Log-scrape (secondary)
    const logs = captureContainerLogsSince('immich-server', startMs);
    assertNoMoveEnoent(logs, 'template-s3-bulk-skipped');

    console.log('  Bulk template migration skipped S3 assets cleanly.');
  } finally {
    await setStorageTemplate(token, { enabled: false });
  }
  console.log('=== Phase: template-s3-bulk-skipped complete ===');
}

async function phaseTemplateS3UploadSkipped(): Promise<void> {
  console.log('=== Phase: template-s3-upload-skipped ===');
  const token = await loginAdmin();
  await setStorageTemplate(token, { enabled: false });
  const startMs = Date.now();

  try {
    await setStorageTemplate(token, { enabled: true, template: '{{y}}/{{MMMM}}/{{filename}}' });

    const png = createPng();
    const { id: newAssetId } = await uploadAsset(token, 'template-upload-skip.png', png);
    await waitForProcessing(token);

    const rows = await queryDb<{ originalPath: string }>('SELECT "originalPath" FROM asset WHERE id = $1', [
      newAssetId,
    ]);
    assert.ok(rows[0], `Asset ${newAssetId} not found`);
    const { originalPath } = rows[0];

    assert.ok(isOnAlias(originalPath), `Expected an S3 path, got ${originalPath}`);
    assert.ok(originalPath.startsWith('upload/'), `Expected upload/ prefix, got ${originalPath}`);

    minioSetupAlias();
    assert.ok(minioFileExists(originalPath), `MinIO key missing: ${originalPath}`);

    const count = await countMoveHistory(newAssetId);
    assert.equal(count, 0, `Expected 0 move_history rows for new asset, got ${count}`);

    const logs = captureContainerLogsSince('immich-server', startMs);
    assertNoMoveEnoent(logs, 'template-s3-upload-skipped');

    console.log(`  New S3 upload ${newAssetId} stayed at ${originalPath}.`);
  } finally {
    await setStorageTemplate(token, { enabled: false });
  }
  console.log('=== Phase: template-s3-upload-skipped complete ===');
}

async function phaseTemplateS3LivePhotoSkipped(): Promise<void> {
  console.log('=== Phase: template-s3-live-photo-skipped ===');
  const token = await loginAdmin();
  await setStorageTemplate(token, { enabled: false });
  const startMs = Date.now();

  try {
    // Upload motion video first; then still with livePhotoVideoId linking to motion.
    // A valid video payload is required for a ffprobe-driven asset flow, but in e2e
    // the upload path only stores the bytes — metadata extraction handles the rest
    // and tolerates minimal MP4 headers. A 1x1 PNG stands in fine for the still.
    const motionBytes = Buffer.from([
      0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f,
      0x6d, 0x69, 0x73, 0x6f, 0x32, 0x61, 0x76, 0x63, 0x31, 0x6d, 0x70, 0x34, 0x31,
    ]);
    const { id: motionId } = await uploadAsset(token, 'lp-motion.mp4', motionBytes);
    const { id: stillId } = await uploadAsset(token, 'lp-still.png', createPng(), undefined, {
      livePhotoVideoId: motionId,
    });

    await setStorageTemplate(token, { enabled: true, template: '{{y}}/{{MM}}/{{filename}}' });
    await waitForProcessing(token);

    const rows = await queryDb<{ id: string; originalPath: string }>(
      'SELECT id, "originalPath" FROM asset WHERE id = ANY($1)',
      [[motionId, stillId]],
    );
    assert.equal(rows.length, 2, `Expected 2 assets, got ${rows.length}`);
    for (const r of rows) {
      assert.ok(isOnAlias(r.originalPath), `Expected an S3 path for ${r.id}, got ${r.originalPath}`);
      assert.ok(r.originalPath.startsWith('upload/'), `Expected upload/ prefix for ${r.id}`);
    }

    for (const id of [motionId, stillId]) {
      const c = await countMoveHistory(id);
      assert.equal(c, 0, `Asset ${id} has ${c} move_history rows, expected 0`);
    }

    const logs = captureContainerLogsSince('immich-server', startMs);
    assertNoMoveEnoent(logs, 'template-s3-live-photo-skipped');

    console.log(`  Live photo pair (still=${stillId}, motion=${motionId}) skipped template migration.`);
  } finally {
    await setStorageTemplate(token, { enabled: false });
  }
  console.log('=== Phase: template-s3-live-photo-skipped complete ===');
}

async function phaseTemplateS3SidecarSkipped(): Promise<void> {
  console.log('=== Phase: template-s3-sidecar-skipped ===');
  const token = await loginAdmin();
  const saved = loadState();
  assert.ok(saved.sidecarAssetId, 'No sidecarAssetId — run `setup` and `migrate-to-s3` first');
  const sidecarAssetId: string = saved.sidecarAssetId;

  await setStorageTemplate(token, { enabled: false });
  const startMs = Date.now();
  const preCount = await countMoveHistory(sidecarAssetId);

  const preRows = await queryDb<{ id: string; path: string }>(
    `SELECT af.id, af.path FROM asset_file af WHERE af."assetId" = $1 AND af.type = 'sidecar'`,
    [sidecarAssetId],
  );
  assert.equal(preRows.length, 1, `Expected 1 sidecar row, got ${preRows.length}`);
  const preSidecarPath = preRows[0].path;

  const preAssetRows = await queryDb<{ originalPath: string }>('SELECT "originalPath" FROM asset WHERE id = $1', [
    sidecarAssetId,
  ]);
  const preOriginalPath = preAssetRows[0].originalPath;

  try {
    await setStorageTemplate(token, { enabled: true, template: '{{y}}/{{MMMM}}/{{filename}}' });
    await triggerQueueCommand(token, 'storageTemplateMigration');
    await waitForProcessing(token);

    const postRows = await queryDb<{ path: string }>(`SELECT path FROM asset_file WHERE id = $1`, [preRows[0].id]);
    assert.equal(postRows[0].path, preSidecarPath, `Sidecar path changed`);

    const postAssetRows = await queryDb<{ originalPath: string }>('SELECT "originalPath" FROM asset WHERE id = $1', [
      sidecarAssetId,
    ]);
    assert.equal(postAssetRows[0].originalPath, preOriginalPath, `Original path changed`);

    const postCount = await countMoveHistory(sidecarAssetId);
    assert.equal(postCount, preCount, `move_history grew for ${sidecarAssetId}: ${preCount} → ${postCount}`);

    const logs = captureContainerLogsSince('immich-server', startMs);
    assertNoMoveEnoent(logs, 'template-s3-sidecar-skipped');

    console.log(`  Sidecar asset ${sidecarAssetId} and its .xmp row both unchanged.`);
  } finally {
    await setStorageTemplate(token, { enabled: false });
  }
  console.log('=== Phase: template-s3-sidecar-skipped complete ===');
}

async function phaseTemplateS3QueueMigrationSkipped(): Promise<void> {
  console.log('=== Phase: template-s3-queue-migration-skipped ===');
  const token = await loginAdmin();
  await setStorageTemplate(token, { enabled: false });
  const startMs = Date.now();

  const config = await api('GET', '/system-config', { token });
  const originalFormat: string = config.image.thumbnail.format;
  const flippedFormat = originalFormat === 'webp' ? 'jpeg' : 'webp';

  const preThumbs = await queryDb<{ id: string; path: string }>(
    `SELECT id, path FROM asset_file WHERE type = 'thumbnail'`,
  );
  const prePersons = await queryDb<{ id: string; thumbnailPath: string }>(
    `SELECT "personGroupId" AS id, "thumbnailPath" FROM person WHERE "thumbnailPath" != ''`,
  );

  try {
    // Flip thumbnail format
    const flipped = {
      ...config,
      image: { ...config.image, thumbnail: { ...config.image.thumbnail, format: flippedFormat } },
    };
    await api('PUT', '/system-config', { body: flipped, token });

    // Trigger FileMigrationQueueAll (fans out AssetFileMigration + PersonFileMigration)
    await triggerQueueCommand(token, 'migration');
    await waitForProcessing(token);

    // Thumbnails unchanged (still point at pre-flip extension — intended skip behavior)
    const postThumbs = await queryDb<{ id: string; path: string }>(
      `SELECT id, path FROM asset_file WHERE type = 'thumbnail'`,
    );
    assert.equal(postThumbs.length, preThumbs.length, `thumbnail row count changed`);
    for (const pre of preThumbs) {
      const post = postThumbs.find((r) => r.id === pre.id);
      assert.ok(post, `thumbnail row ${pre.id} disappeared`);
      assert.equal(post.path, pre.path, `thumbnail path changed for ${pre.id}`);
    }

    // Person thumbnails unchanged
    const postPersons = await queryDb<{ id: string; thumbnailPath: string }>(
      `SELECT "personGroupId" AS id, "thumbnailPath" FROM person WHERE "thumbnailPath" != ''`,
    );
    for (const pre of prePersons) {
      const post = postPersons.find((r) => r.id === pre.id);
      assert.ok(post, `person ${pre.id} thumbnailPath disappeared`);
      assert.equal(post.thumbnailPath, pre.thumbnailPath, `person ${pre.id} thumbnailPath changed`);
    }

    // Primary catch: no ENOENT from handleQueueMigration removeEmptyDirs on pure-S3
    const logs = captureContainerLogsSince('immich-server', startMs);
    assertNoMoveEnoent(logs, 'template-s3-queue-migration-skipped');

    console.log(`  Format flipped ${originalFormat}→${flippedFormat}; DB paths stable; no ENOENT.`);
  } finally {
    // Restore original thumbnail format
    const restore = await api('GET', '/system-config', { token });
    restore.image.thumbnail.format = originalFormat;
    await api('PUT', '/system-config', { body: restore, token });
  }
  console.log('=== Phase: template-s3-queue-migration-skipped complete ===');
}

async function phaseTemplateDiskBaseline(): Promise<void> {
  console.log('=== Phase: template-disk-baseline ===');
  const token = await loginAdmin();
  await setStorageTemplate(token, { enabled: false });
  const startMs = Date.now();

  // Set a predictable storageLabel on admin so library paths are stable.
  // Note: upload paths use userId (UUID), NOT storageLabel — only library paths use it.
  //
  // `PUT /users/me` does NOT accept storageLabel (UserUpdateMeDto omits it).
  // Use the admin endpoint `PUT /admin/users/:id` (UserAdminUpdateDto accepts storageLabel).
  // Admin users can update themselves via this endpoint.
  //
  // This write is idempotent — if a prior run on the same DB already set
  // storageLabel='admin', the re-update is a no-op from the asset path's
  // perspective. No teardown needed (last phase in the workflow).
  const me = await api('GET', '/users/me', { token });
  await api('PUT', `/admin/users/${me.id}`, { body: { storageLabel: 'admin' }, token });

  // Only assert against assets created in phaseSetup — later phases
  // (template-s3-upload-skipped, template-s3-live-photo-skipped) upload
  // additional test assets directly to S3 that end up with non-library
  // disk paths after migrate-to-disk, which is not the regression we're
  // guarding here.
  const saved = loadState();
  const seededIds: string[] = [...(saved.adminAssetIds ?? []), ...(saved.user2AssetIds ?? [])];
  assert.ok(seededIds.length > 0, 'No seeded asset IDs found — run `setup` first');

  const preCount = await countMoveHistory();
  const preState = await captureState();
  const preSeeded = preState.assets.filter((a) => seededIds.includes(a.id));
  assert.equal(
    preSeeded.length,
    seededIds.length,
    `Missing seeded assets in pre-state: expected ${seededIds.length}, got ${preSeeded.length}`,
  );

  // Every seeded asset is on disk post-rollback
  for (const a of preSeeded) {
    assert.ok(isOnDisk(a.originalPath), `Pre-baseline: seeded asset ${a.id} not on disk`);
  }
  const preAssetPaths = new Map(preSeeded.map((a) => [a.id, a.originalPath]));

  await setStorageTemplate(token, { enabled: true, template: '{{y}}/{{y}}-{{MM}}-{{dd}}/{{filename}}' });
  await triggerQueueCommand(token, 'storageTemplateMigration');
  await waitForProcessing(token);

  const postState = await captureState();
  const postSeeded = postState.assets.filter((a) => seededIds.includes(a.id));

  // Seeded assets land under library/<storageLabel-or-userUuid>/YYYY/YYYY-MM-DD/filename.
  // Per-user storageLabel: admin got 'admin'; user2 keeps their UUID in the path.
  const libraryTemplatePath = /\/usr\/src\/app\/upload\/library\/[^/]+\/\d{4}\/\d{4}-\d{2}-\d{2}\//;
  for (const a of postSeeded) {
    assert.ok(
      libraryTemplatePath.test(a.originalPath),
      `Expected library/<label>/YYYY/YYYY-MM-DD/ path, got ${a.originalPath}`,
    );
    assert.ok(diskFileExists(a.originalPath), `New disk path missing: ${a.originalPath}`);

    // Old path gone
    const prePath = preAssetPaths.get(a.id);
    assert.ok(prePath, `Seeded asset ${a.id} missing from pre-state`);
    if (prePath !== a.originalPath) {
      assert.ok(!diskFileExists(prePath), `Old disk path still exists: ${prePath}`);
    }
  }

  // Admin's storageLabel must have taken effect — at least one seeded asset under library/admin/.
  assert.ok(
    postSeeded.some((a) => a.originalPath.startsWith('/usr/src/app/upload/library/admin/')),
    'No seeded asset landed under library/admin/ — storageLabel=admin was not applied',
  );

  // Sidecar followed the asset
  if (saved.sidecarAssetId) {
    const sidecarAssetId: string = saved.sidecarAssetId;
    const asset = postSeeded.find((a) => a.id === sidecarAssetId);
    assert.ok(asset, 'Sidecar asset missing from post-state');
    const sidecar = postState.assetFiles.find((f) => f.type === 'sidecar' && f.path.startsWith(asset.originalPath));
    assert.ok(sidecar, `Sidecar .xmp did not follow asset to ${asset.originalPath}`);
  }

  // move_history returns to baseline (each successful move deletes its own row)
  const postCount = await countMoveHistory();
  assert.equal(postCount, preCount, `move_history delta: ${preCount} → ${postCount}`);

  const logs = captureContainerLogsSince('immich-server', startMs);
  assertNoMoveEnoent(logs, 'template-disk-baseline');

  console.log(`  Disk template migration moved ${postSeeded.length} seeded assets to library/…`);
  console.log('=== Phase: template-disk-baseline complete ===');
}

async function phaseCopyAssetSidecarS3(): Promise<void> {
  console.log('=== Phase: copy-asset-sidecar-s3 ===');
  const token = await loginAdmin();

  // createPng() resets its module counter each tsx invocation, so the first few PNGs of every
  // phase are deterministic (R=0,G=0,B=0 → test-image.png's checksum). Burn counter ahead so
  // our fixtures don't collide with setup or other phases via the server's checksum dedup.
  for (let i = 0; i < 200; i++) {
    createPng();
  }

  // Source: photo with XMP sidecar. Target: photo without.
  const { id: sourceId } = await uploadAsset(token, 'copy-sidecar-src.png', createPng(), createXmpSidecar());
  console.log(`  Uploaded source ${sourceId} (with sidecar)`);
  const { id: targetId } = await uploadAsset(token, 'copy-sidecar-dst.png', createPng());
  console.log(`  Uploaded target ${targetId} (no sidecar)`);

  // Drain metadata extraction so the sidecar row gets linked to the source asset.
  await waitForProcessing(token);
  console.log('  Processing drained');

  // Source must have exactly one sidecar row with an S3 path.
  const srcSidecarRows = await queryDb<{ path: string }>(
    `SELECT path FROM asset_file WHERE "assetId" = $1 AND type = 'sidecar'`,
    [sourceId],
  );
  assert.equal(srcSidecarRows.length, 1, `Expected source to have 1 sidecar row, got ${srcSidecarRows.length}`);
  assert.ok(isOnAlias(srcSidecarRows[0].path), `Expected source sidecar path on S3, got ${srcSidecarRows[0].path}`);

  // Target's originalPath must also be on S3 (proves backend config).
  const targetRows = await queryDb<{ originalPath: string }>(`SELECT "originalPath" FROM asset WHERE id = $1`, [
    targetId,
  ]);
  assert.ok(targetRows[0], `Target asset ${targetId} not found`);
  assert.ok(
    isOnAlias(targetRows[0].originalPath),
    `Expected target originalPath on S3, got ${targetRows[0].originalPath}`,
  );
  const targetSidecarKey = `${targetRows[0].originalPath}.xmp`;

  // Trigger copy with sidecar=true — this is the code path the bug fix targets.
  await api('PUT', '/assets/copy', { token, body: { sourceId, targetId, sidecar: true } });

  // Drain the AssetExtractMetadata job copySidecar queues.
  await waitForProcessing(token);

  // Target now has a sidecar row in asset_file, pointing at <targetOriginalPath>.xmp.
  const targetSidecarRows = await queryDb<{ path: string }>(
    `SELECT path FROM asset_file WHERE "assetId" = $1 AND type = 'sidecar'`,
    [targetId],
  );
  assert.equal(
    targetSidecarRows.length,
    1,
    `Expected target to have 1 sidecar row after copy, got ${targetSidecarRows.length}`,
  );
  assert.equal(
    targetSidecarRows[0].path,
    targetSidecarKey,
    `Expected target sidecar path ${targetSidecarKey}, got ${targetSidecarRows[0].path}`,
  );

  // Object must exist in MinIO AND be non-empty (cheap content guard).
  minioSetupAlias();
  assert.ok(minioFileExists(targetSidecarKey), `MinIO key missing: ${targetSidecarKey}`);
  const content = minioReadFile(targetSidecarKey);
  assert.ok(content.length > 0, `Sidecar in S3 is empty: ${targetSidecarKey}`);

  console.log(`  Copied sidecar from ${sourceId} → ${targetId} at ${targetSidecarKey} (${content.length} bytes).`);
  console.log('=== Phase: copy-asset-sidecar-s3 complete ===');
}

async function phaseUserDeleteS3Orphans(): Promise<void> {
  console.log('=== Phase: user-delete-s3-orphans ===');
  const adminToken = await loginAdmin();

  // Unique email per run so the phase is idempotent when re-run standalone against
  // a DB that already has a soft-deleted orphan-test user from a previous attempt.
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `orphan-test-${suffix}@example.com`;
  const password = 'orphanTest1234';

  const created = await api('POST', '/admin/users', {
    body: { email, password, name: 'Orphan Test User' },
    token: adminToken,
  });
  const userId: string = created.id;
  assert.ok(userId, 'Expected created user to have an id');

  const userToken = await loginUser(email, password);

  // Burn the createPng counter past any reuse overlap with other phases.
  for (let i = 0; i < 50; i++) {
    createPng();
  }
  const firstUpload = await uploadAsset(userToken, `orphan-${suffix}-1.png`, createPng());
  const secondUpload = await uploadAsset(userToken, `orphan-${suffix}-2.png`, createPng());
  assert.ok(firstUpload.id && secondUpload.id, 'Expected both uploads to return an id');

  await waitForProcessing(adminToken);

  minioSetupAlias();

  const uploadPrefix = `upload/${userId}/`;
  const profilePrefix = `profile/${userId}/`;
  const thumbsPrefix = `thumbs/${userId}/`;
  const encodedVideoPrefix = `encoded-video/${userId}/`;

  const preUpload = minioCountPrefix(uploadPrefix);
  const preThumbs = minioCountPrefix(thumbsPrefix);
  assert.ok(preUpload > 0, `Pre-delete: expected objects under ${uploadPrefix}, got ${preUpload}`);
  assert.ok(preThumbs > 0, `Pre-delete: expected objects under ${thumbsPrefix}, got ${preThumbs}`);
  console.log(
    `  Pre-delete: upload=${preUpload} thumbs=${preThumbs} profile=${minioCountPrefix(
      profilePrefix,
    )} encoded-video=${minioCountPrefix(encodedVideoPrefix)}`,
  );

  await api('DELETE', `/admin/users/${userId}`, { body: { force: true }, token: adminToken });

  await waitForProcessing(adminToken);

  const postUpload = minioCountPrefix(uploadPrefix);
  const postProfile = minioCountPrefix(profilePrefix);
  const postThumbs = minioCountPrefix(thumbsPrefix);
  const postEncodedVideo = minioCountPrefix(encodedVideoPrefix);
  assert.equal(postUpload, 0, `Post-delete: ${uploadPrefix} should be empty, got ${postUpload}`);
  assert.equal(postProfile, 0, `Post-delete: ${profilePrefix} should be empty, got ${postProfile}`);
  assert.equal(postThumbs, 0, `Post-delete: ${thumbsPrefix} should be empty, got ${postThumbs}`);
  assert.equal(postEncodedVideo, 0, `Post-delete: ${encodedVideoPrefix} should be empty, got ${postEncodedVideo}`);

  console.log(`  User ${userId} deleted; all 4 S3 prefixes report 0 objects.`);
  console.log('=== Phase: user-delete-s3-orphans complete ===');
}

// ---------------------------------------------------------------------------
// Phase: split-aliases
//
// One library split across two buckets: originals are written to the
// originals-eu alias, thumbnails and previews to previews-home. Both download
// and view must return the stored bytes unchanged, and moving the originals to
// a third alias (archive) with the migration job must keep the download intact.
//
// Runs with IMMICH_STORAGE_WRITE_ORIGINALS=s3://originals-eu and
// IMMICH_STORAGE_WRITE_DERIVATIVES=s3://previews-home.
// ---------------------------------------------------------------------------
async function fetchBytes(token: string, path: string): Promise<{ status: number; body: Buffer }> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
}

async function getSplitAssetPaths(assetId: string) {
  const [asset] = await queryDb<{ originalPath: string }>('SELECT "originalPath" FROM asset WHERE id = $1', [assetId]);
  const files = await queryDb<{ type: string; path: string }>(
    `SELECT type, path FROM asset_file WHERE "assetId" = $1 AND type IN ('thumbnail', 'preview') AND "isEdited" = false`,
    [assetId],
  );
  const pathOf = (type: string) => files.find((file) => file.type === type)?.path ?? '';
  return { originalPath: asset.originalPath, thumbnailPath: pathOf('thumbnail'), previewPath: pathOf('preview') };
}

async function phaseSplitAliases(): Promise<void> {
  console.log('=== Phase: split-aliases ===');
  const token = await loginAdmin();
  minioSetupAlias();

  for (let i = 0; i < 100; i++) {
    createPng();
  }
  const content = createPng();
  const { id } = await uploadAsset(token, 'split-aliases.png', content);
  await waitForProcessing(token);

  const before = await getSplitAssetPaths(id);
  console.log(`  original=${before.originalPath} thumbnail=${before.thumbnailPath} preview=${before.previewPath}`);
  assert.ok(isOnAlias(before.originalPath, 'originals-eu'), `Original not on originals-eu: ${before.originalPath}`);
  assert.ok(
    isOnAlias(before.thumbnailPath, 'previews-home'),
    `Thumbnail not on previews-home: ${before.thumbnailPath}`,
  );
  assert.ok(isOnAlias(before.previewPath, 'previews-home'), `Preview not on previews-home: ${before.previewPath}`);
  assert.ok(minioFileExists(before.originalPath), `Original missing from bucket A: ${before.originalPath}`);
  assert.ok(minioFileExists(before.thumbnailPath), `Thumbnail missing from bucket B: ${before.thumbnailPath}`);
  assert.ok(minioFileExists(before.previewPath), `Preview missing from bucket B: ${before.previewPath}`);
  assert.ok(
    !minioFileExists(`s3://previews-home/${keyOf(before.originalPath)}`),
    'Original must not also be in bucket B',
  );

  const original = await fetchBytes(token, `/assets/${id}/original`);
  assert.equal(original.status, 200, `Download returned ${original.status}`);
  assert.equal(sha256(original.body), sha256(content), 'Downloaded original differs from the upload');
  for (const [size, path] of [
    ['thumbnail', before.thumbnailPath],
    ['preview', before.previewPath],
  ]) {
    const view = await fetchBytes(token, `/assets/${id}/thumbnail?size=${size}`);
    assert.equal(view.status, 200, `View ${size} returned ${view.status}`);
    assert.equal(sha256(view.body), sha256(minioReadBytes(path)), `View ${size} differs from bucket B's object`);
  }

  console.log('  Moving originals from originals-eu to archive...');
  await startMigration(token, 's3://archive', {
    deleteSource: true,
    fileTypes: {
      originals: true,
      thumbnails: false,
      previews: false,
      fullsize: false,
      encodedVideos: false,
      sidecars: false,
      personThumbnails: false,
      profileImages: false,
    },
  });
  await waitForMigration(token);

  const after = await getSplitAssetPaths(id);
  assert.equal(after.originalPath, `s3://archive/${keyOf(before.originalPath)}`, 'Original not moved to archive');
  assert.ok(minioFileExists(after.originalPath), `Original missing from bucket C: ${after.originalPath}`);
  assert.ok(!minioFileExists(before.originalPath), `Original still in bucket A: ${before.originalPath}`);
  assert.equal(after.thumbnailPath, before.thumbnailPath, 'Thumbnail must stay on previews-home');

  const moved = await fetchBytes(token, `/assets/${id}/original`);
  assert.equal(moved.status, 200, `Download after move returned ${moved.status}`);
  assert.equal(sha256(moved.body), sha256(content), 'Downloaded original changed after the move');

  saveState({ splitAssetId: id, splitContentHash: sha256(content) });
  console.log('=== Phase: split-aliases complete ===');
}

// ---------------------------------------------------------------------------
// Phase: unreachable-alias
//
// Runs after split-aliases with the previews-home endpoint pointing at a host
// that does not resolve. The server must still start, a file on that alias must
// fail with a clean 5xx (logged with its stored path), and files on the other
// aliases must keep serving.
// ---------------------------------------------------------------------------
async function phaseUnreachableAlias(): Promise<void> {
  console.log('=== Phase: unreachable-alias ===');
  const startedAt = Date.now();
  const ping = await api('GET', '/server/ping');
  assert.equal(ping.res, 'pong', 'Server did not start with an unreachable alias');

  const token = await loginAdmin();
  const { splitAssetId: id, splitContentHash } = loadState();
  assert.ok(id, 'split-aliases must run first');
  const { thumbnailPath } = await getSplitAssetPaths(id);

  const thumbnail = await fetchBytes(token, `/assets/${id}/thumbnail?size=thumbnail`);
  assert.ok(thumbnail.status >= 500, `Thumbnail on the unreachable alias returned ${thumbnail.status}`);

  const original = await fetchBytes(token, `/assets/${id}/original`);
  assert.equal(original.status, 200, `Original on the reachable alias returned ${original.status}`);
  assert.equal(sha256(original.body), splitContentHash, 'Original on the reachable alias changed');

  const logs = captureContainerLogsSince('immich-server', startedAt);
  assert.ok(logs.includes(`Unable to serve ${thumbnailPath}`), `No clear log line for ${thumbnailPath}`);
  console.log('=== Phase: unreachable-alias complete ===');
}

// ---------------------------------------------------------------------------
// Phase: video-trim-s3
//
// Covers gh#671. Trims a video on an S3-backed server and asserts every output
// (edited encoded video + edited thumbnails) is persisted to MinIO under the
// default alias, that the non-edited encoded object is not overwritten, and that nothing
// is left behind on the pod's local disk.
//
// Runs with the server in s3 write mode. Leaves suite state as it found it, so
// the later migrate-to-disk phase is unaffected.
// ---------------------------------------------------------------------------
async function phaseVideoTrimS3(): Promise<void> {
  console.log('=== Phase: video-trim-s3 ===');
  const token = await loginAdmin();

  // Force transcoding so a NON-edited EncodedVideo exists in S3. That object is
  // the trim job's preferred input, and it is what makes gh#671's defect 3
  // (an S3 key handed straight to ffmpeg) reachable.
  const originalConfig = await api('GET', '/system-config', { token });
  const trimConfig = structuredClone(originalConfig);
  trimConfig.ffmpeg.transcode = 'all';
  await api('PUT', '/system-config', { body: trimConfig, token });
  console.log('  ffmpeg.transcode = all');

  // Cleanup runs even when an assertion fails: a half-finished run must not leave
  // encoded-video rows behind for the later migrate-to-disk phase to trip over.
  let assetId: string | undefined;

  try {
    // 4s test video, tiny frame size. Must be >= 2s or editAsset rejects the trim.
    //
    // -g 10 -keyint_min 10 -sc_threshold 0 puts a keyframe on every second (10fps).
    // MediaRepository.trim runs ffmpeg with `-c copy`, so its seek is keyframe-snapped:
    // with x264's default GOP a 4s clip has only the frame-0 keyframe, `-ss 1` would snap
    // back to 0, and the "2s" trim would come out 3.2s long. Real videos carry regular
    // keyframes; the fixture must too, or it tests a scenario that does not exist.
    const base64 = dockerExec(
      'immich-server',
      'ffmpeg -y -loglevel error -f lavfi -i testsrc=duration=4:size=192x144:rate=10 ' +
        '-c:v libx264 -pix_fmt yuv420p -g 10 -keyint_min 10 -sc_threshold 0 /tmp/trim-src.mp4 ' +
        String.raw`&& base64 /tmp/trim-src.mp4 | tr -d "\n"`,
    );
    const video = Buffer.from(base64, 'base64');
    assert.ok(video.length > 1000, `Generated video looks too small: ${video.length} bytes`);
    console.log(`  Generated test video (${video.length} bytes)`);

    const uploaded = await uploadAsset(token, 'trim-s3.mp4', video);
    assetId = uploaded.id;
    console.log(`  Uploaded asset ${assetId}`);
    await waitForProcessing(token, 120_000);

    // Precondition 1: duration was probed — editAsset rejects the trim without it.
    const assetRows = await queryDb<{ ownerId: string; duration: string | null; originalPath: string }>(
      'SELECT "ownerId", duration, "originalPath" FROM asset WHERE id = $1',
      [assetId],
    );
    assert.ok(assetRows[0], `Asset ${assetId} not found`);
    const { ownerId, originalPath } = assetRows[0];
    assert.ok(assetRows[0].duration, 'Asset duration was not probed — editAsset would reject the trim');
    assert.ok(isOnAlias(originalPath), `Expected S3 originalPath, got ${originalPath}`);

    // Precondition 2: a NON-edited EncodedVideo exists in S3.
    // NB: the asset_file.type enum value is 'encoded_video', not 'encodedVideo'.
    const encodedRows = await queryDb<{ path: string }>(
      `SELECT path FROM asset_file WHERE "assetId" = $1 AND type = 'encoded_video' AND "isEdited" = false`,
      [assetId],
    );
    assert.equal(encodedRows.length, 1, `Expected 1 non-edited encoded_video row, got ${encodedRows.length}`);
    const nonEditedKey = encodedRows[0].path;
    assert.ok(isOnAlias(nonEditedKey), `Expected an S3 encoded_video path, got ${nonEditedKey}`);
    assert.ok(minioFileExists(nonEditedKey), `Non-edited encoded video missing from MinIO: ${nonEditedKey}`);
    const nonEditedStatBefore = dockerExec('minio', `mc stat ${minioObject(nonEditedKey)}`);
    console.log(`  Precondition OK: transcoded video in S3 at ${nonEditedKey}`);

    // Act: trim 1s..3s out of the 4s video.
    await api('PUT', `/assets/${assetId}/edits`, {
      token,
      body: { edits: [{ action: 'trim', parameters: { startTime: 1, endTime: 3 } }] },
    });
    console.log('  Trim edit submitted');
    await waitForProcessing(token, 120_000);

    const editedRows = await queryDb<{ path: string; type: string }>(
      `SELECT path, type FROM asset_file WHERE "assetId" = $1 AND "isEdited" = true ORDER BY type`,
      [assetId],
    );
    assert.ok(
      editedRows.length >= 3,
      `Expected >= 3 edited asset_file rows (video + preview + thumbnail), got ${editedRows.length}`,
    );

    for (const row of editedRows) {
      assert.ok(isOnAlias(row.path), `Edited ${row.type} path must be an S3 key, got ${row.path}`);
      assert.ok(minioFileExists(row.path), `Edited ${row.type} missing from MinIO: ${row.path}`);
    }

    const editedVideo = editedRows.find((r) => r.type === 'encoded_video');
    assert.ok(editedVideo, 'No edited encoded_video row');
    const expectedKey = `encoded-video/${ownerId}/${assetId.slice(0, 2)}/${assetId.slice(2, 4)}/${assetId}_edited.mp4`;
    assert.equal(editedVideo.path, `s3://default/${expectedKey}`, 'Edited encoded video key mismatch');
    assert.notEqual(editedVideo.path, nonEditedKey, 'Edited video must not reuse the non-edited key');

    for (const row of editedRows) {
      if (row.type === 'encoded_video') {
        continue;
      }
      assert.ok(row.path.includes('_edited'), `Edited ${row.type} key must carry _edited: ${row.path}`);
    }

    // Collision guard: the transcoded original must be untouched.
    assert.ok(minioFileExists(nonEditedKey), 'Non-edited encoded video disappeared');
    const nonEditedStatAfter = dockerExec('minio', `mc stat ${minioObject(nonEditedKey)}`);
    assert.equal(nonEditedStatAfter, nonEditedStatBefore, 'Non-edited encoded video was overwritten by the trim');

    // No local leftovers: persistFile must upload AND unlink.
    const localEditedPath = `${MEDIA_LOCATION}/encoded-video/${ownerId}/${assetId.slice(0, 2)}/${assetId.slice(2, 4)}/${assetId}_edited.mp4`;
    assert.ok(!diskFileExists(localEditedPath), `Trimmed video left on local disk: ${localEditedPath}`);

    // Duration reflects the trim (~2s), not the original (4s). The trim is a `-c copy`
    // stream copy, so ffmpeg snaps to keyframes and the result is close to, not exactly,
    // the requested 2s — which is why handleVideoTrim re-probes the output instead of
    // trusting the requested duration. The window allows one keyframe interval of slack.
    const trimmedRows = await queryDb<{ duration: string | null }>('SELECT duration FROM asset WHERE id = $1', [
      assetId,
    ]);
    const durationMs = Number(trimmedRows[0].duration);
    assert.ok(
      durationMs >= 1500 && durationMs <= 2600,
      `Expected trimmed duration ~2000ms (keyframe-snapped), got ${trimmedRows[0].duration}`,
    );

    // Playback serves the trimmed video from S3.
    const playbackRes = await fetch(`${BASE_URL}/assets/${assetId}/video/playback`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(playbackRes.status, 200, `Expected 200 from playback, got ${playbackRes.status}`);
    await playbackRes.arrayBuffer();
    console.log('  Trim persisted to S3 and served');

    // Undo: the edited objects must be removed from the bucket.
    const editedKeys = editedRows.map((r) => r.path);
    await api('DELETE', `/assets/${assetId}/edits`, { token });
    await waitForProcessing(token, 120_000);

    for (const key of editedKeys) {
      assert.ok(!minioFileExists(key), `Undo left an edited object in MinIO: ${key}`);
    }

    const undoRes = await fetch(`${BASE_URL}/assets/${assetId}/video/playback`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(undoRes.status, 200, `Expected 200 from playback after undo, got ${undoRes.status}`);
    await undoRes.arrayBuffer();
    console.log('  Undo removed edited objects from S3');
  } finally {
    // Teardown: leave no trace for the later migrate-to-disk phase.
    if (assetId) {
      await api('DELETE', '/assets', { token, body: { ids: [assetId], force: true } });
      console.log(`  Asset ${assetId} deleted`);
    }
    await api('PUT', '/system-config', { body: originalConfig, token });
    console.log('  ffmpeg config restored');
  }

  console.log('=== Phase: video-trim-s3 complete ===');
}

// ---------------------------------------------------------------------------
// Phase: encoded-video-alias
//
// A video uploaded while encoded video has its own write target gets its
// transcode on that alias, while its thumbnail and preview stay on the
// derivatives alias.
//
// Runs with IMMICH_STORAGE_WRITE_DERIVATIVES=s3://previews-home and
// IMMICH_STORAGE_WRITE_ENCODED_VIDEO=s3://archive.
// ---------------------------------------------------------------------------
async function phaseEncodedVideoAlias(): Promise<void> {
  console.log('=== Phase: encoded-video-alias ===');
  const token = await loginAdmin();
  minioSetupAlias();
  const originalConfig = await api('GET', '/system-config', { token });
  const config = structuredClone(originalConfig);
  config.ffmpeg.transcode = 'all';
  await api('PUT', '/system-config', { body: config, token });

  let assetId: string | undefined;
  try {
    const base64 = dockerExec(
      'immich-server',
      'ffmpeg -y -loglevel error -f lavfi -i testsrc=duration=2:size=192x144:rate=10 ' +
        String.raw`-c:v libx264 -pix_fmt yuv420p /tmp/encoded-alias.mp4 && base64 /tmp/encoded-alias.mp4 | tr -d "\n"`,
    );
    ({ id: assetId } = await uploadAsset(token, 'encoded-video-alias.mp4', Buffer.from(base64, 'base64')));
    await waitForProcessing(token, 120_000);

    const files = await queryDb<{ type: string; path: string }>(
      `SELECT type, path FROM asset_file WHERE "assetId" = $1 AND "isEdited" = false`,
      [assetId],
    );
    const pathOf = (type: string) => files.find((file) => file.type === type)?.path ?? '';
    console.log(`  encoded_video=${pathOf('encoded_video')} thumbnail=${pathOf('thumbnail')}`);
    assert.ok(isOnAlias(pathOf('encoded_video'), 'archive'), `Transcode not on archive: ${pathOf('encoded_video')}`);
    assert.ok(minioFileExists(pathOf('encoded_video')), `Transcode missing from the archive bucket`);
    for (const type of ['thumbnail', 'preview']) {
      assert.ok(isOnAlias(pathOf(type), 'previews-home'), `${type} not on previews-home: ${pathOf(type)}`);
    }
    const playback = await fetchBytes(token, `/assets/${assetId}/video/playback`);
    assert.equal(playback.status, 200, `Playback returned ${playback.status}`);
    assert.equal(
      sha256(playback.body),
      sha256(minioReadBytes(pathOf('encoded_video'))),
      'Playback differs from the object',
    );
  } finally {
    if (assetId) {
      await api('DELETE', '/assets', { token, body: { ids: [assetId], force: true } });
    }
    await api('PUT', '/system-config', { body: originalConfig, token });
  }

  console.log('=== Phase: encoded-video-alias complete ===');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const phase = process.argv[2];
  if (!phase) {
    throw new Error('Usage: storage-migration.ts <setup|migrate-to-s3|migrate-to-disk>');
  }

  try {
    await connectDb();

    switch (phase) {
      case 'setup': {
        await phaseSetup();
        break;
      }
      case 'estimate': {
        await phaseEstimate();
        break;
      }
      case 'migrate-to-s3': {
        await phaseMigrateToS3();
        break;
      }
      case 'migrate-to-disk': {
        await phaseMigrateToDisk();
        break;
      }
      case 'rollback': {
        await phaseRollback();
        break;
      }
      case 'no-files': {
        await phaseNoFiles();
        break;
      }
      case 'concurrent-rejection': {
        await phaseConcurrentRejection();
        break;
      }
      case 'selective-to-s3': {
        await phaseSelectiveToS3();
        break;
      }
      case 'selective-cleanup': {
        await phaseSelectiveCleanup();
        break;
      }
      case 'delete-source-false': {
        await phaseDeleteSourceFalse();
        break;
      }
      case 'content-verify': {
        await phaseContentVerify();
        break;
      }
      case 'sidecar-verify': {
        await phaseSidecarVerify();
        break;
      }
      case 'template-s3-bulk-skipped': {
        await phaseTemplateS3BulkSkipped();
        break;
      }
      case 'template-s3-upload-skipped': {
        await phaseTemplateS3UploadSkipped();
        break;
      }
      case 'template-s3-live-photo-skipped': {
        await phaseTemplateS3LivePhotoSkipped();
        break;
      }
      case 'template-s3-sidecar-skipped': {
        await phaseTemplateS3SidecarSkipped();
        break;
      }
      case 'template-s3-queue-migration-skipped': {
        await phaseTemplateS3QueueMigrationSkipped();
        break;
      }
      case 'template-disk-baseline': {
        await phaseTemplateDiskBaseline();
        break;
      }
      case 'copy-asset-sidecar-s3': {
        await phaseCopyAssetSidecarS3();
        break;
      }
      case 'user-delete-s3-orphans': {
        await phaseUserDeleteS3Orphans();
        break;
      }
      case 'video-trim-s3': {
        await phaseVideoTrimS3();
        break;
      }
      case 'split-aliases': {
        await phaseSplitAliases();
        break;
      }
      case 'encoded-video-alias': {
        await phaseEncodedVideoAlias();
        break;
      }
      case 'unreachable-alias': {
        await phaseUnreachableAlias();
        break;
      }
      default: {
        throw new Error(
          `Unknown phase: ${phase}. Valid phases: setup, estimate, migrate-to-s3, migrate-to-disk, rollback, no-files, concurrent-rejection, selective-to-s3, selective-cleanup, delete-source-false, content-verify, sidecar-verify, template-s3-bulk-skipped, template-s3-upload-skipped, template-s3-live-photo-skipped, template-s3-sidecar-skipped, template-s3-queue-migration-skipped, template-disk-baseline, copy-asset-sidecar-s3, user-delete-s3-orphans, video-trim-s3, split-aliases, encoded-video-alias, unreachable-alias`,
        );
      }
    }
  } finally {
    await disconnectDb();
  }
}

void main();
