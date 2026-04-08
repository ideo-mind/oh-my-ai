import { mock, test, expect, describe, beforeAll, afterAll } from 'bun:test';
import * as http from 'node:http';

let requestsReceived = [];
let currentHandler = null;

// Mock node:https BEFORE any other imports that might use it
mock.module('node:https', () => {
  return {
    request: (options, callback) => {
      // console.log(`[MOCK] Calling http.request for ${options.hostname}:${options.port}${options.path}`);
      const req = http.request(options, (res) => {
        // console.log(`[MOCK] Got response ${res.statusCode} for ${options.path}`);
        callback(res);
      });
      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          // console.log(`[MOCK] ABORTED ${options.path}`);
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          req.emit('error', err);
          req.destroy(err);
        });
      }
      return req;
    }
  };
});

// Now we can import the clients
import { OpenAIClient } from '../src/openaiClient.ts';
import { KeyRotator } from '../src/keyRotator.ts';

describe('Burst Mode Validation', () => {
  const PORT = 34567;
  const baseUrl = `http://127.0.0.1:${PORT}`;
  let server;

  beforeAll((done) => {
    console.log('[BEFORE_ALL] Starting server...');
    server = http.createServer((req, res) => {
      const apiKey = req.headers.authorization?.replace('Bearer ', '');
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        console.log(`[SERVER] Received ${req.method} ${req.url} with key: ${apiKey}`);
        requestsReceived.push({ apiKey, req, res, id: requestsReceived.length, body });
        if (currentHandler) {
          currentHandler(req, res);
        } else {
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });
    server.listen(PORT, '127.0.0.1', () => {
      console.log(`[SERVER] Listening on ${PORT}`);
      done();
    });
  });

  afterAll((done) => {
    console.log('[AFTER_ALL] Closing server...');
    server.close(() => {
      console.log('[AFTER_ALL] Server closed');
      done();
    });
  });

  test('Parallel dispatch (burstSize=3)', async () => {
    requestsReceived = [];
    const apiKeys = ['key-1', 'key-2', 'key-3', 'key-4', 'key-5'];
    const rotator = new KeyRotator(apiKeys, 'openai');
    const client = new OpenAIClient(rotator, baseUrl, 3);

    currentHandler = (req, res) => {
      setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        }
      }, 100);
    };

    const promise = client.makeRequest('POST', '/chat', { prompt: 'hi' });
    
    // Wait for dispatch
    await new Promise(r => setTimeout(r, 50));
    expect(requestsReceived.length).toBe(3);
    
    const response = await promise;
    expect(response.statusCode).toBe(200);
    expect(response.meta.burstSize).toBe(3);
  });

  test('Cancellation on success', async () => {
    requestsReceived = [];
    let abortedCount = 0;

    const apiKeys = ['key-fast', 'key-slow-1', 'key-slow-2'];
    const rotator = new KeyRotator(apiKeys, 'openai');
    const client = new OpenAIClient(rotator, baseUrl, 3);

    currentHandler = (req, res) => {
      const apiKey = req.headers.authorization?.replace('Bearer ', '');
      req.on('close', () => {
        if (!res.writableEnded) {
          abortedCount++;
        }
      });

      if (apiKey === 'key-fast') {
        setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, key: 'fast' }));
          }
        }, 20);
      } else {
        setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, key: 'slow' }));
          }
        }, 500);
      }
    };

    const response = await client.makeRequest('POST', '/chat', { prompt: 'hi' });
    expect(response.statusCode).toBe(200);
    
    // Wait for abort signals to propagate
    await new Promise(r => setTimeout(r, 100));
    expect(abortedCount).toBeGreaterThanOrEqual(1);
  });

  test('Burst request does not hang forever when upstream never responds', async () => {
    requestsReceived = [];

    const apiKeys = ['hang-1', 'hang-2'];
    const rotator = new KeyRotator(apiKeys, 'openai');
    const client = new OpenAIClient(rotator, baseUrl, 2, 100);

    currentHandler = () => {
      // Intentionally do nothing so the client-side timeout is the only escape hatch.
    };

    const startedAt = Date.now();
    await expect(client.makeRequest('POST', '/chat', { prompt: 'hi' })).rejects.toThrow(/timed out/i);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(2000);
    expect(requestsReceived.length).toBe(2);
  });

  test('Rotation on 429', async () => {
    requestsReceived = [];
    
    // Mock Math.random to prevent shuffling and ensure predictable order
    const originalRandom = Math.random;
    Math.random = () => 0.99; // Preserves order in Fisher-Yates
    
    try {
      const apiKeys = ['bad-1', 'bad-2', 'good-3', 'good-4'];
      const rotator = new KeyRotator(apiKeys, 'openai');
      const client = new OpenAIClient(rotator, baseUrl, 2);

      currentHandler = (req, res) => {
        const apiKey = req.headers.authorization?.replace('Bearer ', '');
        if (apiKey && apiKey.startsWith('bad-')) {
          setTimeout(() => {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'rate limit' }));
          }, 20);
        } else {
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, apiKey }));
          }, 20);
        }
      };

      const response = await client.makeRequest('POST', '/chat', { prompt: 'hi' });
      // Should have tried bad-1, bad-2, then at least one good key
      expect(requestsReceived.length).toBeGreaterThanOrEqual(3);
      expect(response.statusCode).toBe(200);
      expect(response.meta.burstAttempts).toBeGreaterThanOrEqual(3);
    } finally {
      Math.random = originalRandom;
    }
  });
});
