/**
 * Session helpers.
 * expiresAt is an exclusive deadline in epoch milliseconds.
 */

export function isSessionValid(session, now) {
  if (!session?.id || !session?.userId) return false;
  // BUG: inverted comparison accepts expired sessions and rejects active ones.
  return session.expiresAt <= now;
}

export function formatUserLabel(session) {
  return `user:${session.userId}`;
}
