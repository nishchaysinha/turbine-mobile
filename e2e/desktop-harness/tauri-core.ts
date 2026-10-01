/**
 * Fake Tauri backend for the desktop harness. Simulates PTYs with a tiny
 * shell so keystrokes from the phone produce real terminal output.
 */
type Handler = (args: any) => unknown;

const log: Array<{ cmd: string; args: unknown }> = [];
(window as any).__invokeLog = log;

const lines = new Map<string, string>();
const ROOT = '/Users/dev/project';

const FILES: Record<string, string> = {
  'README.md': '# api-server\n\nExpress API with rate limiting.\n\n## Scripts\n\n- `pnpm dev`\n- `pnpm test`\n',
  'package.json': '{\n  "name": "api-server",\n  "version": "1.4.0",\n  "scripts": {\n    "dev": "tsx watch src/server.ts",\n    "test": "vitest run"\n  },\n  "dependencies": {\n    "express": "^5.1.0",\n    "express-rate-limit": "^7.5.0"\n  }\n}\n',
  'src/server.ts': [
    "import express from 'express';",
    "import cors from 'cors';",
    "import { rateLimit } from './lib/rateLimit';",
    "import { routes } from './routes';",
    '',
    'export function createServer(port: number) {',
    '  const app = express();',
    "  app.use(cors({ origin: process.env.ALLOWED_ORIGIN ?? '*' }));",
    '  app.use(rateLimit({ windowMs: 60_000, max: 100 }));',
    '  app.use(routes);',
    '  app.get("/health", (_req, res) => res.json({ ok: true }));',
    '  return app.listen(port);',
    '}',
  ].join('\n'),
  'src/routes.ts': "import { Router } from 'express';\n\nexport const routes = Router();\nroutes.get('/users', (_req, res) => res.json([]));\n",
  'src/lib/db.ts': "export const db = new Map<string, unknown>();\n",
  'src/lib/rateLimit.ts': "export { rateLimit } from 'express-rate-limit';\n",
  'tests/server.test.ts': "import { describe, it } from 'vitest';\n\ndescribe('server', () => {\n  it('responds to /health', async () => {});\n});\n",
  'docs/LIMITS.md': '# Rate limits\n\n100 requests per minute per IP.\n',
};

function fileTree() {
  const entries = new Map<string, boolean>();
  for (const path of Object.keys(FILES)) {
    const parts = path.split('/');
    parts.forEach((_, i) => {
      const rel = parts.slice(0, i + 1).join('/');
      entries.set(rel, i < parts.length - 1);
    });
  }
  // Same snake_case shape as the Rust command.
  return [...entries].map(([relativePath, isDir]) => ({ path: `${ROOT}/${relativePath}`, relative_path: relativePath, is_dir: isDir }));
}

const day = (offset: number, hour: number) => {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  d.setHours(hour, 12, 0, 0);
  return d.toISOString();
};

const runsDb: any[] = [
  { id: 'run-past-1', task_id: null, project_path: ROOT, status: 'Completed', current_role: null, prompt: 'Fix the flaky websocket reconnect test', started_at: day(1, 16), updated_at: day(1, 16) },
  { id: 'run-past-2', task_id: null, project_path: ROOT, status: 'Failed', current_role: null, prompt: 'Upgrade express to v5 and fix breaking changes', started_at: day(3, 11), updated_at: day(3, 11) },
  { id: 'run-past-3', task_id: null, project_path: ROOT, status: 'Completed', current_role: null, prompt: 'Add OpenAPI docs for /users', started_at: day(3, 9), updated_at: day(3, 9) },
];
const agentsDb: Record<string, any[]> = {
  'run-past-1': [{ id: 'ap1', swarm_run_id: 'run-past-1', preset_id: 'claude-builder', pane_id: 'p', role: 'builder', command: 'claude', status: 'completed', exit_code: 0, output_summary: 'Replaced fixed sleeps with an event wait; 20/20 green runs', started_at: day(1, 16), completed_at: new Date(new Date(day(1, 16)).getTime() + 7 * 60000).toISOString() }],
  'run-past-2': [{ id: 'ap2', swarm_run_id: 'run-past-2', preset_id: 'claude-builder', pane_id: 'p', role: 'builder', command: 'claude', status: 'failed', exit_code: 1, output_summary: 'Router typings broke in 3 files', started_at: day(3, 11), completed_at: null }],
  'run-past-3': [
    { id: 'ap3', swarm_run_id: 'run-past-3', preset_id: 'claude-builder', pane_id: 'p', role: 'builder', command: 'claude', status: 'completed', exit_code: 0, output_summary: 'Added openapi.yaml', started_at: day(3, 9), completed_at: null },
    { id: 'ap4', swarm_run_id: 'run-past-3', preset_id: 'codex-reviewer', pane_id: 'p', role: 'reviewer', command: 'codex', status: 'completed', exit_code: 0, output_summary: 'LGTM', started_at: day(3, 9), completed_at: null },
  ],
};
const PROMPT = '\x1b[1;36mturbine\x1b[0m:\x1b[34m~/project\x1b[0m$ ';

function emit(paneId: string, text: string) {
  (window as any).__bridge?.sendTerminalOutput(paneId, text);
}

