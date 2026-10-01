#!/usr/bin/env node
/**
 * Turbine Companion end-to-end test.
 *
 * Wires together the three real pieces over real WebRTC:
 *   - turbine-signaling's HTTP handlers (backed by an in-memory ntfy)
 *   - turbine's desktop P2PBridge + zustand stores (fake Tauri backend with a tiny shell)
 *   - turbine-mobile's actual app, built for web (WebView → iframe shim)
 * and drives the phone UI with Playwright, saving a screenshot per step.
 *
 * Env: TURBINE_DIR, SIGNALING_DIR (default: sibling checkouts), SKIP_WEB_BUILD=1, HEADED=1
 */
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { startFakeNtfy } from './fake-ntfy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const mobileDir = resolve(here, '..');
const turbineDir = resolve(process.env.TURBINE_DIR || join(mobileDir, '..', 'turbine'));
const signalingDir = resolve(process.env.SIGNALING_DIR || join(mobileDir, '..', 'turbine-signaling'));
const buildDir = join(here, '.build');
const shotsDir = join(here, 'screenshots');

const results = [];
let failurePage = null;
let shotIndex = 0;

function log(...args) {
  console.log('[e2e]', ...args);
}

// ---------------------------------------------------------------- build

async function buildAll() {
  mkdirSync(buildDir, { recursive: true });

  log('bundling signaling handlers from', signalingDir);
  await build({
    entryPoints: {
      create: join(signalingDir, 'api/pair/create.ts'),
      code: join(signalingDir, 'api/pair/[code].ts'),
    },
    outdir: join(buildDir, 'signaling'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    outExtension: { '.js': '.mjs' },
    logLevel: 'warning',
  });

  log('bundling desktop P2PBridge from', turbineDir);
  mkdirSync(join(buildDir, 'desktop'), { recursive: true });
  await build({
    entryPoints: [join(here, 'desktop-harness/entry.ts')],
    outfile: join(buildDir, 'desktop/bundle.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    alias: {
      '@turbine': join(turbineDir, 'src'),
      '@tauri-apps/api/core': join(here, 'desktop-harness/tauri-core.ts'),
      '@tauri-apps/api/event': join(here, 'desktop-harness/tauri-stubs.ts'),
      '@tauri-apps/api/webviewWindow': join(here, 'desktop-harness/tauri-stubs.ts'),
    },
    nodePaths: [join(turbineDir, 'node_modules')],
    logLevel: 'warning',
  });
  writeFileSync(join(buildDir, 'desktop/index.html'), readFileSync(join(here, 'desktop-harness/index.html')));

  const webOut = join(buildDir, 'web');
  if (process.env.SKIP_WEB_BUILD && existsSync(join(webOut, 'index.html'))) {
    log('reusing existing web build');
  } else {
    log('exporting companion app for web (expo export)…');
    rmSync(webOut, { recursive: true, force: true });
    execSync(`npx expo export --platform web --output-dir "${webOut}"`, {
      cwd: mobileDir,
      stdio: 'inherit',
      env: { ...process.env, CI: '1' },
    });
  }
}

// ---------------------------------------------------------------- servers

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf', '.ico': 'image/x-icon' };

function staticServer(root, spa) {
  return createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = join(root, path);
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
      file = existsSync(join(file, 'index.html')) ? join(file, 'index.html') : spa ? join(root, 'index.html') : '';
    }
    if (!file || !existsSync(file)) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream');
    res.end(readFileSync(file));
  });
}

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

async function startSignaling(ntfyUrl) {
  process.env.NTFY_URL = ntfyUrl;
  const create = (await import(pathToFileURL(join(buildDir, 'signaling/create.mjs')).href)).default;
  const code = (await import(pathToFileURL(join(buildDir, 'signaling/code.mjs')).href)).default;
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url.startsWith('/api/pair/create')) return void create(req, res);
    if (req.url.startsWith('/api/pair/')) return void code(req, res);
    res.statusCode = 404;
    res.end();
  });
  return { server, url: await listen(server), requests };
}

