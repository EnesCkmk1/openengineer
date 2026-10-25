import type { ToolDefinition } from './model.js';

const objectSchema = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const string = { type: 'string' };
const stringArray = { type: 'array', items: string };

export const PLAN_SYSTEM = `You are OpenEngineer's planning agent.
Turn the task into a structured plan for a repository that has already been inspected.
Use read-only tools when the summary is not enough to name real files.
Call submit_plan when you can describe the change, the likely files, the checks, and the risks.
Call request_clarification only when a missing fact would change what "done" means or could cause an unsafe edit. Do not ask about routine names, formatting, or test style.
Do not invent files that were not listed or read.
The implementation agent will run later in an isolated worktree. Uncommitted changes in the user's checkout are preserved and are not part of the base commit.`;

export const IMPLEMENT_SYSTEM = `You are OpenEngineer's implementation agent.
Modify only the task worktree using the provided tools. You do not have a general shell.
Rules:
- Read a file before editing it.
- edit_file must include the exact current text in oldString.
- Do not read or write .env files, private keys, .git, or node_modules.
- Do not claim that tests, lint, or the build passed. A separate verifier runs those commands and ignores your opinion.
- Call finish when the code is ready for that verifier.
- Call refuse when the task requires credential theft, data exfiltration, disabling a security control, destructive host operations, or any change you cannot make safely inside this repository.
- Keep the change as small as the acceptance criteria allow.`;

export const REVIEW_SYSTEM = `You review a completed patch as supplementary evidence.
Return JSON only: {"summary": string, "concerns": string[], "confidence": "low" | "medium" | "high"}.
Base every claim on the supplied diff and check results. Do not say a check passed unless its status is "passed".
Your review cannot change verification status.`;

const planProperties = {
  objective: string,
  acceptanceCriteria: stringArray,
  relevantFiles: stringArray,
  dependencies: stringArray,
  steps: {
    type: 'array',
    items: objectSchema({ id: string, description: string }, ['id', 'description']),
  },
  validationCommands: stringArray,
  risks: stringArray,
  assumptions: stringArray,
  needsClarification: { type: 'boolean' },
  clarificationQuestions: stringArray,
};

export const PLAN_TOOLS: ToolDefinition[] = [
  {
    name: 'list_files',
    description: 'List repository files, excluding dependencies and VCS metadata.',
    parameters: objectSchema({}, []),
  },
  {
    name: 'read_file',
    description: 'Read a text file inside the repository.',
    parameters: objectSchema({ path: string }, ['path']),
  },
  {
    name: 'search_code',
    description: 'Literal case-insensitive search across repository text files.',
    parameters: objectSchema({ query: string }, ['query']),
  },
  {
    name: 'submit_plan',
    description: 'Submit the implementation plan. This ends planning when needsClarification is false.',
    parameters: objectSchema(planProperties, [
      'objective',
      'acceptanceCriteria',
      'relevantFiles',
      'dependencies',
      'steps',
      'validationCommands',
      'risks',
      'assumptions',
      'needsClarification',
      'clarificationQuestions',
    ]),
  },
  {
    name: 'request_clarification',
    description: 'Pause for a human answer when a critical fact is missing.',
    parameters: objectSchema({ questions: stringArray }, ['questions']),
  },
];

export const IMPLEMENT_TOOLS: ToolDefinition[] = [
  ...PLAN_TOOLS.filter((tool) => tool.name !== 'submit_plan' && tool.name !== 'request_clarification'),
  {
    name: 'edit_file',
    description: 'Replace one unique occurrence of oldString with newString.',
    parameters: objectSchema({ path: string, oldString: string, newString: string }, ['path', 'oldString', 'newString']),
  },
  {
    name: 'write_file',
    description: 'Create or replace a text file inside the worktree.',
    parameters: objectSchema({ path: string, content: string }, ['path', 'content']),
  },
  {
    name: 'inspect_diff',
    description: 'Show the current diff against the base commit.',
    parameters: objectSchema({}, []),
  },
  {
    name: 'run_command',
    description: 'Run one allowlisted command, or pause when the command needs approval. Do not use shell syntax.',
    parameters: objectSchema({ command: string, justification: string }, ['command', 'justification']),
  },
  {
    name: 'finish',
    description: 'Mark implementation ready for independent verification.',
    parameters: objectSchema({ summary: string }, ['summary']),
  },
  {
    name: 'refuse',
    description: 'Stop because the task cannot be completed safely.',
    parameters: objectSchema({ reason: string }, ['reason']),
  },
];
