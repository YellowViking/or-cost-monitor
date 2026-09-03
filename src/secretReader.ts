import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Reads the OpenRouter API key that the user configured in VS Code's own
 * chat language model settings (chatLanguageModels.json), which stores the
 * actual key in VS Code's secret storage (state.vscdb, encrypted with the
 * macOS Keychain master key "Code Safe Storage" / "Code Key").
 *
 * This lets the monitor reuse the SAME key that powers the user's chat
 * conversations, without asking them to re-enter it.
 */

interface ChatLanguageModel {
  name?: string;
  vendor?: string;
  apiKey?: string;
}

const SECRET_PREFIX = 'v10'; // Electron/Chromium os_crypt version prefix
const KEYCHAIN_SERVICE = 'Code - Insiders Safe Storage';
const KEYCHAIN_ACCOUNT = 'Code - Insiders Key';
const PBKDF2_SALT = 'saltysalt';
const PBKDF2_ITERATIONS = 1003;
const AES_KEY_LEN = 16; // AES-128
const FIXED_IV = Buffer.alloc(16, ' '); // os_crypt uses 16 spaces as IV

/** Find the user's chatLanguageModels.json path. */
function chatLanguageModelsPath(): string {
  const base = path.join(
    process.env.HOME || '',
    'Library',
    'Application Support',
    'Code - Insiders',
    'User'
  );
  return path.join(base, 'chatLanguageModels.json');
}

/** Read chatLanguageModels.json and return the OpenRouter provider's apiKey template. */
function readOpenRouterKeyTemplate(): string | undefined {
  try {
    const raw = fs.readFileSync(chatLanguageModelsPath(), 'utf8');
    const models = JSON.parse(raw) as ChatLanguageModel[];
    const or = models.find((m) => m.vendor === 'openrouter' || (m.name || '').toLowerCase().includes('openrouter'));
    return or?.apiKey;
  } catch {
    return undefined;
  }
}

/** Extract the secret id from a template like "${input:chat.lm.secret.-1353e9a3}". */
function secretIdFromTemplate(template: string): string | undefined {
  const m = /^\$\{input:(chat\.lm\.secret\.[^}]+)\}$/.exec(template.trim());
  return m ? m[1] : undefined;
}

/** Read the encrypted secret blob from state.vscdb. */
function readSecretBlob(secretId: string): Buffer | undefined {
  const dbPath = path.join(
    process.env.HOME || '',
    'Library',
    'Application Support',
    'Code - Insiders',
    'User',
    'globalStorage',
    'state.vscdb'
  );
  try {
    const db = new (require('better-sqlite3'))(dbPath, { readonly: true });
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(`secret://${secretId}`);
    db.close();
    if (!row) return undefined;
    const parsed = JSON.parse(row.value.toString('utf8'));
    if (parsed?.type === 'Buffer' && Array.isArray(parsed.data)) {
      return Buffer.from(parsed.data);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Fetch the Keychain master key used by VS Code secret storage. */
async function getKeychainMasterKey(): Promise<Buffer | undefined> {
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      KEYCHAIN_ACCOUNT,
      '-w',
    ]);
    return Buffer.from(stdout.trim(), 'utf8');
  } catch {
    return undefined;
  }
}

/** Decrypt a VS Code secret blob (os_crypt: PBKDF2 + AES-128-CBC, "v10" prefix). */
function decryptSecret(blob: Buffer, password: Buffer): string | undefined {
  try {
    if (!blob.subarray(0, SECRET_PREFIX.length).equals(Buffer.from(SECRET_PREFIX))) {
      return undefined;
    }
    const ciphertext = blob.subarray(SECRET_PREFIX.length);
    // Key derivation: PBKDF2-HMAC-SHA1(password, "saltysalt", 1003, 16 bytes)
    const key = crypto.pbkdf2Sync(password, PBKDF2_SALT, PBKDF2_ITERATIONS, AES_KEY_LEN, 'sha1');
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, FIXED_IV);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString('utf8');
  } catch {
    return undefined;
  }
}

/**
 * Try to read the OpenRouter key from VS Code's own chat language model
 * secret storage. Returns undefined if not found / not decryptable.
 */
export async function readOpenRouterKeyFromVscodeSecrets(): Promise<string | undefined> {
  const template = readOpenRouterKeyTemplate();
  if (!template) return undefined;
  const secretId = secretIdFromTemplate(template);
  if (!secretId) return undefined;
  const blob = readSecretBlob(secretId);
  if (!blob) return undefined;
  const masterKey = await getKeychainMasterKey();
  if (!masterKey) return undefined;
  return decryptSecret(blob, masterKey);
}

/** Convenience: does the user have an OpenRouter provider configured in chatLanguageModels.json? */
export function hasOpenRouterProviderConfigured(): boolean {
  return !!readOpenRouterKeyTemplate();
}