/**
 * The vault saved on the device (D36): AES-GCM under a non-extractable key. Tested
 * against in-memory stores; the browser's IndexedDB + storage.local are the same
 * interface. FAKE DATA ONLY (CLAUDE.md).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { forgetVault, openVault, sealVault, type SealedBlob, type VaultStores } from '../lib/pii/vault-store';
import type { VaultBackup } from '../lib/pii/vault';

function memoryStores(): VaultStores & { key?: CryptoKey; blob?: SealedBlob } {
  const s: VaultStores & { key?: CryptoKey; blob?: SealedBlob } = {
    getKey: async () => s.key,
    putKey: async (key) => void (s.key = key),
    getBlob: async () => s.blob,
    putBlob: async (blob) => void (s.blob = blob),
    clear: async () => {
      s.key = undefined;
      s.blob = undefined;
    },
  };
  return s;
}

const BACKUP: VaultBackup = {
  v: 1,
  profile: { EMAIL: 'ananya.iyer@example.com', PHONE: '9812345678' },
  memos: [{ label: "Father's name", value: 'Suresh Iyer', type: 'NAME', slug: 'FATHER_NAME' }],
};

let stores: ReturnType<typeof memoryStores>;
beforeEach(() => {
  stores = memoryStores();
});

describe('sealVault / openVault', () => {
  it('round-trips the backup', async () => {
    await sealVault(BACKUP, stores);
    expect(await openVault(stores)).toEqual(BACKUP);
  });

  it('never stores a readable value', async () => {
    await sealVault(BACKUP, stores);
    const onDisk = JSON.stringify(stores.blob);
    for (const secret of ['ananya', '9812345678', 'Suresh']) expect(onDisk).not.toContain(secret);
  });

  it('uses a key that cannot be exported', async () => {
    await sealVault(BACKUP, stores);
    expect(stores.key!.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', stores.key!)).rejects.toThrow();
  });

  it('uses a fresh IV for every save', async () => {
    await sealVault(BACKUP, stores);
    const first = stores.blob!;
    await sealVault(BACKUP, stores);
    expect(stores.blob!.iv).not.toBe(first.iv);
    expect(stores.blob!.data).not.toBe(first.data);
  });

  it('opens to nothing when tampered with, or when the key is gone', async () => {
    await sealVault(BACKUP, stores);
    const good = stores.blob!;
    const flipped = good.data.startsWith('A') ? `B${good.data.slice(1)}` : `A${good.data.slice(1)}`;
    stores.blob = { ...good, data: flipped };
    expect(await openVault(stores)).toBeUndefined();

    stores.blob = good;
    stores.key = undefined;
    expect(await openVault(stores)).toBeUndefined();
  });

  it('opens to nothing when nothing was saved', async () => {
    expect(await openVault(stores)).toBeUndefined();
  });

  it('forgets the key and the ciphertext together', async () => {
    await sealVault(BACKUP, stores);
    await forgetVault(stores);
    expect(stores.key).toBeUndefined();
    expect(stores.blob).toBeUndefined();
    expect(await openVault(stores)).toBeUndefined();
  });
});
