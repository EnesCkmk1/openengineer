import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OpenEngineerError } from '@openengineer/shared';
import { assertReadableRelative, assertWritableRelative, resolveInside } from './paths.js';

const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage', '.openengineer']);
const MAX_READ = 80_000;
const MAX_MATCHES = 50;

export async function listFiles(root: string, limit = 400): Promise<string[]> {
  const files: string[] = [];
  await walk(root, '', files, limit);
  return files;
}

async function walk(dir: string, prefix: string, files: string[], limit: number): Promise<void> {
  if (files.length >= limit) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (files.length >= limit) return;
    if (SKIP.has(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      files.push(rel);
      continue;
    }
    if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel, files, limit);
    else files.push(rel);
  }
}

export async function readTextFile(root: string, requested: string): Promise<string> {
  assertReadableRelative(requested);
  const full = await resolveInside(root, requested);
  const buffer = await readFile(full);
  if (buffer.includes(0)) {
    throw new OpenEngineerError(`${requested} looks like a binary file`, 'binary_file');
  }
  const text = buffer.toString('utf8');
  if (text.length > MAX_READ) return `${text.slice(0, MAX_READ)}\n... truncated`;
  return text;
}

export async function editFile(root: string, requested: string, oldString: string, newString: string): Promise<string> {
  assertWritableRelative(requested);
  if (!oldString) throw new OpenEngineerError('oldString must not be empty', 'validation');
  if (oldString === newString) throw new OpenEngineerError('oldString and newString are identical', 'validation');
  const full = await resolveInside(root, requested);
  const text = await readFile(full, 'utf8');
  const count = text.split(oldString).length - 1;
  if (count === 0) throw new OpenEngineerError(`oldString was not found in ${requested}`, 'edit_mismatch');
  if (count > 1) {
    throw new OpenEngineerError(`oldString matched ${count} times in ${requested}. Add surrounding context.`, 'edit_mismatch');
  }
  await writeFile(full, text.replace(oldString, newString));
  return `Updated ${requested}`;
}

export async function writeTextFile(root: string, requested: string, content: string): Promise<string> {
  assertWritableRelative(requested);
  const full = await resolveInside(root, requested);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
  return `Wrote ${requested}`;
}

export async function searchText(root: string, query: string): Promise<string> {
  if (!query.trim() || query.length > 200) {
    throw new OpenEngineerError('Search query must be 1-200 characters', 'validation');
  }
  const needle = query.toLowerCase();
  const files = await listFiles(root, 800);
  const matches: string[] = [];
  for (const file of files) {
    if (matches.length >= MAX_MATCHES) break;
    let text: string;
    try {
      text = await readTextFile(root, file);
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index]!.toLowerCase().includes(needle)) {
        matches.push(`${file}:${index + 1}: ${lines[index]!.slice(0, 240)}`);
        if (matches.length >= MAX_MATCHES) break;
      }
    }
  }
  return matches.length > 0 ? matches.join('\n') : 'No matches';
}
