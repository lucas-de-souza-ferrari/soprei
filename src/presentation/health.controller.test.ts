import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTestServer } from '../infrastructure/http/test-server.js';

describe('GET /health', () => {
  it('responde 200 com { status: "ok" }', async () => {
    const app = buildTestServer();
    try {
      const response = await app.inject({ method: 'GET', url: '/health' });
      assert.equal(response.statusCode, 200);
      assert.match(String(response.headers['content-type']), /application\/json/);
      assert.deepEqual(response.json(), { status: 'ok' });
    } finally {
      await app.close();
    }
  });
});