function runCommand(paneId: string, cmd: string): string {
  const trimmed = cmd.trim();
  if (!trimmed) return '';
  if (trimmed === 'ls') return '\x1b[34msrc\x1b[0m  \x1b[34mtests\x1b[0m  package.json  README.md  \x1b[32mbuild.sh\x1b[0m\r\n';
  if (trimmed.startsWith('echo ')) return trimmed.slice(5) + '\r\n';
  if (trimmed === 'git status')
    return 'On branch main\r\nChanges not staged for commit:\r\n\t\x1b[31mmodified:   src/server.ts\x1b[0m\r\n';
  if (trimmed === 'pnpm test')
    return ' \x1b[32m✓\x1b[0m src/server.test.ts (12 tests) 41ms\r\n\r\n \x1b[1mTest Files\x1b[0m  \x1b[32m1 passed\x1b[0m (1)\r\n';
  return `${trimmed.split(' ')[0]}: command not found\r\n`;
}

const handlers: Record<string, Handler> = {
  pty_write: ({ paneId, data }) => {
    const text = new TextDecoder().decode(new Uint8Array(data));
    let out = '';
    for (const ch of text) {
      if (ch === '\r' || ch === '\n') {
        const cmd = lines.get(paneId) || '';
        lines.set(paneId, '');
        out += '\r\n' + runCommand(paneId, cmd) + PROMPT;
      } else if (ch === '\x03') {
        lines.set(paneId, '');
        out += '^C\r\n' + PROMPT;
      } else if (ch === '\x7f') {
        const cur = lines.get(paneId) || '';
        if (cur) {
          lines.set(paneId, cur.slice(0, -1));
          out += '\b \b';
        }
      } else if (ch >= ' ') {
        lines.set(paneId, (lines.get(paneId) || '') + ch);
        out += ch;
      }
    }
    if (out) setTimeout(() => emit(paneId, out), 5);
  },
  pty_resize: () => undefined,
  list_workspace_files: ({ root }) => {
    if (root !== ROOT) throw new Error(`Path does not exist: ${root}`);
    return fileTree();
  },
  git_status: () => ({ 'src/server.ts': ' M', 'package.json': ' M', 'src/lib/rateLimit.ts': '??', 'docs/LIMITS.md': '??' }),
  read_file: ({ path }) => {
    const rel = String(path).replace(`${ROOT}/`, '');
    if (!(rel in FILES)) throw new Error(`Invalid path '${path}'`);
    const content = FILES[rel];
    return { content, totalSize: content.length, offset: 0, isComplete: true };
  },
  load_swarm_runs: ({ projectPath }) => runsDb.filter((r) => r.project_path === projectPath),
  load_swarm_agents: ({ swarmRunId }) => agentsDb[swarmRunId] ?? [],
  pty_take_output: () => new ArrayBuffer(0),
  get_git_review: (args) => ({ scope: 'all', diff: handlers.get_git_diff(args), base: null, branch: 'feature/rate-limit', truncated: false, untracked: 1 }),
  get_git_diff: ({ path }) => {
    if (path !== ROOT) throw new Error(`Git error: not a repo (${path})`);
    return [
      'diff --git a/src/server.ts b/src/server.ts',
      'index 3b18e51..a9c2f47 100644',
      '--- a/src/server.ts',
      '+++ b/src/server.ts',
      '@@ -1,6 +1,7 @@',
      " import express from 'express';",
      " import cors from 'cors';",
      "+import { rateLimit } from './lib/rateLimit';",
      " import { routes } from './routes';",
      ' ',
      ' export function createServer(port: number) {',
      '@@ -12,7 +13,9 @@ export function createServer(port: number) {',
      '   const app = express();',
      '-  app.use(cors());',
      "+  app.use(cors({ origin: process.env.ALLOWED_ORIGIN ?? '*' }));",
      '+  app.use(rateLimit({ windowMs: 60_000, max: 100 }));',
      '   app.use(routes);',
      '   app.get("/health", (_req, res) => res.json({ ok: true }));',
      '   return app.listen(port);',
      'diff --git a/package.json b/package.json',
      'index 1d2e3f4..5a6b7c8 100644',
      '--- a/package.json',
      '+++ b/package.json',
      '@@ -1,6 +1,6 @@',
      ' {',
      '   "name": "api-server",',
      '-  "version": "1.3.2",',
      '+  "version": "1.4.0",',
      '   "scripts": {',
      '     "dev": "tsx watch src/server.ts",',
      '@@ -8,5 +8,6 @@',
      '   "dependencies": {',
      '-    "express": "^5.1.0"',
      '+    "express": "^5.1.0",',
      '+    "express-rate-limit": "^7.5.0"',
      '   }',
      ' }',
    ].join('\n');
  },
  load_agent_presets: () => [
    { id: 'claude-builder', name: 'Claude Builder', role: 'builder', cli_command_template: 'claude' },
    { id: 'codex-reviewer', name: 'Codex Reviewer', role: 'reviewer', cli_command_template: 'codex' },
  ],
  save_task: () => undefined,
  save_swarm_run: ({ run }) => {
    const i = runsDb.findIndex((r) => r.id === run.id);
    if (i >= 0) runsDb[i] = run;
    else runsDb.push(run);
  },
  swarm_spawn_agent: ({ runId, presetId }) => ({
    id: `agent-${runId.slice(0, 6)}`,
    swarm_run_id: runId,
    preset_id: presetId,
    pane_id: 'agent-pane',
    role: presetId === 'codex-reviewer' ? 'reviewer' : 'builder',
    command: 'claude',
    status: 'running',
    exit_code: null,
    output_summary: null,
    started_at: new Date().toISOString(),
    completed_at: null,
  }),
  swarm_kill_agent: () => undefined,
};

export async function invoke<T>(cmd: string, args: any = {}): Promise<T> {
  log.push({ cmd, args });
  const handler = handlers[cmd];
  return (handler ? handler(args) : undefined) as T;
}

export { PROMPT };
