#!/usr/bin/env node
/**
 * Real end-to-end: the actual Turbine desktop app (debug build: real PTYs,
 * Rust agent status hub, LAN WebSocket server) on a virtual display, paired
 * with the actual companion app (web build in Chromium) over the LAN
 * transport. Nothing is faked on either side.
 *
 * Needs: TURBINE_DIR with `src-tauri/target/debug/turbine-app` built and the
 * Vite dev server running (`pnpm dev`), Xvfb + ImageMagick, and the web build
 * from `node run.mjs` (or SKIP_WEB_BUILD unset to build it).
 *
 * Output: e2e/screenshots-real/*.png + README.md
 */
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const mobileDir = resolve(here, '..');
const turbineDir = resolve(process.env.TURBINE_DIR || join(mobileDir, '..', 'turbine'));
const webDir = join(here, '.build/web');
const outDir = join(here, 'screenshots-real');
const DISPLAY = process.env.DISPLAY_NUM || ':97';
const BRIDGE = 'http://127.0.0.1:4446';
const LAN_PORT = 6971;
const results = [];
const shots = [];
const children = [];
let n = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[real-e2e]', ...a);
const assert = (c, m) => {
  if (!c) throw new Error(`Assertion failed: ${m}`);
};

async function ev(js) {
  const body = `const __r = await (async () => { ${js}\n })(); return JSON.stringify(__r === undefined ? null : __r);`;
  const text = await (await fetch(`${BRIDGE}/eval`, { method: 'POST', body })).text();
  if (text.startsWith('ERR:')) throw new Error(text);
  return JSON.parse(text);
}

async function waitFor(fn, msg, timeout = 20000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(250);
  }
  throw new Error(`Timed out: ${msg}${last instanceof Error ? ` (${last.message})` : ''}`);
}

