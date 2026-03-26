import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Config } from '../src/config.ts';
import { ProxyServer } from '../src/server.ts';

const originalConfigFile = process.env.CONFIG_FILE;
const originalAdminPassword = process.env.ADMIN_PASSWORD;
const originalPort = process.env.PORT;

function cleanupFile(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

async function run(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  }
}

await run('Config writes admin updates to CONFIG_FILE target', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-my-ai-config-'));
  const tempConfigPath = path.join(tempDir, 'config.toml');

  process.env.CONFIG_FILE = tempConfigPath;
  process.env.ADMIN_PASSWORD = 'test-admin';
  delete process.env.PORT;

  const config = new Config();
  config.updateFromAdminPayload({
    providers: [{
      name: 'demo',
      apiType: 'openai',
      apiKeys: ['sk-demo'],
      apiKeysDetailed: [{ value: 'sk-demo', label: 'Primary', tier: '1' }],
      baseUrl: 'https://api.openai.com/v1',
      accessKey: 'local-access',
      defaultModel: 'gpt-4o-mini',
      modelHistory: ['gpt-4o-mini'],
      rotationStatusCodes: [429]
    }]
  });

  assert.equal(fs.existsSync(tempConfigPath), true);
  const content = fs.readFileSync(tempConfigPath, 'utf8');
  assert.match(content, /adminPassword = "test-admin"/);
  assert.match(content, /\[provider\.demo\]/);
  assert.match(content, /accessKey = "local-access"/);

  cleanupFile(tempConfigPath);
  fs.rmdirSync(tempDir);
});

await run('ProxyServer metrics payload includes timeline and provider health', async () => {
  const server = new ProxyServer({ getAdminPassword: () => 'test-admin' });
  const now = new Date();
  const logs = [
    {
      timestamp: new Date(now.getTime() - 120000).toISOString(),
      requestId: 'req-1',
      method: 'POST',
      endpoint: '/chat/completions',
      provider: 'openai',
      status: 200,
      responseTime: 120,
      apiKeyLabel: 'key-a'
    },
    {
      timestamp: new Date(now.getTime() - 60000).toISOString(),
      requestId: 'req-2',
      method: 'POST',
      endpoint: '/chat/completions',
      provider: 'openai',
      status: 429,
      responseTime: 240,
      apiKeyLabel: 'key-a'
    }
  ];

  const payload = server.buildHealthMetricsPayload(logs);

  assert.equal(payload.completedRequests, 2);
  assert.equal(payload.overall.totalRequests, 2);
  assert.equal(payload.overall['429Count'], 1);
  assert.ok(Array.isArray(payload.timeline));
  assert.ok(payload.timeline.length >= 1);
  assert.equal(payload.providers.openai.keys['key-a'].totalRequests, 2);
});

if (originalConfigFile === undefined) {
  delete process.env.CONFIG_FILE;
} else {
  process.env.CONFIG_FILE = originalConfigFile;
}

if (originalAdminPassword === undefined) {
  delete process.env.ADMIN_PASSWORD;
} else {
  process.env.ADMIN_PASSWORD = originalAdminPassword;
}

if (originalPort === undefined) {
  delete process.env.PORT;
} else {
  process.env.PORT = originalPort;
}

if (process.exitCode) {
  process.exit(process.exitCode);
}
