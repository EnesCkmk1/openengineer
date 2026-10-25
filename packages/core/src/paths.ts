import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { OpenEngineerError } from '@openengineer/shared';

const PROTECTED = [
  /(^|\/)\.env($|\.)/,
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /\.pem$/i,
  /(^|\/)id_rsa($|\.)/,
  /(^|\/)id_ed25519($|\.)/,
];

export function normalizeRelative(requested: string): string {
  return requested.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function isProtectedRelative(requested: string): boolean {
  const norm = normalizeRelative(requested);
  return PROTECTED.some((pattern) => pattern.test(norm));
}

export function assertReadableRelative(requested: string): void {
  if (isProtectedRelative(requested)) {
    throw new OpenEngineerError(`Refusing to read a protected path: ${requested}`, 'protected_path');
  }
}

export function assertWritableRelative(requested: string): void {
  if (isProtectedRelative(requested)) {
    throw new OpenEngineerError(`Refusing to write a protected path: ${requested}`, 'protected_path');
  }
}

export async function resolveInside(root: string, requested: string): Promise<string> {
  if (requested.includes('\0')) {
    throw new OpenEngineerError(`Path is outside the authorized repository: ${requested}`, 'path_escape');
  }
  const rootReal = await realpath(root);
  const joined = path.resolve(rootReal, requested);
  const relative = path.relative(rootReal, joined);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new OpenEngineerError(`Path is outside the authorized repository: ${requested}`, 'path_escape');
  }
  const segments = relative.split(path.sep).filter(Boolean);
  let current = rootReal;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment === '.' || segment === '..') {
      throw new OpenEngineerError(`Path is outside the authorized repository: ${requested}`, 'path_escape');
    }
    const next = path.join(current, segment);
    try {
      const stat = await lstat(next);
      if (stat.isSymbolicLink()) {
        const target = await realpath(next);
        const targetRel = path.relative(rootReal, target);
        if (targetRel.startsWith('..') || path.isAbsolute(targetRel)) {
          throw new OpenEngineerError(
            `Symlink escapes the authorized repository: ${requested}`,
            'path_escape',
          );
        }
        current = target;
      } else if (!stat.isDirectory() && index !== segments.length - 1) {
        throw new OpenEngineerError(`Path is outside the authorized repository: ${requested}`, 'path_escape');
      } else {
        current = next;
      }
    } catch (error) {
      if (error instanceof OpenEngineerError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
      current = path.join(current, ...segments.slice(index));
      break;
    }
  }
  const finalRel = path.relative(rootReal, current);
  if (finalRel.startsWith('..') || path.isAbsolute(finalRel)) {
    throw new OpenEngineerError(`Path is outside the authorized repository: ${requested}`, 'path_escape');
  }
  return current;
}

export function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