// ---------------------------------------------------------------- test helpers

async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    log(`✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - started, error: e?.message || String(e) });
    if (failurePage) {
      const file = `FAILED-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
      await failurePage.screenshot({ path: join(shotsDir, file) }).catch(() => {});
      log(`    screenshot: screenshots/${file}`);
    }
    log(`✗ ${name}\n    ${e?.stack || e}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function shot(page, name, caption) {
  const file = `${String(++shotIndex).padStart(2, '0')}-${name}.png`;
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shotsDir, file) });
  shots.push({ file, caption });
}
const shots = [];

async function waitFor(fn, msg, timeout = 15000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out: ${msg}${last instanceof Error ? ` (${last.message})` : ''}`);
}

// ---------------------------------------------------------------- scenario

async function main() {
  await buildAll();
  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });

  const ntfy = await startFakeNtfy();
  const signaling = await startSignaling(ntfy.url);
  const webUrl = await listen(staticServer(join(buildDir, 'web'), true));
  const desktopUrl = await listen(staticServer(join(buildDir, 'desktop'), false));
  log('signaling', signaling.url, '| app', webUrl, '| desktop', desktopUrl);

  const browser = await chromium.launch({
    headless: !process.env.HEADED,
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
  });

  // xterm.js is loaded from a CDN inside the terminal WebView; serve it locally.
  const xtermDir = join(here, 'node_modules/@xterm/xterm');
  const routeXterm = async (ctx) => {
    await ctx.route(/(cdn\.jsdelivr\.net|unpkg\.com)\/(npm\/)?@xterm\/xterm@[^/]+\/(.*)$/, (route) => {
      const rel = route.request().url().match(/@xterm\/xterm@[^/]+\/(.*)$/)[1].replace('xterm.min.', 'xterm.');
      const file = join(xtermDir, rel);
      if (!existsSync(file)) return route.fulfill({ status: 404 });
      route.fulfill({ body: readFileSync(file), contentType: MIME[extname(file)] || 'text/plain' });
    });
    // Public STUN/TURN hosts are unreachable here; local host candidates are enough.
  };

  const desktopCtx = await browser.newContext({ viewport: { width: 760, height: 420 } });
  const desktop = await desktopCtx.newPage();
  desktop.on('pageerror', (e) => log('desktop pageerror:', e.message));
  await desktop.goto(desktopUrl);

  const phoneCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });
  await routeXterm(phoneCtx);
  const phone = await phoneCtx.newPage();
  failurePage = phone;
  const phoneErrors = [];
  phone.on('pageerror', (e) => {
    phoneErrors.push(e.message);
    log('phone pageerror:', e.message);
  });

  let code = '';

  await step('Desktop registers an offer and shows a pairing code', async () => {
    await desktop.evaluate((url) => window.desktop.start(url), signaling.url);
    code = await desktop.locator('#code').innerText();
    assert(/^TRB-[2-9A-HJ-NP-Z]{6}$/.test(code), `pairing code format, got ${code}`);
    assert(signaling.requests.some((r) => r.startsWith('POST /api/pair/create')), 'offer POSTed');
    await shot(desktop, 'desktop-pairing-code', 'Turbine desktop (harness running the real P2PBridge) shows the pairing code');
  });

  await step('Phone shows the connect screen', async () => {
    await phone.goto(webUrl);
    await phone.getByText('Turbine Companion', { exact: true }).waitFor();
    await shot(phone, 'connect-screen', 'Connect screen: enter the code or scan the QR from the desktop');
  });

  await step('Wrong code shows a helpful error', async () => {
    await phone.getByPlaceholder('TRB-XXXXXX').fill('TRB-ZZZZZZ');
    await phone.getByText('Signaling Server URL', { exact: false }).waitFor();
    await phone.locator('input').nth(1).fill(signaling.url);
    await phone.getByText('Connect', { exact: true }).click();
    await phone.getByText(/not found or expired/).waitFor({ timeout: 15000 });
    await shot(phone, 'connect-error', 'Unknown or expired codes fail fast with a clear message');
  });

  await step('Phone pairs over WebRTC with a loosely typed code', async () => {
    // Lower-case, no prefix: the app normalizes it to TRB-XXXXXX.
    await phone.getByPlaceholder('TRB-XXXXXX').fill(code.slice(4).toLowerCase());
    await shot(phone, 'connect-code-entered', 'Code entered (case and prefix are normalized)');
    await phone.getByText('Connect', { exact: true }).click();
    await phone.getByText('api-server', { exact: true }).first().waitFor({ timeout: 25000 });
    await waitFor(() => desktop.evaluate(() => window.desktop.bridge.getStatus() === 'connected'), 'desktop connected');
  });

  await step('Tiled workspace mirrors the desktop layout with clean previews', async () => {
    for (const title of ['zsh', 'vitest --watch', 'dev server']) {
      await phone.getByText(title, { exact: true }).first().waitFor();
    }
    await phone.getByText(/13 passed/).first().waitFor();
    const text = await phone.locator('body').innerText();
    assert(!text.includes(']0;vitest') && !text.includes('[?25l'), 'escape sequences stripped from previews');
    await shot(phone, 'workspace-tiled', 'Tiled view mirrors the desktop split layout with live, sanitized previews');
  });

  const termFrame = () => phone.frameLocator('iframe[title="webview"] >> nth=1');
  const termText = () => termFrame().locator('.xterm-rows').innerText();

  await step('Focusing a pane replays its buffer in xterm', async () => {
    await phone.getByText('zsh', { exact: true }).first().click();
    await phone.getByText('Tiled Layout').waitFor();
    await waitFor(async () => (await termText()).includes('Last login'), 'replay buffer rendered');
    await phone.getByText('(100×30)').waitFor();
    await shot(phone, 'terminal-focused', 'Focused terminal: 1:1 xterm at the desktop PTY size (100×30), fit to width');
  });

  await step('Direct typing goes straight to the desktop PTY', async () => {
    await phone.getByLabel('Type', { exact: true }).click();
    await termFrame().locator('.xterm-helper-textarea').focus();
    await termFrame().locator('.xterm-helper-textarea').pressSequentially('echo hello-from-phone');
    await termFrame().locator('.xterm-helper-textarea').press('Enter');
    await waitFor(async () => (await termText()).match(/hello-from-phone[\s\S]*hello-from-phone/), 'echo output');
    const writes = await desktop.evaluate(() => window.desktop.invokes().filter((c) => c.cmd === 'pty_write').length);
    assert(writes > 5, `keystrokes reached pty_write (${writes})`);
    await shot(phone, 'terminal-direct-typing', 'Direct mode: each keystroke is written to the desktop PTY');
  });

  await step('Compose mode sends a whole line', async () => {
    await phone.getByLabel('Toggle compose mode').click();
    const input = phone.getByPlaceholder('Type a command or prompt, then Send');
    await input.fill('ls');
    await shot(phone, 'terminal-compose', 'Compose mode (from Orca): write the full command, then Send');
    await phone.getByLabel('Send').click();
    await waitFor(async () => (await termText()).includes('package.json'), 'ls output');
    await input.fill('git status');
    await input.press('Enter');
    await waitFor(async () => (await termText()).includes('modified:'), 'git status output');
    await shot(phone, 'terminal-compose-output', 'Command output streamed back over the DataChannel');
  });

  await step('Sticky Ctrl applies to the next key', async () => {
    await phone.getByText('Ctrl', { exact: true }).click();
    await phone.getByText('CTRL •').waitFor();
    await shot(phone, 'terminal-ctrl-armed', 'Ctrl armed in the key bar');
    const before = await desktop.evaluate(() => window.desktop.invokes().length);
    await phone.getByLabel('Toggle compose mode').click(); // back to direct mode
    await termFrame().locator('.xterm-helper-textarea').focus();
    await termFrame().locator('.xterm-helper-textarea').press('c');
    const sent = await waitFor(
      () =>
        desktop.evaluate(
          (n) =>
            window.desktop
              .invokes()
              .slice(n)
              .find((c) => c.cmd === 'pty_write'),
          before
        ),
      'ctrl write'
    );
    assert(JSON.stringify(sent.args.data) === '[3]', `Ctrl+C byte sent, got ${JSON.stringify(sent.args.data)}`);
    await waitFor(async () => (await termText()).includes('^C'), '^C echoed');
  });

  await step('Desktop output streams live into the focused terminal', async () => {
    await desktop.evaluate(() => window.desktop.output('pane-shell', '\r\n\x1b[33mbuild finished in 4.2s\x1b[0m\r\n'));
    await waitFor(async () => (await termText()).includes('build finished in 4.2s'), 'live output');
    await phone.getByText('Tiled Layout').click();
  });

  await step('Switching workspaces', async () => {
    await phone.getByText('web-app', { exact: true }).click();
    await phone.getByText('next dev', { exact: true }).waitFor();
    await waitFor(() => desktop.evaluate(() => window.desktop.activeWorkspace() === 'ws-web'), 'desktop switched workspace');
    await shot(phone, 'workspace-switch', 'Workspace tabs switch the desktop workspace too');
    await phone.getByText('api-server', { exact: true }).click();
  });

  await step('Swarm: launch a run with a chosen agent preset', async () => {
    await phone.getByText('Swarm', { exact: true }).click();
    await phone.getByText('+ New Run').click();
    await phone.getByText('Codex Reviewer').waitFor();
    await phone.getByText('Claude Builder').click();
    await phone.getByPlaceholder(/JWT/).fill('Add rate limiting to the API and cover it with tests');
    await shot(phone, 'swarm-new-run', 'Launch a swarm run and pick which agent preset to spawn');
    await phone.getByText('Launch Swarm').click();
    await phone.getByText('Add rate limiting to the API and cover it with tests').waitFor();
    await phone.getByLabel('Reply to builder').waitFor({ timeout: 10000 });
    const spawned = await desktop.evaluate(() => window.desktop.invokes().find((c) => c.cmd === 'swarm_spawn_agent'));
    assert(spawned?.args.presetId === 'claude-builder' && spawned.args.cwd === '/Users/dev/project', 'agent spawned in project dir');
    await shot(phone, 'swarm-running', 'Run is live on the desktop; the agent can be messaged or stopped');
  });

  await step('Swarm: send a follow-up to the running agent', async () => {
    await phone.getByLabel('Reply to builder').click();
    await phone.getByPlaceholder(/edge cases/).fill('Also document the limits in README');
    await shot(phone, 'swarm-follow-up', 'Follow-up messages are typed into the agent terminal');
    await phone.getByText('Send', { exact: true }).click();
    const write = await waitFor(
      () => desktop.evaluate(() => window.desktop.invokes().find((c) => c.cmd === 'pty_write' && c.args.paneId === 'agent-pane')),
      'follow-up write'
    );
    const text = Buffer.from(write.args.data).toString();
    assert(text === 'Also document the limits in README\r', `follow-up text, got ${JSON.stringify(text)}`);
  });

  await step('Agent completion shows an in-app notification', async () => {
    await phone.getByText('Tasks', { exact: true }).click();
    await desktop.evaluate(() => window.desktop.finishAgent('Added express-rate-limit (100 req/min) + 6 tests'));
    await phone.getByText(/builder finished/).waitFor({ timeout: 10000 });
    await shot(phone, 'agent-finished-toast', 'When an agent finishes you get a banner (and a push notification when backgrounded)');
    await phone.getByText(/builder finished/).click();
    await phone.getByText(/6 tests/).waitFor();
    await shot(phone, 'swarm-completed', 'Completed run with the agent summary');
  });

  await step('Tasks: create a task from the phone', async () => {
    await phone.getByText('Tasks', { exact: true }).click();
    await phone.getByText('Add rate limiting to API').waitFor();
    await shot(phone, 'tasks-board', 'Kanban board synced from the desktop');
    await phone.getByText('+ Add Task').click();
    const input = phone.getByPlaceholder(/Task title/);
    await input.fill('Rotate API keys');
    await shot(phone, 'tasks-new', 'Creating a task from the phone');
    await phone.getByText('Create', { exact: true }).click();
    await phone.getByText('Rotate API keys').waitFor();
    const created = await desktop.evaluate(() => window.desktop.tasks().find((t) => t.title === 'Rotate API keys'));
    assert(created?.project_path === '/Users/dev/project', `task created in project, got ${created?.project_path}`);
  });

  const ptyText = (call) => Buffer.from(call.args.data).toString();
  const spawnsSince = (n) =>
    desktop.evaluate((n) => window.desktop.invokes().slice(n).filter((c) => c.cmd === 'swarm_spawn_agent'), n);
  const invokeCount = () => desktop.evaluate(() => window.desktop.invokes().length);

  async function addNote(label, text) {
    await phone.getByLabel(label, { exact: true }).click();
    await phone.getByText(/^(Add review note|Edit note)$/).waitFor();
    await phone.getByPlaceholder('What should change here?').fill(text);
    await phone.getByText('Save note', { exact: true }).click();
    await phone.getByText(text).first().waitFor();
  }

  await step('Code: review changes per file and leave line notes', async () => {
    await phone.getByText('Code', { exact: true }).click();
    await phone.getByText('src/server.ts', { exact: true }).waitFor();
    await phone.getByText('package.json', { exact: true }).first().waitFor();
    const call = await desktop.evaluate(() => window.desktop.invokes().find((c) => c.cmd === 'get_git_diff'));
    assert(call.args.path === '/Users/dev/project', `diff path, got ${JSON.stringify(call.args)}`);
    await shot(phone, 'code-changes', 'Code → Changes: per-file diffs with old/new line numbers; tap any line to comment');
    await addNote('Comment on src/server.ts line 15', 'Make the limit configurable via RATE_LIMIT_MAX');
    await phone.getByLabel('Next change').click();
    await addNote('Comment on package.json line 3', 'Add a CHANGELOG entry for 1.4.0');
    await phone.getByText('2 review notes').waitFor();
    await shot(phone, 'code-review-notes', 'Review notes sit inline under the lines they refer to');
  });

  await step('Code: send the review to a new agent run', async () => {
    const before = await invokeCount();
    await phone.getByText('Send to agent →').click();
    await phone.getByText('Send 2 notes').waitFor();
    await phone.getByText('▸ Preview prompt').click();
    await phone.getByText(/You are reviewing the current working tree/).waitFor();
    await shot(phone, 'code-send-review', 'Send notes to a running agent, a new run, or the focused terminal (Orca’s review-note format)');
    await phone.getByLabel('Start Claude Builder with review').click();
    const spawns = await waitFor(async () => {
      const s = await spawnsSince(before);
      return s.length ? s : null;
    }, 'review run spawned');
    const prompt = spawns[0].args.prompt;
    assert(prompt.includes('User comment: "Make the limit configurable via RATE_LIMIT_MAX"'), 'note in prompt');
    assert(prompt.indexOf('File: package.json') < prompt.indexOf('File: src/server.ts'), 'notes sorted by file');
    assert(prompt.includes('Line: 15') && prompt.includes('Code: app.use(rateLimit'), 'line + code context');
    await phone.getByText('2 review notes').waitFor({ state: 'detached' });
  });

  await step('Code: send a note to the running agent as a single paste', async () => {
    await addNote('Comment on src/server.ts line 15', 'Also cover the 429 response in tests');
    const before = await invokeCount();
    await phone.getByText('Send to agent →').click();
    await phone.getByLabel('Send review to builder').first().click();
    const write = await waitFor(
      () =>
        desktop.evaluate(
          (n) => window.desktop.invokes().slice(n).find((c) => c.cmd === 'pty_write' && c.args.paneId === 'agent-pane'),
          before
        ),
      'review pasted into agent'
    );
    const text = ptyText(write);
    assert(text.startsWith('\x1b[200~') && text.endsWith('\x1b[201~\r'), 'bracketed paste + submit');
    assert(text.includes('Also cover the 429 response in tests') && text.includes('\n'), 'multi-line prompt delivered whole');
  });

  await step('Files: browse the project lazily with git badges', async () => {
    await phone.getByText('Files', { exact: true }).click();
    await phone.getByText('README.md', { exact: true }).waitFor();
    await phone.getByLabel('Folder src').click();
    await phone.getByText('server.ts', { exact: true }).waitFor();
    await phone.getByLabel('Folder lib').click();
    await phone.getByText('rateLimit.ts', { exact: true }).waitFor();
    await phone.getByLabel('Folder docs').click();
    await phone.getByText('LIMITS.md', { exact: true }).waitFor();
    const lists = await desktop.evaluate(() => window.desktop.invokes().filter((c) => c.cmd === 'list_workspace_files').length);
    assert(lists === 1, `file tree cached between folder opens (${lists} scans)`);
    await shot(phone, 'files-tree', 'Code → Files: lazy tree, folders first, git badges (M modified, U untracked)');
  });

  await step('Files: preview a file and comment on a line', async () => {
    await phone.getByLabel('File server.ts').click();
    await phone.getByText(/13 lines/).waitFor();
    await phone.getByText('  app.use(routes);', { exact: true }).waitFor();
    await shot(phone, 'file-preview', 'File preview with line numbers; tap a line to add a review note');
    await phone.getByText('  app.use(routes);', { exact: true }).click();
    await phone.getByPlaceholder('What should change here?').fill('Mount routes under /api');
    await phone.getByText('Save note', { exact: true }).click();
    await phone.getByLabel('Close preview').click();
    await phone.getByText(/Changes · 1💬/).waitFor();
  });

  await step('History: search past runs and re-run one', async () => {
    await phone.getByText('Swarm', { exact: true }).click();
    await phone.getByText('History', { exact: true }).click();
    await phone.getByText('Fix the flaky websocket reconnect test').waitFor();
    await phone.getByText('Today', { exact: true }).waitFor();
    await phone.getByText('Yesterday', { exact: true }).waitFor();
    await phone.getByText('Completed', { exact: true }).first().waitFor();
    assert(!(await phone.getByText('Initializing', { exact: true }).count()), 'live run status shown, not the stale DB copy');
    await shot(phone, 'history', 'Swarm → History: past runs for the project grouped by day, with agent summaries');
    await phone.getByPlaceholder('Search prompts, agents, summaries').fill('flaky');
    await phone.getByText('Upgrade express to v5 and fix breaking changes').waitFor({ state: 'detached' });
    await phone.getByText('Fix the flaky websocket reconnect test').click();
    await phone.getByText(/20\/20 green runs/).waitFor();
    await shot(phone, 'history-search', 'Search across prompts and summaries; tap a run for details');
    const before = await invokeCount();
    await phone.getByLabel('Re-run Fix the flaky websocket reconnect test').click();
    const spawns = await waitFor(async () => {
      const s = await spawnsSince(before);
      return s.length ? s : null;
    }, 're-run spawned');
    assert(spawns[0].args.prompt === 'Fix the flaky websocket reconnect test', 'same prompt');
    assert(spawns[0].args.presetId === 'claude-builder', 'same preset');
    await phone.getByText(/Live \(\d+\)/).waitFor();
  });

  await step('Control: latency, pairing info and connection log', async () => {
    await phone.getByText('Control', { exact: true }).click();
    await phone.getByText(/^⚡ \d+ms$/).waitFor({ timeout: 10000 });
    await phone.getByText('3 panes').waitFor();
    await phone.getByText('1 pane', { exact: true }).waitFor();
    await phone.getByText(code).first().waitFor();
    await shot(phone, 'control', 'Control tab: live latency, pairing code, workspace switcher and connection log');
  });

  await step('A second phone cannot hijack a live session', async () => {
    const r = await fetch(`${signaling.url}/api/pair/${code}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: { type: 'answer', sdp: 'evil' } }),
    });
    assert(r.status === 409, `second answer rejected with 409, got ${r.status}`);
    const g = await (await fetch(`${signaling.url}/api/pair/${code}`)).json();
    assert(!('token' in g) && !('tokenHash' in g), 'GET does not leak the session token');
  });

  await step('Auto-reconnect after the link drops (same code)', async () => {
    await desktop.evaluate(() => window.desktop.dropPeer());
    await phone.getByText(/reconnecting to desktop/).waitFor({ timeout: 10000 });
    await shot(phone, 'reconnecting', 'Link dropped: the app keeps its state and retries with the same code');
    await phone.getByText(/reconnecting to desktop/).waitFor({ state: 'detached', timeout: 40000 });
    await waitFor(() => desktop.evaluate(() => window.desktop.bridge.getStatus() === 'connected'), 'desktop reconnected', 20000);
    const codeAfter = await desktop.locator('#code').innerText();
    assert(codeAfter === code, `same pairing code after re-arm (${codeAfter})`);
    await shot(phone, 'reconnected', 'Reconnected automatically, no re-pairing needed');
  });

  await step('Disconnect returns to connect screen with recent desktops', async () => {
    await phone.getByText('Disconnect Session').click();
    await phone.getByText('Recent desktops').waitFor();
    await phone.getByText(code).first().waitFor();
    await phone.getByText('▸ Connection log').click();
    await phone.getByText(/Status: connecting → connected/).first().waitFor();
    await shot(phone, 'recent-desktops', 'Recent desktops (Orca-style host list) and the connection log for troubleshooting');
  });

  await step('One-tap reconnect from recent desktops', async () => {
    await phone.getByText(code).first().click();
    await phone.getByText('api-server', { exact: true }).first().waitFor({ timeout: 30000 });
  });

  await step('No uncaught errors in the phone app', async () => {
    assert(phoneErrors.length === 0, `page errors: ${phoneErrors.join(' | ')}`);
  });

  await browser.close();
  signaling.server.close();
  ntfy.server.close();

  writeReport();
  const failed = results.filter((r) => !r.ok);
  log(`${results.length - failed.length}/${results.length} steps passed`);
  process.exit(failed.length ? 1 : 0);
}

function writeReport() {
  const lines = [
    '# Turbine Companion – end-to-end flow',
    '',
    'Generated by `e2e/run.mjs`. Each screenshot is taken from the real companion app (web build) talking to the real desktop `P2PBridge` over a real WebRTC DataChannel, with pairing via the real `turbine-signaling` handlers.',
    '',
    '## Steps',
    '',
    '| Result | Step | Time |',
    '| --- | --- | --- |',
    ...results.map((r) => `| ${r.ok ? '✅' : '❌'} | ${r.name}${r.error ? `<br><sub>${r.error.replace(/\|/g, '\\|').slice(0, 300)}</sub>` : ''} | ${r.ms}ms |`),
    '',
    '## Screens',
    '',
    ...shots.flatMap((s) => [`### ${s.caption}`, '', `![${s.caption}](./${s.file})`, '']),
  ];
  writeFileSync(join(shotsDir, 'README.md'), lines.join('\n'));
}

main().catch((e) => {
  console.error(e);
  try {
    writeReport();
  } catch {}
  process.exit(1);
});
