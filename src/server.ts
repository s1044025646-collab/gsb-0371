/**
 * 纯后端 HTTP API。无前端页面。
 * 端口可通过 --port 或 PORT 环境变量配置；默认自动选择空闲端口。
 */
import { createServer, Server, IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { FractionError } from './fraction.js';
import { NewtonError } from './newton.js';
import { ObjectNotFoundError } from './storage.js';
import { InterpService } from './service.js';
import { Store } from './storage.js';

const DATA_DIR = process.env.NEWTON_DATA_DIR ?? join(process.cwd(), 'data');
const DB_PATH = join(DATA_DIR, 'newton.db');

interface JsonError {
  error: { code: string; message: string };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 2_000_000) {
        reject(new HttpError(413, 'E_PAYLOAD_TOO_LARGE', '请求体超过 2MB 上限'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (raw.length === 0) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'E_INVALID_JSON', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function classifyError(e: unknown): { status: number; code: string; message: string } {
  if (e instanceof HttpError) return { status: e.status, code: e.code, message: e.message };
  if (e instanceof FractionError || e instanceof NewtonError) {
    return { status: 422, code: e.code, message: e.message };
  }
  if (e instanceof ObjectNotFoundError) {
    return { status: 404, code: e.code, message: e.message };
  }
  if (e instanceof SyntaxError) {
    return { status: 400, code: 'E_INVALID_JSON', message: e.message };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { status: 500, code: 'E_INTERNAL', message: msg };
}

async function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

export async function startServer(requestedPort?: number): Promise<{ server: Server; port: number }> {
  const store = new Store(DB_PATH);
  const service = new InterpService(store);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const method = req.method ?? 'GET';

      if (method === 'GET' && path === '/health') {
        return send(res, 200, { ok: true, dataDir: DATA_DIR });
      }

      const seg = path.split('/').filter(Boolean);

      // GET /sets
      if (method === 'GET' && seg.length === 1 && seg[0] === 'sets') {
        return send(res, 200, { sets: service.listSets() });
      }
      // POST /sets
      if (method === 'POST' && seg.length === 1 && seg[0] === 'sets') {
        const body = await readBody(req);
        const name = typeof body.name === 'string' && body.name.trim() ? body.name : `set-${Date.now()}`;
        if (!Array.isArray(body.points)) {
          throw new HttpError(400, 'E_BAD_REQUEST', 'body.points 必须为数组（允许空数组）');
        }
        const { setId, report } = service.createSet(name, body.points);
        return send(res, 201, { setId, report });
      }
      // /sets/:id/...
      if (seg[0] === 'sets' && seg.length >= 2) {
        const setId = Number(seg[1]);
        if (!Number.isInteger(setId)) throw new HttpError(400, 'E_BAD_REQUEST', '点集 id 必须是整数');

        if (method === 'GET' && seg.length === 2) {
          return send(res, 200, { set: service.listSets().find((s) => s.id === setId), versions: service.listVersions(setId) });
        }
        if (method === 'POST' && seg.length === 3 && seg[2] === 'points') {
          const body = await readBody(req);
          if (typeof body.x !== 'string' && typeof body.x !== 'number' && typeof body.x !== 'bigint') {
            throw new HttpError(400, 'E_BAD_REQUEST', '需要字符串/整数 x');
          }
          if (typeof body.y !== 'string' && typeof body.y !== 'number') {
            throw new HttpError(400, 'E_BAD_REQUEST', '需要字符串/整数 y');
          }
          return send(res, 201, { report: service.appendPoint(setId, String(body.x), String(body.y)) });
        }
        if (method === 'GET' && seg.length === 3 && seg[2] === 'report') {
          return send(res, 200, { report: service.getReport(setId) });
        }
        if (method === 'POST' && seg.length === 3 && seg[2] === 'evaluate') {
          const body = await readBody(req);
          if (body.x === undefined) throw new HttpError(400, 'E_BAD_REQUEST', '需要 x');
          return send(res, 200, { result: service.evaluate(setId, String(body.x)) });
        }
        if (method === 'POST' && seg.length === 3 && seg[2] === 'sample') {
          const body = await readBody(req);
          if (!Array.isArray(body.xs) || body.xs.length === 0) {
            throw new HttpError(400, 'E_BAD_REQUEST', '需要非空 xs 数组');
          }
          if (body.xs.length > 1000) throw new HttpError(422, 'E_TOO_MANY_NODES', '单次采样位置不超过 1000 个');
          return send(res, 200, service.sample(setId, body.xs.map(String)));
        }
        if (method === 'GET' && seg.length === 3 && seg[2] === 'history') {
          const limit = Number(url.searchParams.get('limit') ?? '50');
          return send(res, 200, { history: service.history(setId, limit) });
        }
      }

      // POST /compare
      if (method === 'POST' && seg.length === 1 && seg[0] === 'compare') {
        const body = await readBody(req);
        if (!Array.isArray(body.orderA) || !Array.isArray(body.orderB) || body.x === undefined) {
          throw new HttpError(400, 'E_BAD_REQUEST', '需要 orderA、orderB 数组与 x');
        }
        return send(res, 200, service.compareOrder(body.orderA, body.orderB, String(body.x)));
      }
      // GET /history
      if (method === 'GET' && seg.length === 1 && seg[0] === 'history') {
        const limit = Number(url.searchParams.get('limit') ?? '50');
        return send(res, 200, { history: service.history(undefined, limit) });
      }

      send(res, 404, { error: { code: 'E_NOT_FOUND', message: `无此路由：${method} ${path}` } });
    } catch (e) {
      const c = classifyError(e);
      send(res, c.status, { error: { code: c.code, message: c.message } } as JsonError);
    }
  });

  const port = await listen(server, requestedPort ?? 0);
  return { server, port };
}

function parseArgs(argv: string[]): number | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) return Number(argv[i + 1]);
  }
  if (process.env.PORT) return Number(process.env.PORT);
  return undefined;
}

const invokedPath = (process.argv[1] ?? '').replace(/\\/g, '/');
if (invokedPath.endsWith('src/server.ts') || invokedPath.endsWith('src/server.js')) {
  const port = parseArgs(process.argv.slice(2));
  startServer(port)
    .then(({ port: actual }) => {
      console.log(`Newton 插值后端已启动: http://127.0.0.1:${actual}`);
      console.log(`数据目录: ${DATA_DIR}`);
    })
    .catch((e) => {
      console.error('启动失败:', e);
      process.exit(1);
    });
}
