import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Config } from '../src/config.ts';
import { ProxyServer } from '../src/server.ts';
import { KeyRotator } from '../src/keyRotator.ts';

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

await run('Config persists burstSize to CONFIG_FILE', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-my-ai-burst-'));
  const tempConfigPath = path.join(tempDir, 'config.toml');

  process.env.CONFIG_FILE = tempConfigPath;
  process.env.ADMIN_PASSWORD = 'test-admin';
  delete process.env.PORT;

  const config = new Config();
  config.updateFromAdminPayload({
    providers: [{
      name: 'burst-test',
      apiType: 'openai',
      apiKeys: ['sk-burst'],
      burstSize: 3
    }]
  });

  assert.equal(fs.existsSync(tempConfigPath), true);
  const content = fs.readFileSync(tempConfigPath, 'utf8');
  assert.match(content, /burstSize = 3/);

  const reloadedConfig = new Config(tempConfigPath);
  const provider = reloadedConfig.getProvider('burst-test');
  assert.equal(provider?.burstSize, 3);

  cleanupFile(tempConfigPath);
  fs.rmdirSync(tempDir);
});

await run('Config exports TOML with redacted admin password', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-my-ai-toml-'));
  const tempConfigPath = path.join(tempDir, 'config.toml');
  fs.writeFileSync(tempConfigPath, [
    '[server]',
    'port = 8990',
    'adminPassword = "super-secret"',
    '',
    '[provider.demo]',
    'apiType = "openai"',
    'apiKeys = ["sk-demo"]',
  ].join('\n'));

  process.env.CONFIG_FILE = tempConfigPath;
  delete process.env.ADMIN_PASSWORD;
  delete process.env.PORT;

  const config = new Config();
  const toml = config.toTomlFileString();

  assert.match(toml, /adminPassword = ""/);
  assert.match(toml, /\[provider\.demo\]/);
  assert.doesNotMatch(toml, /super-secret/);

  cleanupFile(tempConfigPath);
  fs.rmdirSync(tempDir);
});

await run('Config imports TOML and preserves password when redacted', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-my-ai-import-'));
  const tempConfigPath = path.join(tempDir, 'config.toml');
  fs.writeFileSync(tempConfigPath, [
    '[server]',
    'port = 8990',
    'adminPassword = "existing-password"',
    '',
    '[provider.old]',
    'apiType = "openai"',
    'apiKeys = ["sk-old"]',
  ].join('\n'));

  process.env.CONFIG_FILE = tempConfigPath;
  delete process.env.ADMIN_PASSWORD;
  delete process.env.PORT;

  const config = new Config();
  config.updateFromTomlString([
    '[server]',
    'port = 9123',
    'adminPassword = ""',
    '',
    '[provider.replacement]',
    'apiType = "gemini"',
    'apiKeys = ["gm-new"]',
    'defaultModel = "gemini-2.5-flash"',
  ].join('\n'));

  assert.equal(config.adminPassword, 'existing-password');
  assert.equal(config.port, 9123);
  assert.equal(config.providers.has('old'), false);
  assert.equal(config.providers.has('replacement'), true);

  const content = fs.readFileSync(tempConfigPath, 'utf8');
  assert.match(content, /adminPassword = "existing-password"/);
  assert.match(content, /\[provider\.replacement\]/);
  assert.doesNotMatch(content, /\[provider\.old\]/);

  cleanupFile(tempConfigPath);
  fs.rmdirSync(tempDir);
});

await run('Config auto-creates default config file when missing', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-my-ai-default-'));
  const tempConfigPath = path.join(tempDir, 'nested', 'config.toml');

  process.env.CONFIG_FILE = tempConfigPath;
  delete process.env.ADMIN_PASSWORD;
  delete process.env.PORT;

  const config = new Config();

  assert.equal(fs.existsSync(tempConfigPath), true);
  assert.equal(config.adminPassword, 'admin');
  assert.equal(config.port, 8990);

  const content = fs.readFileSync(tempConfigPath, 'utf8');
  assert.match(content, /\[server\]/);
  assert.match(content, /adminPassword = "admin"/);
  assert.match(content, /port = (8990|8_990)/);

  cleanupFile(tempConfigPath);
  fs.rmdirSync(path.dirname(tempConfigPath));
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

await run('KeyRotator getNextBatch and smart shuffle', async () => {
  const keys = ['key1', 'key2', 'key3', 'key4', 'key5'];
  const rotator = new KeyRotator(keys, 'test');

  const context1 = rotator.createRequestContext();
  const batch1 = context1.getNextBatch(2);
  assert.equal(batch1.length, 2);
  assert.ok(keys.includes(batch1[0]));
  assert.ok(keys.includes(batch1[1]));
  assert.notEqual(batch1[0], batch1[1]);

  const batch2 = context1.getNextBatch(2);
  assert.equal(batch2.length, 2);
  for (const k of batch2) {
    assert.ok(keys.includes(k));
    assert.ok(!batch1.includes(k));
  }

  const batch3 = context1.getNextBatch(2);
  assert.equal(batch3.length, 1);
  assert.ok(keys.includes(batch3[0]));
  assert.ok(!batch1.includes(batch3[0]));
  assert.ok(!batch2.includes(batch3[0]));

  const batch4 = context1.getNextBatch(2);
  assert.equal(batch4.length, 0);

  const context2 = rotator.createRequestContext();
  const batchAll = context2.getNextBatch(10);
  assert.equal(batchAll.length, 5);

  const lastFailedKey = 'key3';
  rotator.updateLastFailedKey(lastFailedKey);
  
  for (let i = 0; i < 10; i++) {
    const context3 = rotator.createRequestContext();
    const allKeys = context3.getNextBatch(5);
    assert.equal(allKeys.length, 5);
    assert.equal(allKeys[4], lastFailedKey, `Failed key ${lastFailedKey} should be at the end of batch`);
    
    const sortedOriginal = [...keys].sort();
    const sortedCurrent = [...allKeys].sort();
    assert.deepEqual(sortedCurrent, sortedOriginal, 'Batch should contain all original keys');
  }

  rotator.updateLastFailedKey('non-existent-key');
  const context4 = rotator.createRequestContext();
  const allKeys4 = context4.getNextBatch(5);
  assert.equal(allKeys4.length, 5);
  const sortedOriginal4 = [...keys].sort();
  const sortedCurrent4 = [...allKeys4].sort();
  assert.deepEqual(sortedCurrent4, sortedOriginal4);
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
