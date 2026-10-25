import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runSuite } from './suite.js';

const out = process.argv.find((_arg, index) => process.argv[index - 1] === '--out') ?? 'evals/results/latest.json';

const configurations = await runSuite();
const document = {
  generatedAt: new Date().toISOString(),
  provider: 'scripted',
  sandbox: 'process',
  note: 'These results were produced by the deterministic scripted provider against the session-app fixture. Token counts are a character-length heuristic, estimated cost is null, and the figures measure the engine, policy, and graders. They are not a language-model benchmark and do not support claims about model quality.',
  configurations,
};
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(document, null, 2)}\n`);
for (const configuration of configurations) {
  process.stdout.write(
    `${configuration.id}: completion ${configuration.summary.taskCompletionRate}, tests ${configuration.summary.testPassRate}, missed regressions ${configuration.summary.regressionRate}, mean repairs ${configuration.summary.meanRepairAttempts}\n`,
  );
}
process.stdout.write(`wrote ${out}\n`);
