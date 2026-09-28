/**
 * Where the vault is kept, in one place for the two contexts that write it: the side
 * panel (answers to the agent, Analyze's save card, a scanned ID card) and the
 * background (a yes to "Remember what you typed?" after a form submit, D40).
 *
 * Two copies, for two lifetimes. `storage.session` is memory only and lasts until
 * the browser closes. Once the user has agreed to keep something, the same backup is
 * also sealed to disk with AES-GCM under a non-extractable key (lib/pii/vault-store.ts,
 * D36). "Forget everything" deletes both and the agreement with them.
 */

import { browserStores, forgetVault, openVault, sealVault } from './vault-store';
import type { VaultBackup } from './vault';

const SESSION_KEY = 'privagent.profile';
/** Whether the user has agreed to keeping their details on this device. Not PII. */
const REMEMBER_KEY = 'privagent.vault.remember';

const stores = browserStores();

/** The most recent vault: this browser session's copy, else the sealed one if kept. */
export async function loadBackup(): Promise<VaultBackup | undefined> {
  try {
    const session = await browser.storage.session.get(SESSION_KEY);
    const held = session?.[SESSION_KEY] as VaultBackup | undefined;
    if (held?.v === 1) return held;
  } catch {
    /* no session storage here */
  }
  return (await isRemembered()) ? openVault(stores) : undefined;
}

/**
 * Save the vault. `remember` marks the user's agreement to keep it on the device:
 * once given — a yes, a save, an answer — every later save is sealed too.
 */
export async function persistBackup(backup: VaultBackup, remember = false): Promise<void> {
  try {
    await browser.storage.session.set({ [SESSION_KEY]: backup });
  } catch {
    /* the vault simply stays in memory */
  }
  if (remember && !(await isRemembered())) await browser.storage.local.set({ [REMEMBER_KEY]: true });
  if (remember || (await isRemembered())) await sealVault(backup, stores);
}

export async function isRemembered(): Promise<boolean> {
  try {
    const stored = await browser.storage.local.get(REMEMBER_KEY);
    return stored?.[REMEMBER_KEY] === true;
  } catch {
    return false;
  }
}

/** Forget everything: both copies, the key, and the agreement. */
export async function forgetBackup(): Promise<void> {
  await forgetVault(stores);
  await browser.storage.local.remove(REMEMBER_KEY);
  try {
    await browser.storage.session.remove(SESSION_KEY);
  } catch {
    /* nothing held */
  }
}
