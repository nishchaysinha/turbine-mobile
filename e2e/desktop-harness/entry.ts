import { p2pBridge } from '@turbine/services/p2pBridge';
import { useWorkspaceStore } from '@turbine/state/workspaceStore';
import { useSwarmStore } from '@turbine/state/swarmStore';
import { useTaskStore } from '@turbine/state/taskStore';
import { PROMPT } from './tauri-core';

/**
 * Stand-in for Turbine Desktop: the real P2PBridge and zustand stores,
 * seeded with a realistic workspace, driven from Playwright via window.desktop.
 */
(window as any).__bridge = p2pBridge;

const pane = (id: string, title: string) => ({
  id,
  workspaceId: 'ws-main',
  type: 'terminal',
  workingDirectory: '/Users/dev/project',
  startupCommand: null,
  label: null,
  title,
  taskId: null,
});

useWorkspaceStore.setState({
  activeWorkspaceId: 'ws-main',
  workspaces: [
    {
      id: 'ws-main',
      name: 'api-server',
      tabColor: '#00e5c8',
      tabOrder: 0,
      isActive: true,
      boardColumns: null,
      layout: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.55,
        children: [
          { type: 'leaf', paneId: 'pane-shell' },
          {
            type: 'split',
            direction: 'vertical',
            ratio: 0.5,
            children: [
              { type: 'leaf', paneId: 'pane-tests' },
              { type: 'leaf', paneId: 'pane-logs' },
            ],
          },
        ],
      },
      panes: [pane('pane-shell', 'zsh'), pane('pane-tests', 'vitest --watch'), pane('pane-logs', 'dev server')],
    },
    {
      id: 'ws-web',
      name: 'web-app',
      tabColor: '#c792ea',
      tabOrder: 1,
      isActive: false,
      boardColumns: null,
      layout: { type: 'leaf', paneId: 'pane-web' },
      panes: [{ ...pane('pane-web', 'next dev'), workspaceId: 'ws-web' }],
    },
  ] as any,
});

useTaskStore.setState({
  tasks: [
    { id: 't1', project_path: '/Users/dev/project', title: 'Add rate limiting to API', description: 'Use express-rate-limit, 100 req/min', status: 'todo', linked_files_json: '[]' },
    { id: 't2', project_path: '/Users/dev/project', title: 'Fix flaky websocket test', description: null, status: 'in_progress', linked_files_json: '[]' },
    { id: 't3', project_path: '/Users/dev/project', title: 'Write deployment docs', description: null, status: 'review', linked_files_json: '[]' },
  ] as any,
});

// Initial terminal content, as if the panes had been running for a while.
p2pBridge.setTerminalDimensions('pane-shell', 100, 30);
p2pBridge.setTerminalDimensions('pane-tests', 80, 14);
p2pBridge.setTerminalDimensions('pane-logs', 80, 14);
p2pBridge.setTerminalDimensions('pane-web', 90, 24);
p2pBridge.setActivePaneId('pane-shell');
p2pBridge.sendTerminalOutput('pane-shell', `Last login: Thu Oct  1 09:12:44 on ttys003\r\n${PROMPT}`);
p2pBridge.sendTerminalOutput(
  'pane-tests',
  '\x1b]0;vitest\x07\x1b[?25l RUN  v4.1.2 /Users/dev/project\r\n\r\n \x1b[32m✓\x1b[0m src/routes.test.ts (8 tests) 12ms\r\n \x1b[32m✓\x1b[0m src/db.test.ts (5 tests) 30ms\r\n \x1b[31m✗\x1b[0m src/ws.test.ts > reconnects after drop\r\n\r\n \x1b[1mTests\x1b[0m  \x1b[32m13 passed\x1b[0m | \x1b[31m1 failed\x1b[0m\r\n'
);
p2pBridge.sendTerminalOutput(
  'pane-logs',
  '\x1b[90m09:14:02\x1b[0m \x1b[32mINFO\x1b[0m server listening on :3000\r\n\x1b[90m09:14:09\x1b[0m \x1b[32mINFO\x1b[0m GET /health 200 2ms\r\n\x1b[90m09:15:31\x1b[0m \x1b[33mWARN\x1b[0m slow query 812ms\r\n'
);
p2pBridge.sendTerminalOutput('pane-web', '\x1b[1m▲ Next.js 15\x1b[0m\r\n- Local: http://localhost:3001\r\n\x1b[32m✓ Ready in 1.2s\x1b[0m\r\n');

const render = () => {
  const s = p2pBridge.getSession();
  document.getElementById('status')!.textContent = p2pBridge.getStatus();
  document.getElementById('code')!.textContent = s?.pairingCode ?? '—';
  document.getElementById('latency')!.textContent = p2pBridge.getLatency() !== null ? `${p2pBridge.getLatency()}ms` : '';
};
p2pBridge.onStatusChange(render);
p2pBridge.onSessionChange(render);

(window as any).desktop = {
  bridge: p2pBridge,
  start: (url: string) => p2pBridge.connect(url),
  stop: () => p2pBridge.disconnect(),
  /** Drop the live DataChannel to simulate a network blip. */
  dropPeer: () => (p2pBridge as any).dc?.close(),
  output: (paneId: string, text: string) => p2pBridge.sendTerminalOutput(paneId, text),
  finishAgent: (summary: string) => {
    const agents = new Map(useSwarmStore.getState().agents);
    for (const [runId, list] of agents) {
      agents.set(
        runId,
        list.map((a) => ({ ...a, status: 'completed' as const, output_summary: summary, completed_at: new Date().toISOString() }))
      );
    }
    useSwarmStore.setState({
      agents,
      runs: useSwarmStore.getState().runs.map((r) => ({ ...r, status: 'Completed' as const })),
    });
  },
  tasks: () => useTaskStore.getState().tasks,
  activeWorkspace: () => useWorkspaceStore.getState().activeWorkspaceId,
  invokes: () => (window as any).__invokeLog,
};
render();
