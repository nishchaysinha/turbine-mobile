import { createServer } from 'node:http';

/** In-memory ntfy.sh stand-in: POST /<topic> publishes, GET /<topic>/json?poll=1&since= reads. */
export function startFakeNtfy() {
  const topics = new Map();
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.replace(/^\/+/, '');
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const list = topics.get(path) || [];
        list.push({ time: Math.floor(Date.now() / 1000), message: body });
        topics.set(path, list);
        res.end('{}');
      });
      return;
    }
    const topic = path.replace(/\/json$/, '');
    const since = Number(url.searchParams.get('since') || 0);
    const lines = (topics.get(topic) || [])
      .filter((m) => m.time >= since)
      .map((m) => JSON.stringify({ event: 'message', time: m.time, message: m.message }));
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.end(lines.join('\n'));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}
