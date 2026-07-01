import bcrypt from 'bcryptjs';

// Section 6 / Section 10: passwords are hashed with bcrypt at 12 rounds. We use the
// pure-JS `bcryptjs` (produces standard, `bcrypt`-compatible $2a$ hashes) to avoid
// native build toolchains on Windows dev machines.
const BCRYPT_ROUNDS = 12;

export function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}

export function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}
