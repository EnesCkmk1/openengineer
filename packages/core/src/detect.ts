import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import type { SuggestedCheck } from '@openengineer/shared';

export interface ProjectDetection {
  languages: string[];
  packageManager: string;
  testFramework: string | null;
  scripts: Record<string, string>;
  suggestedChecks: SuggestedCheck[];
  notes: string[];
}

const SCRIPT_NAMES = ['test', 'lint', 'typecheck', 'build', 'check'] as const;

export async function detectProject(root: string): Promise<ProjectDetection> {
  const notes: string[] = [];
  const languages: string[] = [];
  const packageJson = await readJson(path.join(root, 'package.json'));
  const has = async (rel: string) => exists(path.join(root, rel));

  if (packageJson) languages.push(packageJson.devDependencies?.typescript || packageJson.dependencies?.typescript || (await has('tsconfig.json')) ? 'typescript' : 'javascript');
  if (await has('pyproject.toml') || await has('requirements.txt') || await has('setup.py')) languages.push('python');
  if (await has('go.mod')) languages.push('go');
  if (await has('Cargo.toml')) languages.push('rust');
  if (languages.length === 0) {
    languages.push('unknown');
    notes.push('No supported project manifest was found. Mechanical checks will be marked not run.');
  }

  let packageManager = 'unknown';
  if (packageJson) {
    if (typeof packageJson.packageManager === 'string') {
      packageManager = packageJson.packageManager.split('@')[0] || 'npm';
    } else if (await has('pnpm-lock.yaml')) packageManager = 'pnpm';
    else if (await has('yarn.lock')) packageManager = 'yarn';
    else packageManager = 'npm';
  } else if (await has('pyproject.toml')) packageManager = 'pip';
  else if (await has('go.mod')) packageManager = 'go';
  else if (await has('Cargo.toml')) packageManager = 'cargo';

  const scripts = readScripts(packageJson);
  const testFramework = detectTestFramework(packageJson, scripts);
  const suggestedChecks: SuggestedCheck[] = [];

  if (packageManager === 'npm' || packageManager === 'pnpm' || packageManager === 'yarn') {
    for (const name of SCRIPT_NAMES) {
      if (!scripts[name] && !(name === 'typecheck' && (await has('tsconfig.json')))) continue;
      const argv =
        name === 'test' && (packageManager === 'npm' || packageManager === 'pnpm')
          ? [packageManager, 'test']
          : name === 'typecheck' && !scripts[name]
            ? ['npx', 'tsc', '--noEmit']
            : packageManager === 'yarn'
              ? ['yarn', name]
              : [packageManager, 'run', name];
      const display = argv.join(' ');
      suggestedChecks.push({
        id: name === 'typecheck' && !scripts[name] ? 'typecheck' : name,
        name: checkName(name),
        argv,
        display,
        required: name !== 'check',
      });
    }
  } else if (packageManager !== 'unknown') {
    notes.push(`${packageManager} projects are detected but not executed by this version. Checks are left not run.`);
  }

  return { languages, packageManager, testFramework, scripts, suggestedChecks, notes };
}

function checkName(name: string): string {
  switch (name) {
    case 'test':
      return 'Tests';
    case 'lint':
      return 'Lint';
    case 'typecheck':
      return 'Typecheck';
    case 'build':
      return 'Build';
    default:
      return name;
  }
}

function detectTestFramework(packageJson: PackageJson | null, scripts: Record<string, string>): string | null {
  const blob = JSON.stringify(packageJson ?? {}) + (scripts.test ?? '');
  if (blob.includes('vitest')) return 'vitest';
  if (blob.includes('jest')) return 'jest';
  if (blob.includes('mocha')) return 'mocha';
  if (blob.includes('node --test') || blob.includes('node:test')) return 'node:test';
  if (blob.includes('pytest')) return 'pytest';
  if (scripts.test) return 'custom';
  return null;
}

interface PackageJson {
  packageManager?: string;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function readJson(file: string): Promise<PackageJson | null> {
  try {
    const text = await readFile(file, 'utf8');
    return JSON.parse(text) as PackageJson;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw error;
  }
}

function readScripts(packageJson: PackageJson | null): Record<string, string> {
  const scripts: Record<string, string> = {};
  for (const [key, value] of Object.entries(packageJson?.scripts ?? {})) {
    if (typeof value === 'string') scripts[key] = value;
  }
  return scripts;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
