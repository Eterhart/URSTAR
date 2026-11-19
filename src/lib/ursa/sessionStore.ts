import crypto from 'node:crypto';
import { UrsaSession } from '@/types/ursa';

export const SESSION_COOKIE_NAME = 'buplaner_session';
export const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour (3,600,000 ms)

// Stable 32-byte key derived from SECRET for AES-256-GCM encryption
const SECRET = crypto
  .createHash('sha256')
  .update(process.env.SESSION_SECRET || 'urstar-bu-ursa-stateless-session-salt-2569')
  .digest();

/**
 * Encrypts session data into an authenticated AES-256-GCM token (Stateless Serverless Safe).
 */
export function encryptSession(data: { cookie: string; createdAt: number }): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SECRET, iv);
  const json = JSON.stringify(data);
  let encrypted = cipher.update(json, 'utf8', 'base64url');
  encrypted += cipher.final('base64url');
  const tag = cipher.getAuthTag().toString('base64url');
  return `${iv.toString('base64url')}.${encrypted}.${tag}`;
}

/**
 * Decrypts and verifies an authenticated AES-256-GCM token.
 */
export function decryptSession(token: string): { cookie: string; createdAt: number } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [ivB64, encB64, tagB64] = parts;
    const iv = Buffer.from(ivB64, 'base64url');
    const tag = Buffer.from(tagB64, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', SECRET, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encB64, 'base64url', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  } catch {
    return null;
  }
}

// Preserve session map across Hot Module Reloading (HMR) in development
const globalForUrsa = globalThis as unknown as {
  ursaSessions?: Map<string, UrsaSession>;
};

export const sessionMap = globalForUrsa.ursaSessions ?? new Map<string, UrsaSession>();

if (process.env.NODE_ENV !== 'production') {
  globalForUrsa.ursaSessions = sessionMap;
}

/**
 * Creates a new URSA session token (stateless encrypted + RAM cached).
 */
export function createSession(cookie: string): string {
  cleanupExpiredSessions();
  const session: UrsaSession = {
    cookie,
    createdAt: Date.now(),
  };
  const token = encryptSession(session);
  sessionMap.set(token, session);
  return token;
}

/**
 * Retrieves an active, unexpired session for the provided session token.
 * Works across all Vercel Serverless Function instances.
 */
export function getSession(sessionId: string | null | undefined): UrsaSession | null {
  if (!sessionId) return null;

  // 1. Check local instance memory cache first
  const memorySession = sessionMap.get(sessionId);
  if (memorySession) {
    if (Date.now() - memorySession.createdAt > SESSION_TTL_MS) {
      sessionMap.delete(sessionId);
      return null;
    }
    return memorySession;
  }

  // 2. Decrypt stateless token (allows any Serverless container to immediately resume session)
  const decrypted = decryptSession(sessionId);
  if (!decrypted) return null;

  if (Date.now() - decrypted.createdAt > SESSION_TTL_MS) {
    return null;
  }

  const session: UrsaSession = {
    cookie: decrypted.cookie,
    createdAt: decrypted.createdAt,
  };

  // Cache in local container RAM for subsequent requests
  sessionMap.set(sessionId, session);
  return session;
}

/**
 * Deletes a session by token from the in-memory store.
 */
export function deleteSession(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  return sessionMap.delete(sessionId);
}

/**
 * Sweeps and purges all expired sessions from local memory store.
 */
export function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessionMap.entries()) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      sessionMap.delete(id);
    }
  }
}
