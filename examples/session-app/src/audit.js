import { formatUserLabel, isSessionValid } from './session.js';

export function buildAuditLine(session, now) {
  const state = isSessionValid(session, now) ? 'valid' : 'expired';
  return `${formatUserLabel(session)} ${state}`;
}
