'use strict';

const http = require('node:http');
const os = require('node:os');

const PORT = Number(process.env.PORT ?? 8080);
const APP_ENV = process.env.APP_ENV ?? 'local';
// ECS stopTimeout is 30s; finish draining before SIGKILL arrives.
const SHUTDOWN_GRACE_MS = 25_000;

let shuttingDown = false;

/** One JSON object per line: CloudWatch Logs / Datadog parse it without any pipeline rules. */
function log(level, msg, extra = {}) {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), level, msg, service: 'sample-api', env: APP_ENV, ...extra }) + '\n',
  );
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...(shuttingDown ? { connection: 'close' } : {}),
  });
  res.end(payload);
}

function handler(req, res) {
  const start = process.hrtime.bigint();
  const path = (req.url ?? '/').split('?')[0];

  // Health checks fire every few seconds per target; logging them is pure noise (and ingestion cost).
  if (path !== '/healthz' && path !== '/readyz') {
    res.on('finish', () => {
      log('info', 'request', {
        method: req.method,
        path,
        status: res.statusCode,
        duration_ms: Number(process.hrtime.bigint() - start) / 1e6,
      });
    });
  }

  switch (path) {
    case '/healthz': // liveness: the process is up
      return send(res, 200, { status: 'ok' });
    case '/readyz': // readiness: flips to 503 as soon as SIGTERM arrives
      return shuttingDown ? send(res, 503, { status: 'draining' }) : send(res, 200, { status: 'ready' });
    case '/':
      return send(res, 200, {
        message: 'Hello from ECS Fargate',
        env: APP_ENV,
        host: os.hostname(),
        uptime_s: Math.round(process.uptime()),
      });
    default:
      return send(res, 404, { error: 'not found' });
  }
}

function createServer() {
  const server = http.createServer(handler);
  // Node closes idle keep-alive sockets after 5s by default, but the ALB reuses connections for up to its
  // 60s idle timeout. A race between the two produces sporadic 502s. Keep Node's timeout above the ALB's.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  return server;
}

function shutdown(server, signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutdown started', { signal });
  server.close((err) => {
    log(err ? 'error' : 'info', 'shutdown complete', err ? { error: err.message } : {});
    process.exit(err ? 1 : 0);
  });
  setTimeout(() => {
    log('warn', 'shutdown grace period exceeded, forcing exit');
    process.exit(1);
  }, SHUTDOWN_GRACE_MS).unref();
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, '0.0.0.0', () => log('info', 'listening', { port: PORT }));
  process.on('SIGTERM', () => shutdown(server, 'SIGTERM'));
  process.on('SIGINT', () => shutdown(server, 'SIGINT'));
}

module.exports = { createServer };
