import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/** Base64 pattern: alphanumerics, +, /, with 0–2 trailing = padding only. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Check whether a string looks like AES-256-GCM output produced by `encrypt()`.
 *
 * Format: `<iv>:<authTag>:<ciphertext>` where each segment is base64-encoded.
 * - IV:  16 bytes → 24 base64 chars (with `==` padding)
 * - Tag: 16 bytes → 24 base64 chars (with `==` padding)
 * - Ciphertext: variable length, but must be valid non-empty base64.
 */
export function looksEncrypted(value: string): boolean {
  const segments = value.split(':');
  if (segments.length !== 3) return false;

  const [iv, tag, ciphertext] = segments;

  // IV must be exactly 24 base64 characters (16 bytes)
  if (iv.length !== 24 || !BASE64_RE.test(iv)) return false;

  // Auth tag must be exactly 24 base64 characters (16 bytes)
  if (tag.length !== 24 || !BASE64_RE.test(tag)) return false;

  // Ciphertext must be non-empty valid base64 with length that is a multiple of 4
  if (ciphertext.length === 0 || ciphertext.length % 4 !== 0 || !BASE64_RE.test(ciphertext)) return false;

  // Verify IV and auth tag decode to exactly 16 bytes (AES-256-GCM requirement)
  if (Buffer.from(iv, 'base64').length !== 16) return false;
  if (Buffer.from(tag, 'base64').length !== 16) return false;

  return true;
}

export function encrypt(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:ciphertext (all base64)
  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

export function decrypt(encrypted: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const [ivB64, authTagB64, ciphertextB64] = encrypted.split(':');

  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error('Invalid encrypted value format');
  }

  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}
