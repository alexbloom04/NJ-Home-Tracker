// Tiny static server for previewing the dashboard locally: node scripts/serve.mjs [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = process.env.SITE_DIR ? resolve(process.env.SITE_DIR) : resolve(dirname(fileURLToPath(import.meta.url)), '..', 'site');
const PORT = +process.env.PORT || +process.argv[2] || 5173;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

createServer(async (req, res) => {
  let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^[/\\]+/, '');
  if (!path || /[/\\]$/.test(path)) path = join(path, 'index.html');
  const file = join(SITE, path);
  if (!file.startsWith(SITE)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, () => console.log(`Dashboard at http://localhost:${PORT}`));
