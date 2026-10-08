import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { startVerificationServer } from '../scripts/verification-server.ts';

test('evaluation HTTP and HMR use one ephemeral loopback server and close lingering HTTP connections', async () => {
  const server = await startVerificationServer(express());
  try {
    assert.notEqual(server.port, 24678);
    const client = await fetch(`http://127.0.0.1:${server.port}/@vite/client`);
    const source = await client.text();
    assert.equal(client.status, 200);
    assert(
      source.includes(`127.0.0.1:${server.port}`),
      'Fallback websocket target must point to this evaluation server.',
    );
    assert(!source.includes('127.0.0.1:24678'));
  } finally {
    await server.close();
  }
});
