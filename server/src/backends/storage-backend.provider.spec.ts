/**
 * Stored-path URIs: how a key is written into a URI and read back, and which backend a stored path names.
 */
import { describe, expect, it } from 'vitest';
import { DISK, StorageTarget, resolveStoredPath, toStorageUri } from 'src/backends/storage-backend.provider.js';
import { StorageBackend } from 'src/interfaces/storage-backend.interface.js';

const disk = { name: 'disk' } as unknown as StorageBackend;
const eu = { name: 'originals-eu' } as unknown as StorageBackend;
const home = { name: 'previews-home' } as unknown as StorageBackend;
const backends = {
  disk,
  aliases: new Map([
    ['originals-eu', eu],
    ['previews-home', home],
  ]),
};

const EU: StorageTarget = { type: 's3', alias: 'originals-eu' };

describe('stored path URIs', () => {
  it.each([
    { target: EU, key: 'upload/user/ab/cd/photo.jpg' },
    { target: EU, key: 'library/user/2024/what?.jpg' },
    { target: EU, key: 'library/user/#1 hash.jpg' },
    { target: EU, key: 'library/user/100%25 real.jpg' },
    { target: EU, key: 'library/user/with  spaces/ IMG 1 .jpg' },
    { target: EU, key: 'library/user/Ảnh Hà Nội/日本語.heic' },
    { target: EU, key: 'a/b/c/d/e/f/g/deeply/nested.mp4' },
    { target: DISK, key: '/data/upload/user/ab/cd/photo.jpg' },
    { target: DISK, key: '/data/library/user/2024/what?.jpg' },
    { target: DISK, key: '/data/library/user/#1 hash.jpg' },
    { target: DISK, key: '/data/library/user/100%25 real.jpg' },
    { target: DISK, key: '/mnt/external/with  spaces/ IMG 1 .jpg' },
    { target: DISK, key: '/mnt/external/Ảnh Hà Nội/日本語.heic' },
    { target: DISK, key: '/a/b/c/d/e/f/g/deeply/nested.mp4' },
  ])('keeps $key unchanged through a $target.type URI', ({ target, key }) => {
    const uri = toStorageUri(target, key);

    const resolved = resolveStoredPath(uri, backends);

    expect(resolved).toEqual({ backend: target.type === 'disk' ? disk : eu, key, target });
  });

  it.each([
    { path: 'file:///data/library/user/photo.jpg', backend: disk, key: '/data/library/user/photo.jpg' },
    { path: 's3://originals-eu/upload/user/photo.jpg', backend: eu, key: 'upload/user/photo.jpg' },
    { path: 's3://previews-home/thumbs/user/photo.webp', backend: home, key: 'thumbs/user/photo.webp' },
  ])('serves $path from the storage it names', ({ path, backend, key }) => {
    expect(resolveStoredPath(path, backends)).toMatchObject({ backend, key });
  });

  it.each([
    { path: 's3://archive-us/upload/user/photo.jpg', named: 'archive-us' },
    { path: '/data/library/user/photo.jpg', named: '/data/library/user/photo.jpg' },
    { path: 'upload/user/ab/cd/photo.jpg', named: 'upload/user/ab/cd/photo.jpg' },
  ])('refuses $path with an error naming it', ({ path, named }) => {
    expect(() => resolveStoredPath(path, backends)).toThrow(named);
  });
});
