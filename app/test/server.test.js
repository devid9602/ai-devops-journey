'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('health, readiness and root endpoints', async () => {
  const server = createServer();
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/readyz`)).status, 200);

    const root = await fetch(`${base}/`);
    assert.equal(root.status, 200);
    assert.equal((await root.json()).message, 'Hello from ECS Fargate');

    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('keep-alive timeout exceeds the ALB idle timeout (60s)', () => {
  const server = createServer();
  assert.ok(server.keepAliveTimeout > 60_000);
  assert.ok(server.headersTimeout > server.keepAliveTimeout);
  server.close();
});
