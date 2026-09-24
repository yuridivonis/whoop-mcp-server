/**
 * Encryption for the WHOOP tokens stored in SQLite: AES-256-GCM, stored as
 * `iv:authTag:ciphertext` in hex. The key is derived with scrypt from ENCRYPTION_SECRET,
 * or WHOOP_CLIENT_SECRET when that is unset, so changing either makes stored tokens
 * unreadable (the server then treats WHOOP as disconnected; see database.ts).
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;

// scrypt is slow on purpose (~20 ms, blocking), so derive the key once per secret rather
// than on every call: /health decrypts the tokens and needs no sign-in.
let cachedKey: { secret: string; key: Buffer } | null = null;

function getEncryptionKey(): Buffer {
	const secret = process.env.ENCRYPTION_SECRET || process.env.WHOOP_CLIENT_SECRET;
	if (!secret) {
		throw new Error('No encryption secret available');
	}
	if (cachedKey?.secret !== secret) {
		const salt = Buffer.from('whoop-mcp-token-encryption', 'utf8');
		cachedKey = { secret, key: scryptSync(secret, salt, KEY_LENGTH) };
	}
	return cachedKey.key;
}

export function encrypt(text: string): string {
	const key = getEncryptionKey();
	const iv = randomBytes(IV_LENGTH);
	const cipher = createCipheriv(ALGORITHM, key, iv);

	let encrypted = cipher.update(text, 'utf8', 'hex');
	encrypted += cipher.final('hex');

	const authTag = cipher.getAuthTag();

	return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export function decrypt(encryptedData: string): string {
	const key = getEncryptionKey();
	const [ivHex, authTagHex, encrypted] = encryptedData.split(':');

	if (!ivHex || !authTagHex || !encrypted) {
		throw new Error('Invalid encrypted data format');
	}

	const iv = Buffer.from(ivHex, 'hex');
	const authTag = Buffer.from(authTagHex, 'hex');
	const decipher = createDecipheriv(ALGORITHM, key, iv);
	decipher.setAuthTag(authTag);

	let decrypted = decipher.update(encrypted, 'hex', 'utf8');
	decrypted += decipher.final('utf8');

	return decrypted;
}

/** Tokens saved before encryption was added are plain text; this tells them apart. */
export function isEncrypted(data: string): boolean {
	const parts = data.split(':');
	return parts.length === 3 && parts[0].length === IV_LENGTH * 2;
}
