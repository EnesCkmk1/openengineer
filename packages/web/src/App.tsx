import { useCallback, useEffect, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api, isActive, type Approval, type DiffFile, type Repository, type Step, type Task } from './api';

export function App() {
  const [repos, setRepos] = useState<Repository[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<string>('checking');

  const refreshRepos = useCallback(async () => {
    const body = await api.repositories();
    setRepos(body.repositories);
  }, []);

  useEffect(() => {
    api
      .health()
      .then((body) => setHealth(`${body.provider} · sandbox ${body.sandbox}`))
      .catch((err: unknown) => setHealth(err instanceof Error ? err.message : 'API unavailable'));
    refreshRepos().catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load repositories'));
  }, [refreshRepos]);

  return (
    <div className="grid h-full grid-cols-[280px_1fr]">
      <aside className="flex flex-col border-r border-line bg-panel">
        <div className="border-b border-line px-4 py-4">
          <Link to="/" className="text-[15px] tracking-wide text-ink no-underline">
            OpenEngineer
          </Link>
          <p className="mt-1 font-mono text-[11px] text-mist">{health}</p>
        </div>
        <RepoList repos={repos} error={error} onAdded={refreshRepos} />
      </aside>
      <main className="min-w-0 overflow-auto">
        <Routes>
          <Route path="/" element={<Home repos={repos} />} />
          <Route path="/repos/:repoId" element={<RepoTasks repos={repos} />} />
          <Route path="/tasks/:taskId" element={<TaskScreen />} />
        </Routes>
      </main>
    </div>
  );
}

function RepoList({ repos, error, onAdded }: { repos: Repository[] | null; error: string | null; onAdded: () => Promise<void> }) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function add() {
    setBusy(true);
    setFormError(null);
    try {
      const repo = await api.addRepository(path.trim());
      setPath('');
      await onAdded();
      navigate(`/repos/${repo.id}`);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not add repository');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        className="border-b border-line p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (path.trim()) void add();
        }}
      >
        <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-mist" htmlFor="repo-path">
          Local git repository
        </label>
        <input
          id="repo-path"
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="/path/to/repo"
          className="w-full rounded border border-line bg-paper px-2 py-1.5 text-sm outline-none focus:border-brass"
        />
        <button type="submit" disabled={busy || !path.trim()} className="mt-2 w-full rounded bg-brass px-2 py-1.5 text-sm text-paper disabled:opacity-40">
          {busy ? 'Checking…' : 'Add repository'}
        </button>
        {formError ? <p className="mt-2 text-xs text-clay">{formError}</p> : null}
      </form>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {error ? <p className="px-2 text-sm text-clay">{error}</p> : null}
        {repos === null ? <p className="px-2 py-3 text-sm text-mist">Loading repositories…</p> : null}
        {repos?.length === 0 ? <p className="px-2 py-3 text-sm text-mist">No repositories yet.</p> : null}
        {repos?.map((repo) => (
          <Link key={repo.id} to={`/repos/${repo.id}`} className="block rounded px-2 py-2 text-sm no-underline hover:bg-panel-2">
            <span className="block text-ink">{repo.name}</span>
            <span className="block truncate font-mono text-[11px] text-mist">{repo.packageManager ?? 'unknown'} · {repo.testFramework ?? 'no tests'}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function Home({ repos }: { repos: Repository[] | null }) {
  return (
    <section className="mx-auto max-w-2xl px-8 py-16">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-brass">Local agent runner</p>
      <h1 className="mt-3 text-3xl font-medium">Inspect a repository, change it in a worktree, and verify the result.</h1>
      <p className="mt-4 text-mist">
        OpenEngineer does not merge or deploy. Commands run only through the sandbox policy, and a model review cannot mark a failed test as passed.
      </p>
      {repos === null ? <p className="mt-8 text-sm text-mist">Loading…</p> : null}
      {repos?.length === 0 ? <p className="mt-8 text-sm">Add a local git repository to start a task.</p> : null}
    </section>
  );
}

function RepoTasks({ repos }: { repos: Repository[] | null }) {
  const { repoId } = useParams();
  const repo = repos?.find((item) => item.id === repoId) ?? null;
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [instruction, setInstruction] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    if (!repoId) return;
    const body = await api.tasks(repoId);
    setTasks(body.tasks);
  }, [repoId]);

  useEffect(() => {
    load().catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load tasks'));
  }, [load]);

  async function create() {
    if (!repoId) return;
    setBusy(true);
    setError(null);
    try {
      const task = await api.createTask(repoId, instruction.trim());
      setInstruction('');
      navigate(`/tasks/${task.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create task');
    } finally {
      setBusy(false);
    }
  }

  if (repos && !repo) return <p className="p-8 text-clay">Repository not found.</p>;

  return (
    <section className="mx-auto max-w-3xl px-8 py-8">
      <p className="font-mono text-xs text-mist">{repo?.rootPath ?? 'Loading repository…'}</p>
      <h1 className="mt-1 text-2xl">{repo?.name ?? 'Repository'}</h1>
      {repo?.detection?.hasUncommittedChanges ? (
        <p className="mt-3 rounded border border-brass/40 bg-brass/10 px-3 py-2 text-sm">
          This checkout has uncommitted changes. They stay in place. Tasks branch from HEAD and do not include them.
        </p>
      ) : null}
      <form
        className="mt-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (instruction.trim()) void create();
        }}
      >
        <label htmlFor="instruction" className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-mist">
          Task
        </label>
        <textarea
          id="instruction"
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          rows={4}
          placeholder="Fix the bug where expired sessions are accepted and add regression tests."
          className="w-full rounded border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-brass"
        />
        <button type="submit" disabled={busy || !instruction.trim()} className="mt-2 rounded bg-brass px-3 py-1.5 text-sm text-paper disabled:opacity-40">
          {busy ? 'Starting…' : 'Run task'}
        </button>
      </form>
      {error ? <p className="mt-3 text-sm text-clay">{error}</p> : null}
      <div className="mt-8">
        {tasks === null ? <p className="text-sm text-mist">Loading tasks…</p> : null}
        {tasks?.length === 0 ? <p className="text-sm text-mist">No tasks for this repository.</p> : null}
        <ul className="divide-y divide-line border-y border-line">
          {tasks?.map((task) => (
            <li key={task.id}>
              <Link to={`/tasks/${task.id}`} className="flex items-center justify-between gap-4 py-3 no-underline">
                <span>
                  <span className="block text-sm text-ink">{task.title}</span>
                  <span className="font-mono text-[11px] text-mist">{task.id.slice(0, 8)}</span>
                </span>
                <Status status={task.status} />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function TaskScreen() {
  const { taskId } = useParams();
  const [task, setTask] = useState<Task | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [diff, setDiff] = useState<DiffFile[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState('');

  const load = useCallback(async () => {
    if (!taskId) return null;
    const [detail, stepBody] = await Promise.all([api.task(taskId), api.steps(taskId)]);
    setTask(detail.task);
    setApprovals(detail.approvals);
    setSteps(stepBody.steps);
    if (detail.task.worktreePath) {
      const diffBody = await api.diff(taskId);
      setDiff(diffBody.files);
    }
    return detail.task;
  }, [taskId]);

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      try {
        const current = await load();
        if (stopped) return;
        setError(null);
        if (current && isActive(current.status)) timer = window.setTimeout(() => void tick(), 1000);
      } catch (err: unknown) {
        if (!stopped) setError(err instanceof ApiError ? err.message : 'Failed to load task');
      }
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [load]);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    }
  }

  if (!task && !error) return <p className="p-8 text-sm text-mist">Loading task…</p>;
  if (!task) return <p className="p-8 text-clay">{error}</p>;
  const current = steps.find((step) => step.id === selected) ?? steps[steps.length - 1];
  const pending = approvals.find((approval) => approval.status === 'pending');

  return (
    <section className="px-6 py-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link to={`/repos/${task.repositoryId}`} className="font-mono text-xs text-mist no-underline">
            {task.repository.name}
          </Link>
          <h1 className="mt-1 max-w-3xl text-2xl">{task.title}</h1>
          <p className="mt-2 max-w-3xl text-sm text-mist">{task.instruction}</p>
        </div>
        <div className="flex items-center gap-2">
          <Status status={task.status} />
          {isActive(task.status) ? (
            <button className="rounded border border-clay px-3 py-1 text-sm text-clay" onClick={() => act(() => api.cancel(task.id))}>
              Cancel
            </button>
          ) : null}
        </div>
      </div>
      {error ? <p className="mt-4 rounded border border-clay/50 px-3 py-2 text-sm text-clay">{error}</p> : null}
      {task.status === 'cancelled' ? (
        <p className="mt-4 rounded border border-line px-3 py-2 text-sm">Cancelled. Partial steps and any worktree commits are preserved. Nothing was merged.</p>
      ) : null}
      {task.error ? (
        <p className="mt-4 rounded border border-clay/40 bg-clay/10 px-3 py-2 text-sm">
          <span className="font-mono text-xs">{task.errorCode}</span> {task.error}
        </p>
      ) : null}
      {pending ? (
        <form
          className="mt-4 rounded border border-brass/50 bg-panel p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void act(() => api.approval(task.id, pending.id, 'approve', answers.split('\n').map((line) => line.trim()).filter(Boolean)));
          }}
        >
          <p className="font-mono text-[10px] uppercase tracking-wider text-brass">Approval required · {pending.kind}</p>
          <p className="mt-2 whitespace-pre-wrap text-sm">{pending.prompt}</p>
          <textarea value={answers} onChange={(event) => setAnswers(event.target.value)} rows={3} placeholder="Answers, one per line" className="mt-3 w-full rounded border border-line bg-paper px-2 py-1.5 text-sm" />
          <div className="mt-2 flex gap-2">
            <button type="submit" className="rounded bg-brass px-3 py-1 text-sm text-paper">Approve</button>
            <button type="button" className="rounded border border-line px-3 py-1 text-sm" onClick={() => act(() => api.approval(task.id, pending.id, 'deny', []))}>
              Deny
            </button>
          </div>
        </form>
      ) : null}
      <Metrics task={task} />
      {task.plan ? (
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <article className="rounded border border-line bg-panel p-4">
            <h2 className="font-mono text-[10px] uppercase tracking-wider text-mist">Plan</h2>
            <p className="mt-2 text-sm">{task.plan.objective}</p>
            <ol className="mt-3 list-decimal space-y-1 pl-4 text-sm text-mist">
              {task.plan.steps.map((step) => (
                <li key={step.id}>{step.description}</li>
              ))}
            </ol>
          </article>
          <article className="rounded border border-line bg-panel p-4">
            <h2 className="font-mono text-[10px] uppercase tracking-wider text-mist">Risks and assumptions</h2>
            <ul className="mt-2 space-y-1 text-sm text-mist">
              {task.plan.risks.map((risk) => <li key={risk}>Risk: {risk}</li>)}
              {task.plan.assumptions.map((item) => <li key={item}>Assumption: {item}</li>)}
              {task.plan.relevantFiles.map((file) => <li key={file} className="font-mono text-xs">{file}</li>)}
            </ul>
          </article>
        </div>
      ) : null}
      <div className="mt-6 grid min-h-80 grid-cols-[240px_1fr] overflow-hidden rounded border border-line">
        <div className="overflow-auto border-r border-line bg-panel">
          {steps.length === 0 ? <p className="p-3 text-sm text-mist">Waiting for the first step…</p> : null}
          {steps.map((step) => (
            <button
              key={step.id}
              onClick={() => setSelected(step.id)}
              className={`block w-full border-b border-line px-3 py-2 text-left ${current?.id === step.id ? 'bg-panel-2' : ''}`}
            >
              <span className="block font-mono text-[11px] text-mist">{step.sequence}. {step.phase}</span>
              <span className="block truncate text-sm">{step.name}</span>
              <span className={`font-mono text-[10px] ${step.status === 'failed' || step.status === 'denied' ? 'text-clay' : 'text-moss'}`}>{step.status}</span>
            </button>
          ))}
        </div>
        <pre className="max-h-[28rem] overflow-auto bg-paper p-4 font-mono text-xs leading-5 text-ink">
          {current ? JSON.stringify({ input: current.input, output: current.output, error: current.error, durationMs: current.durationMs }, null, 2) : 'No step selected.'}
        </pre>
      </div>
      <Verification task={task} />
      <DiffView files={diff} />
    </section>
  );
}

function Metrics({ task }: { task: Task }) {
  const usage = task.usage;
  const items = [
    ['Duration', usage ? `${(usage.durationMs / 1000).toFixed(1)}s` : '—'],
    ['Tokens', usage ? `${usage.inputTokens} in / ${usage.outputTokens} out` : '—'],
    ['Accounting', usage?.tokenAccounting ?? '—'],
    ['Est. cost', usage ? (usage.estimatedCostUsd === null ? 'unavailable' : `$${usage.estimatedCostUsd}`) : '—'],
    ['Repairs', usage ? String(usage.repairAttempts) : '—'],
    ['Model', usage ? `${usage.provider}/${usage.model}` : '—'],
    ['Branch', task.branch ?? '—'],
  ];
  return (
    <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded border border-line bg-line md:grid-cols-4">
      {items.map(([label, value]) => (
        <div key={label} className="bg-panel px-3 py-2">
          <dt className="font-mono text-[10px] uppercase tracking-wider text-mist">{label}</dt>
          <dd className="truncate font-mono text-xs">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Verification({ task }: { task: Task }) {
  const report = task.verification;
  if (!report) return <p className="mt-6 text-sm text-mist">Verification has not run.</p>;
  return (
    <section className="mt-6">
      <div className="flex items-center gap-3">
        <h2 className="text-lg">Verification</h2>
        <Status status={report.overall} />
      </div>
      {report.sandbox.warning ? <p className="mt-2 text-sm text-brass">{report.sandbox.warning}</p> : null}
      <ul className="mt-3 divide-y divide-line border-y border-line">
        {report.checks.map((check) => (
          <li key={check.id} className="py-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm">{check.name}{check.command ? <span className="ml-2 font-mono text-xs text-mist">{check.command}</span> : null}</span>
              <Status status={check.status} />
            </div>
            {check.reason ? <p className="mt-1 text-xs text-mist">{check.reason}</p> : null}
            {check.status === 'failed' && check.output ? <pre className="mt-2 max-h-40 overflow-auto font-mono text-[11px] text-clay">{check.output}</pre> : null}
          </li>
        ))}
      </ul>
      <div className="mt-4">
        <h3 className="font-mono text-[10px] uppercase tracking-wider text-mist">Acceptance criteria</h3>
        {report.acceptance.map((item) => (
          <p key={item.criterion} className="mt-2 text-sm">
            <Status status={item.status} /> <span className="ml-2">{item.criterion}</span>
            <span className="mt-1 block text-xs text-mist">{item.evidence}</span>
          </p>
        ))}
      </div>
      {report.aiReview ? (
        <article className="mt-4 rounded border border-line p-3">
          <h3 className="font-mono text-[10px] uppercase tracking-wider text-mist">AI review · supplementary · {report.aiReview.confidence}</h3>
          <p className="mt-2 text-sm">{report.aiReview.summary}</p>
          {report.aiReview.concerns.map((concern) => <p key={concern} className="mt-1 text-xs text-mist">{concern}</p>)}
        </article>
      ) : null}
      {report.notes.map((note) => <p key={note} className="mt-2 text-xs text-mist">{note}</p>)}
    </section>
  );
}

function DiffView({ files }: { files: DiffFile[] | null }) {
  if (files === null) return null;
  if (files.length === 0) return <p className="mt-6 text-sm text-mist">No diff against the base commit.</p>;
  return (
    <section className="mt-6">
      <h2 className="text-lg">Diff</h2>
      {files.map((file) => (
        <article key={file.path} className="mt-3 overflow-hidden rounded border border-line">
          <header className="flex justify-between bg-panel px-3 py-2 font-mono text-xs">
            <span>{file.status} {file.path}</span>
            <span className="text-mist">+{file.insertions} -{file.deletions}</span>
          </header>
          <pre className="overflow-auto p-3 font-mono text-[11px] leading-5">
            {file.patch.split('\n').map((line, index) => (
              <div key={`${file.path}-${index}`} className={line.startsWith('+') ? 'text-moss' : line.startsWith('-') ? 'text-clay' : 'text-mist'}>
                {line || ' '}
              </div>
            ))}
          </pre>
        </article>
      ))}
    </section>
  );
}

function Status({ status }: { status: string }) {
  const tone = status === 'passed' || status === 'completed' ? 'text-moss border-moss/40' : status === 'failed' || status === 'denied' ? 'text-clay border-clay/40' : status === 'cancelled' ? 'text-mist border-line' : 'text-brass border-brass/40';
  return <span className={`inline-block rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase ${tone}`}>{status}</span>;
}