async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t });
    log(`✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t, error: e.message });
    log(`✗ ${name}\n    ${e.stack || e}`);
  }
}

async function phoneShot(page, name, caption) {
  const file = `${String(++n).padStart(2, '0')}-phone-${name}.png`;
  await sleep(300);
  await page.screenshot({ path: join(outDir, file) });
  shots.push({ file, caption });
}

function desktopShot(name, caption) {
  const file = `${String(++n).padStart(2, '0')}-desktop-${name}.png`;
  execSync(`import -window root -crop 1280x800+0+0 "${join(outDir, file)}"`, { env: { ...process.env, DISPLAY } });
  shots.push({ file, caption });
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-real-'));
  const sh = (c) => execSync(c, { cwd: dir, stdio: 'pipe', shell: '/bin/sh' });
  sh('git init -q -b main && git config user.email e2e@example.com && git config user.name e2e');
  mkdirSync(join(dir, 'src/lib'), { recursive: true });
  writeFileSync(join(dir, 'src/server.ts'), "export function createServer() {\n  return 'ok';\n}\n");
  writeFileSync(join(dir, 'package.json'), '{\n  "name": "api-server",\n  "version": "1.3.2"\n}\n');
  writeFileSync(join(dir, 'README.md'), '# api-server\n');
  sh('git add -A && git commit -qm init');
  writeFileSync(join(dir, 'package.json'), '{\n  "name": "api-server",\n  "version": "1.4.0"\n}\n');
  writeFileSync(join(dir, 'src/lib/rateLimit.ts'), "export const limit = 100;\n");
  return dir;
}

function staticServer(root) {
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.ttf': 'font/ttf', '.png': 'image/png' };
  const server = createServer((req, res) => {
    let file = join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!existsSync(file) || !extname(file)) file = join(root, 'index.html');
    res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream');
    res.end(readFileSync(file));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

async function main() {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  if (!existsSync(join(webDir, 'index.html'))) {
    log('building the web app…');
    execSync(`npx expo export --platform web --output-dir "${webDir}"`, { cwd: mobileDir, stdio: 'inherit', env: { ...process.env, CI: '1' } });
  }
  const app = join(turbineDir, 'src-tauri/target/debug/turbine-app');
  assert(existsSync(app), `missing ${app}`);
  const repo = makeRepo();

  children.push(spawn('Xvfb', [DISPLAY, '-screen', '0', '1280x800x24'], { stdio: 'ignore' }));
  await sleep(800);
  const home = mkdtempSync(join(tmpdir(), 'turbine-real-home-'));
  children.push(
    spawn(app, [], {
      cwd: repo,
      stdio: 'ignore',
      env: {
        ...process.env,
        DISPLAY,
        HOME: home,
        XDG_DATA_HOME: join(home, '.local/share'),
        WEBKIT_DISABLE_DMABUF_RENDERER: '1',
        WEBKIT_DISABLE_COMPOSITING_MODE: '1',
      },
    }),
  );
  await waitFor(async () => (await fetch(`${BRIDGE}/ping`)).ok, 'desktop debug bridge', 60000);
  // The reload can tear down the page before the bridge answers; that's fine.
  await ev("localStorage.setItem('turbine.terminalRenderer','dom'); setTimeout(() => location.reload(), 50); return 1").catch(() => {});
  await sleep(4000);
  await waitFor(() => ev('return Boolean(window.__turbine)'), 'desktop app ready', 30000);

  let pane = '';
  let lan = null;

  await step('Desktop: open the project and enable LAN pairing', async () => {
    pane = await ev(`
      const T = window.__turbine;
      const ws = T.workspace.getState().createWorkspace('api-server');
      T.workspace.setState((s) => ({ workspaces: s.workspaces.map((w) => w.id === ws.id ? { ...w, panes: w.panes.map((p) => ({ ...p, type: 'terminal', workingDirectory: ${JSON.stringify(repo)}, title: 'claude · api' })) } : w) }));
      await new Promise((r) => setTimeout(r, 2000));
      return T.workspace.getState().workspaces.find((w) => w.id === ws.id).panes[0].id;`);
    lan = await ev(`return await window.__turbine.bridge.startLan(${LAN_PORT});`);
    assert(lan.running && lan.token.length >= 16, 'LAN server running');
    await ev(`
      document.querySelector('[aria-label="Mobile Companion"]')?.click() ?? [...document.querySelectorAll('button')].find((b) => b.innerText.includes('Companion'))?.click();
      await new Promise((r) => setTimeout(r, 800));
      return 1;`);
    desktopShot('companion-lan', 'Desktop: Companion → Local network (on Linux WebKitGTK has no WebRTC, so this is the transport)');
    await ev(`document.querySelector('.companion-close-btn')?.click(); return 1;`);
  });

  const { url: webUrl } = await staticServer(webDir);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const xterm = join(here, 'node_modules/@xterm/xterm');
  await ctx.route(/@xterm\/xterm@[^/]+\/(.*)$/, (route) => {
    const rel = route.request().url().match(/@xterm\/xterm@[^/]+\/(.*)$/)[1].replace('xterm.min.', 'xterm.');
    const file = join(xterm, rel);
    return existsSync(file) ? route.fulfill({ body: readFileSync(file), contentType: rel.endsWith('.css') ? 'text/css' : 'text/javascript' }) : route.fulfill({ status: 404 });
  });
  const phone = await ctx.newPage();
  const errors = [];
  phone.on('pageerror', (e) => errors.push(e.message));
  const termText = () => phone.frameLocator('iframe[title="webview"] >> nth=1').locator('.xterm-rows').innerText();
  const desktopBuffer = () =>
    ev(`const t = window.__turbineTerminals.get(${JSON.stringify(pane)}).terminal.buffer.active; let s=''; for (let i=0;i<t.length;i++) s += (t.getLine(i)?.translateToString(true) ?? '') + '\\n'; return s;`);

  await step('Phone pairs with the real desktop over LAN', async () => {
    await phone.goto(webUrl);
    await phone.getByText('▸ Connect over local network').click();
    await phone.getByPlaceholder('192.168.1.20:6970').fill(`127.0.0.1:${LAN_PORT}`);
    await phone.getByPlaceholder('32-character token').fill(lan.token);
    await phoneShot(phone, 'connect-lan', 'Phone: connect over the local network with the address and token from the desktop');
    await phone.getByLabel('Connect over LAN').click();
    await phone.getByText('Live from your desktop').waitFor({ timeout: 20000 });
    const peers = await waitFor(() => ev('return window.__turbine.bridge.getPeers().map((p) => p.deviceName)'), 'desktop sees phone');
    assert(peers[0] === 'Phone (LAN)', `desktop peer ${peers}`);
    const caps = await waitFor(async () => {
      const c = await ev('return [...window.__turbine.bridge.peerCaps].sort()');
      return c.length ? c : null;
    }, 'hello');
    assert(caps.join(',') === 'agents,rpc,terminal.subscribe', `capabilities ${caps}`);
  });

  await step('Wrong token is rejected by the desktop', async () => {
    const status = await new Promise((resolveStatus) => {
      const req = createServer();
      void req;
      import('node:http').then(({ request }) => {
        const r = request({ host: '127.0.0.1', port: LAN_PORT, path: '/?token=nope', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
        r.on('response', (res) => resolveStatus(res.statusCode));
        r.on('upgrade', () => resolveStatus(101));
        r.on('error', () => resolveStatus(0));
        r.end();
      });
    });
    assert(status === 401, `unauthorized handshake rejected, got ${status}`);
  });

  await step('Phone types into a real desktop shell', async () => {
    await phone.getByText('Terminals', { exact: true }).click();
    await phone.getByText('claude · api', { exact: true }).first().click();
    await phone.getByLabel('Toggle compose mode').click();
    const input = phone.getByPlaceholder('Type a command or prompt, then Send');
    await input.fill('echo "real e2e $((6*7))" && git status --short');
    await phone.getByLabel('Send').click();
    await waitFor(async () => (await termText()).includes('real e2e 42'), 'output on phone');
    const desk = await desktopBuffer();
    assert(desk.includes('real e2e 42') && desk.includes('?? src/'), 'same output on the desktop terminal');
    await phoneShot(phone, 'terminal', 'Phone: a real shell on the desktop — the command ran there and streamed back');
  });

  await step('Agent hooks from the real terminal reach the phone; Approve reaches the PTY', async () => {
    const input = phone.getByPlaceholder('Type a command or prompt, then Send');
    await input.fill(`printf '%s' '{"prompt":"Add rate limiting"}' | "$TURBINE_HOOK_SCRIPT" UserPromptSubmit claude >/dev/null; printf '%s' '{"message":"Claude needs your permission to use Bash","notification_type":"permission_prompt"}' | "$TURBINE_HOOK_SCRIPT" Notification claude >/dev/null; read -p "approve? " ans; echo "answered[$ans]"`);
    await phone.getByLabel('Send').click();
    await phone.getByText('Tiled Layout').click();
    await phone.getByText('Agents', { exact: true }).click();
    await phone.getByText('Claude needs your permission to use Bash').waitFor({ timeout: 15000 });
    await phoneShot(phone, 'agents-needs-you', 'Phone: the real agent hook reported “needs you” through the desktop’s status hub');
    await phone.getByLabel('Approve claude · api').click();
    await waitFor(async () => (await desktopBuffer()).includes('answered[]'), 'Enter delivered to the desktop PTY');
    await ev(`document.querySelector('[aria-label="Agents"]').click(); return 1;`);
    await sleep(600);
    desktopShot('agents', 'Desktop: the same agent in the Agents panel (one store, every reader subscribes)');
  });

  await step('Code tab shows the real git changes, including the new file', async () => {
    await phone.getByText('Code', { exact: true }).click();
    await phone.getByText('package.json', { exact: true }).first().waitFor({ timeout: 15000 });
    await phone.getByText('src/lib/rateLimit.ts', { exact: true }).waitFor();
    await phoneShot(phone, 'code', 'Phone: real working-tree diff (staged, unstaged and untracked)');
    await phone.getByText('Files', { exact: true }).click();
    await phone.getByText('README.md', { exact: true }).waitFor();
    await phoneShot(phone, 'files', 'Phone: browsing the real project on disk');
  });

  await step('No page errors on the phone', async () => {
    assert(errors.length === 0, errors.join(' | '));
  });

  await browser.close();
  writeFileSync(
    join(outDir, 'README.md'),
    [
      '# Real desktop ⇄ real phone (LAN)',
      '',
      'Generated by `e2e/real-desktop.mjs`: the actual Turbine debug build (real PTYs, Rust agent hub, LAN server) paired with the actual companion app over the LAN transport.',
      '',
      '| Result | Step | Time |',
      '| --- | --- | --- |',
      ...results.map((r) => `| ${r.ok ? '✅' : '❌'} | ${r.name}${r.error ? `<br><sub>${r.error.slice(0, 300).replace(/\|/g, '\\|')}</sub>` : ''} | ${r.ms}ms |`),
      '',
      ...shots.flatMap((s) => [`### ${s.caption}`, '', `![${s.caption}](./${s.file})`, '']),
    ].join('\n'),
  );
  const failed = results.filter((r) => !r.ok).length;
  log(`${results.length - failed}/${results.length} steps passed`);
  children.reverse().forEach((c) => c.kill());
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  children.reverse().forEach((c) => c.kill());
  process.exit(1);
});
