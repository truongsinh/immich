/**
 * Stored file paths are URIs that name their storage: `file:///abs/path` for disk and
 * `s3://<alias>/<key>` for an S3 alias, whose bucket lives in the alias config. This module owns
 * that format and the single lookup from a stored path to the backend and key that serve it.
 */
import { isAbsolute } from 'node:path';
import { StorageBackend } from 'src/interfaces/storage-backend.interface.js';

const FILE_SCHEME = 'file://';
const S3_SCHEME = 's3://';

export type StorageTarget = { type: 'disk' } | { type: 's3'; alias: string };

export const DISK: StorageTarget = { type: 'disk' };

export type StorageBackends = { disk: StorageBackend; aliases: ReadonlyMap<string, StorageBackend> };

/** `key` is an absolute path for disk and a raw object key for S3; neither is percent-encoded. */
export const toStorageUri = (target: StorageTarget, key: string): string =>
  target.type === 'disk' ? `${FILE_SCHEME}${key}` : `${S3_SCHEME}${target.alias}/${key}`;

export const storageTargetUri = (target: StorageTarget): string =>
  target.type === 'disk' ? FILE_SCHEME : `${S3_SCHEME}${target.alias}`;

/** Parses a target written as `file://` or `s3://<alias>` (a write target or a migration target). */
export const parseStorageTarget = (uri: string): StorageTarget => {
  if (uri === FILE_SCHEME) {
    return { type: 'disk' };
  }
  const alias = uri.startsWith(S3_SCHEME) ? uri.slice(S3_SCHEME.length) : '';
  if (!alias || alias.includes('/')) {
    throw new Error(`Invalid storage target "${uri}": expected file:// or s3://<alias>`);
  }
  return { type: 's3', alias };
};

/** Splits a stored path into its storage and key without a URL parser, so the key keeps every byte. */
export const parseStoredPath = (path: string): { target: StorageTarget; key: string } => {
  if (path.startsWith(FILE_SCHEME)) {
    const key = path.slice(FILE_SCHEME.length);
    if (!isAbsolute(key)) {
      throw new Error(`Stored path "${path}" is not an absolute file:// path`);
    }
    return { target: { type: 'disk' }, key };
  }

  if (path.startsWith(S3_SCHEME)) {
    const rest = path.slice(S3_SCHEME.length);
    const slash = rest.indexOf('/');
    if (slash > 0 && slash < rest.length - 1) {
      return { target: { type: 's3', alias: rest.slice(0, slash) }, key: rest.slice(slash + 1) };
    }
  }

  throw new Error(`Stored path "${path}" has no storage scheme (expected file:// or s3://<alias>/)`);
};

/** The absolute path of a stored path on disk, or undefined when it lives on an S3 alias. */
export const diskPathOf = (path: string): string | undefined => {
  const { target, key } = parseStoredPath(path);
  return target.type === 'disk' ? key : undefined;
};

export const resolveStoredPath = (
  path: string,
  backends: StorageBackends,
): { backend: StorageBackend; key: string; target: StorageTarget } => {
  const { target, key } = parseStoredPath(path);
  if (target.type === 'disk') {
    return { backend: backends.disk, key, target };
  }

  const backend = backends.aliases.get(target.alias);
  if (!backend) {
    throw new Error(`Stored path "${path}" names unknown storage alias "${target.alias}"`);
  }
  return { backend, key, target };
};
