/**
 * Fake Tauri backend for the desktop harness. Simulates PTYs with a tiny
 * shell so keystrokes from the phone produce real terminal output.
 */
type Handler = (args: any) => unknown;

const log: Array<{ cmd: string; args: unknown }> = [];
(window as any).__invokeLog = log;

const lines = new Map<string, string>();
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
  pty_take_output: () => new ArrayBuffer(0),
  get_git_diff: ({ path }) => {
    if (path !== '/Users/dev/project') throw new Error(`Git error: not a repo (${path})`);
    return [
      'diff --git a/src/server.ts b/src/server.ts',
      'index 3b18e51..a9c2f47 100644',
      '--- a/src/server.ts',
      '+++ b/src/server.ts',
      '@@ -12,7 +12,9 @@ export function createServer(port: number) {',
      '   const app = express();',
      '-  app.use(cors());',
      "+  app.use(cors({ origin: process.env.ALLOWED_ORIGIN ?? '*' }));",
      '+  app.use(rateLimit({ windowMs: 60_000, max: 100 }));',
      '   app.get("/health", (_req, res) => res.json({ ok: true }));',
      '   return app.listen(port);',
      ' }',
    ].join('\n');
  },
  load_agent_presets: () => [
    { id: 'claude-builder', name: 'Claude Builder', role: 'builder', cli_command_template: 'claude' },
    { id: 'codex-reviewer', name: 'Codex Reviewer', role: 'reviewer', cli_command_template: 'codex' },
  ],
  save_task: () => undefined,
  save_swarm_run: () => undefined,
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
