import * as fs from 'node:fs';
import * as path from 'node:path';
import * as TOML from '@iarna/toml';

export type ApiKeyConfig = {
  value: string;
  label?: string | null;
  tier?: string | null;
};

export type ProviderConfig = {
  apiType: string;
  apiKeys: string[];
  apiKeysDetailed?: ApiKeyConfig[];
  baseUrl?: string;
  accessKey?: string | null;
  defaultModel?: string | null;
  modelHistory?: string[];
  rotationStatusCodes?: number[];
};

export type AdminProviderPayload = ProviderConfig & {
  name: string;
};

export type AdminConfigPayload = {
  providers: AdminProviderPayload[];
};

type ProviderInput = Partial<ProviderConfig> & { apiKeys?: string[]; apiKeysDetailed?: ApiKeyConfig[] };

type ConfigFile = {
  server?: {
    port?: number;
    adminPassword?: string;
    logFilePath?: string;
  };
  provider?: Record<string, ProviderInput>;
};

export class Config {
  private configPath: string;
  private rawConfig: ConfigFile;
  port: number;
  adminPassword: string;
  logFilePath: string | null;
  providers: Map<string, ProviderConfig>;

  constructor(configPath = process.env.CONFIG_FILE || path.join(process.cwd(), 'config.toml')) {
    this.configPath = configPath;
    this.rawConfig = {};
    this.port = 8990;
    this.adminPassword = '';
    this.logFilePath = null;
    this.providers = new Map();
    this.loadConfig();
  }

  loadConfig() {
    this.rawConfig = this.readConfigFile();

    const envPort = process.env.PORT;
    const configPort = this.rawConfig.server?.port;
    const resolvedPortString = envPort ?? (configPort !== undefined ? String(configPort) : null) ?? '8990';
    const resolvedPort = parseInt(resolvedPortString, 10);

    if (Number.isNaN(resolvedPort)) {
      throw new Error('Invalid port: PORT must be a number');
    }

    this.port = resolvedPort;

    const adminPassword = this.rawConfig.server?.adminPassword ?? process.env.ADMIN_PASSWORD;
    if (!adminPassword || adminPassword.trim().length === 0) {
      throw new Error('ADMIN_PASSWORD missing in config.toml (or environment)');
    }

    this.adminPassword = adminPassword;
    this.logFilePath = this.rawConfig.server?.logFilePath ?? null;

    this.providers = this.parseProvidersFromConfig(this.rawConfig.provider ?? {});

    console.log(`[CONFIG] Port: ${this.port}${envPort ? ' (from PORT environment variable override)' : configPort ? ' (from config.toml)' : ' (default)'}`);
    console.log('[CONFIG] Admin panel enabled with password authentication');
    console.log(`[CONFIG] Found ${this.providers.size} providers configured`);
  }

  private readConfigFile(): ConfigFile {
    if (!fs.existsSync(this.configPath)) {
      return this.createDefaultConfigFile();
    }

    const content = fs.readFileSync(this.configPath, 'utf8');
    const parsed = TOML.parse(content) as ConfigFile;
    return parsed;
  }

  private createDefaultConfigFile(): ConfigFile {
    const envAdminPassword = process.env.ADMIN_PASSWORD?.trim();
    const defaultConfig: ConfigFile = {
      server: {
        port: 8990,
        adminPassword: envAdminPassword && envAdminPassword.length > 0 ? envAdminPassword : 'admin',
      },
      provider: {},
    };
    const dirPath = path.dirname(this.configPath);
    fs.mkdirSync(dirPath, { recursive: true });
    const text = TOML.stringify(defaultConfig as TOML.JsonMap);
    fs.writeFileSync(this.configPath, text, { encoding: 'utf8', mode: 0o600 });
    console.log(`[CONFIG] Created default config at ${this.configPath}`);
    return defaultConfig;
  }

  private parseProvidersFromConfig(providers: Record<string, ProviderInput>): Map<string, ProviderConfig> {
    const map = new Map<string, ProviderConfig>();

    for (const [providerName, cfg] of Object.entries(providers)) {
      const apiType = cfg.apiType?.toLowerCase();
      const apiKeysDetailed = Array.isArray(cfg.apiKeysDetailed)
        ? cfg.apiKeysDetailed
            .filter(key => typeof key?.value === 'string' && key.value.trim().length > 0)
            .map(key => ({
              value: key.value.trim(),
              label: key.label?.trim() || null,
              tier: key.tier?.trim() || null,
            }))
        : (cfg.apiKeys ?? [])
            .filter(key => typeof key === 'string' && key.trim().length > 0)
            .map(key => ({ value: key.trim(), label: null, tier: null }));
      const apiKeys = apiKeysDetailed.map(key => key.value);

      if (!apiType || apiKeys.length === 0) {
        continue;
      }

      const baseUrl = cfg.baseUrl?.trim() || this.defaultBaseUrl(apiType);
      const accessKey = cfg.accessKey ?? null;
      const defaultModel = cfg.defaultModel ?? null;
      const modelHistory = Array.isArray(cfg.modelHistory) ? cfg.modelHistory.filter(Boolean) : [];
      const rotationStatusCodes = Array.isArray(cfg.rotationStatusCodes)
        ? cfg.rotationStatusCodes.map(code => Number(code)).filter(code => !Number.isNaN(code))
        : [];

      map.set(providerName, {
        apiType,
        apiKeys,
        apiKeysDetailed,
        baseUrl,
        accessKey,
        defaultModel,
        modelHistory,
        rotationStatusCodes,
      });
    }

    return map;
  }

  private defaultBaseUrl(apiType: string): string | undefined {
    if (apiType === 'openai') {
      return 'https://api.openai.com/v1';
    }
    if (apiType === 'gemini') {
      return 'https://generativelanguage.googleapis.com/v1beta';
    }
    return undefined;
  }

  private maskApiKey(key: string): string {
    if (!key || key.length < 8) return '***';
    return `${key.substring(0, 4)}...${key.substring(key.length - 4)}`;
  }

  getPort() {
    return this.port;
  }

  getAdminPassword() {
    return this.adminPassword;
  }

  hasAdminPassword() {
    return this.adminPassword.trim().length > 0;
  }

  getProviders() {
    return this.providers;
  }

  getProvider(providerName: string) {
    return this.providers.get(providerName);
  }

  hasProvider(providerName: string) {
    return this.providers.has(providerName);
  }

  getProvidersByApiType(apiType: string) {
    const result = new Map<string, ProviderConfig>();
    for (const [name, config] of this.providers.entries()) {
      if (config.apiType === apiType) {
        result.set(name, config);
      }
    }
    return result;
  }

  getLogFilePath() {
    return this.logFilePath;
  }

  private normalizeBaseUrl(baseUrl: string | undefined, defaultUrl: string) {
    if (!baseUrl || baseUrl.trim().length === 0) {
      return defaultUrl;
    }

    const resolvedBaseUrl = baseUrl.replace(/\/+$/, '');

    if (/\/v[^/]+$/.test(resolvedBaseUrl)) {
      return resolvedBaseUrl;
    }

    return `${resolvedBaseUrl}/v1`;
  }

  getGeminiApiKeys() {
    return this.getAllGeminiKeys();
  }

  getOpenaiApiKeys() {
    return this.getAllOpenaiKeys();
  }

  hasGeminiKeys() {
    return this.getAllGeminiKeys().length > 0;
  }

  hasOpenaiKeys() {
    return this.getAllOpenaiKeys().length > 0;
  }

  getGeminiBaseUrl() {
    const firstGemini = Array.from(this.providers.values()).find(p => p.apiType === 'gemini');
    return this.normalizeBaseUrl(firstGemini?.baseUrl, 'https://generativelanguage.googleapis.com/v1beta');
  }

  getOpenaiBaseUrl() {
    const firstOpenai = Array.from(this.providers.values()).find(p => p.apiType === 'openai');
    return this.normalizeBaseUrl(firstOpenai?.baseUrl, 'https://api.openai.com/v1');
  }

  getAllGeminiKeys() {
    const keys: string[] = [];
    for (const provider of this.providers.values()) {
      if (provider.apiType === 'gemini') {
        keys.push(...provider.apiKeys);
      }
    }
    return keys;
  }

  getAllOpenaiKeys() {
    const keys: string[] = [];
    for (const provider of this.providers.values()) {
      if (provider.apiType === 'openai') {
        keys.push(...provider.apiKeys);
      }
    }
    return keys;
  }

  toEnvStyleObject(): Record<string, string> {
    const envVars: Record<string, string> = {};

    envVars.ADMIN_PASSWORD = this.adminPassword;
    envVars.PORT = String(this.port);

    for (const [providerName, cfg] of this.providers.entries()) {
      const prefix = `${cfg.apiType.toUpperCase()}_${providerName.toUpperCase()}`;
      envVars[`${prefix}_API_KEYS`] = cfg.apiKeys.join(',');
      if (cfg.baseUrl) {
        envVars[`${prefix}_BASE_URL`] = cfg.baseUrl;
      }
      if (cfg.accessKey) {
        envVars[`${prefix}_ACCESS_KEY`] = cfg.accessKey;
      }
      if (cfg.defaultModel) {
        envVars[`${prefix}_DEFAULT_MODEL`] = cfg.defaultModel;
      }
      if (cfg.modelHistory && cfg.modelHistory.length > 0) {
        envVars[`${prefix}_MODEL_HISTORY`] = cfg.modelHistory.join(',');
      }
      if (cfg.rotationStatusCodes && cfg.rotationStatusCodes.length > 0) {
        envVars[`${prefix}_ROTATION_STATUS_CODES`] = cfg.rotationStatusCodes.join(',');
      }
    }

    return envVars;
  }

  toEnvFileString() {
    const envVars = this.toEnvStyleObject();
    const lines = Object.entries(envVars)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    return `${lines}\n`;
  }

  toTomlFileString() {
    const sanitized: ConfigFile = {
      server: {
        ...(this.rawConfig.server ?? {}),
        adminPassword: '',
      },
      provider: { ...(this.rawConfig.provider ?? {}) },
    };

    return TOML.stringify(sanitized as TOML.JsonMap);
  }

  toAdminPayload(): AdminConfigPayload {
    return {
      providers: Array.from(this.providers.entries()).map(([name, config]) => ({
        name,
        apiType: config.apiType,
        apiKeys: [...config.apiKeys],
        apiKeysDetailed: [...(config.apiKeysDetailed ?? [])],
        baseUrl: config.baseUrl,
        accessKey: config.accessKey ?? null,
        defaultModel: config.defaultModel ?? null,
        modelHistory: [...(config.modelHistory ?? [])],
        rotationStatusCodes: [...(config.rotationStatusCodes ?? [])],
      })),
    };
  }

  updateFromEnvStyle(envVars: Record<string, string>) {
    const providers: Record<string, ProviderInput> = {};

    Object.entries(envVars).forEach(([key, value]) => {
      if (!key || typeof value !== 'string') {
        return;
      }

      if (key === 'ADMIN_PASSWORD') {
        return;
      }

      if (key === 'PORT') {
        return;
      }

      const apiMatch = key.match(/^([A-Z0-9]+)_([A-Z0-9_]+)_(API_KEYS|BASE_URL|ACCESS_KEY|DEFAULT_MODEL|MODEL_HISTORY|ROTATION_STATUS_CODES)$/);
      if (!apiMatch) {
        return;
      }

      const [, apiTypeRaw, providerRaw, keyType] = apiMatch;
      const apiType = apiTypeRaw.toLowerCase();
      const providerName = providerRaw.toLowerCase();

      if (!providers[providerName]) {
      providers[providerName] = { apiType, apiKeys: [] };
      }

      const target = providers[providerName];

      if (keyType === 'API_KEYS') {
        target.apiKeys = value.split(',').map(item => item.trim()).filter(Boolean);
      } else if (keyType === 'BASE_URL') {
        target.baseUrl = value.trim();
      } else if (keyType === 'ACCESS_KEY') {
        target.accessKey = value.trim();
      } else if (keyType === 'DEFAULT_MODEL') {
        target.defaultModel = value.trim();
      } else if (keyType === 'MODEL_HISTORY') {
        target.modelHistory = value.split(',').map(item => item.trim()).filter(Boolean);
      } else if (keyType === 'ROTATION_STATUS_CODES') {
        target.rotationStatusCodes = value
          .split(',')
          .map(item => Number(item.trim()))
          .filter(code => !Number.isNaN(code));
      }
    });

    const configUpdate: ConfigFile = {
      server: {
        adminPassword: envVars.ADMIN_PASSWORD ?? this.adminPassword,
        port: this.rawConfig.server?.port,
        logFilePath: this.rawConfig.server?.logFilePath,
      },
      provider: providers,
    };

    this.writeConfigFile(configUpdate, true);
    this.loadConfig();
  }

  updateFromAdminPayload(payload: AdminConfigPayload) {
    const providers: Record<string, ProviderInput> = {};

    for (const provider of payload.providers ?? []) {
      if (!provider.name || !provider.apiType) {
        continue;
      }

      providers[provider.name.toLowerCase()] = {
        apiType: provider.apiType.toLowerCase(),
        apiKeys: [...(provider.apiKeysDetailed?.map(key => key.value) ?? provider.apiKeys ?? [])],
        apiKeysDetailed: [...(provider.apiKeysDetailed ?? (provider.apiKeys ?? []).map(key => ({ value: key, label: null, tier: null })))],
        baseUrl: provider.baseUrl,
        accessKey: provider.accessKey ?? null,
        defaultModel: provider.defaultModel ?? null,
        modelHistory: [...(provider.modelHistory ?? [])],
        rotationStatusCodes: [...(provider.rotationStatusCodes ?? [])],
      };
    }

    const configUpdate: ConfigFile = {
      server: {
        adminPassword: this.adminPassword,
        port: this.rawConfig.server?.port,
        logFilePath: this.rawConfig.server?.logFilePath,
      },
      provider: providers,
    };

    this.writeConfigFile(configUpdate, true);
    this.loadConfig();
  }

  updateFromTomlString(tomlContent: string) {
    const parsed = TOML.parse(tomlContent) as ConfigFile;
    const nextConfig: ConfigFile = {
      server: {
        ...(parsed.server ?? {}),
      },
      provider: { ...(parsed.provider ?? {}) },
    };

    const importedPassword = nextConfig.server?.adminPassword;
    if (!importedPassword || importedPassword.trim().length === 0) {
      nextConfig.server = {
        ...(nextConfig.server ?? {}),
        adminPassword: this.adminPassword,
      };
    }

    this.writeConfigFile(nextConfig, true);
    this.loadConfig();
  }

  private writeConfigFile(config: ConfigFile, replace = false) {
    const merged: ConfigFile = replace
      ? {
          server: { ...(config.server ?? {}) },
          provider: { ...(config.provider ?? {}) },
        }
      : {
          server: { ...(this.rawConfig.server ?? {}), ...(config.server ?? {}) },
          provider: { ...(this.rawConfig.provider ?? {}), ...(config.provider ?? {}) },
        };

    const text = TOML.stringify(merged as TOML.JsonMap);
    fs.writeFileSync(this.configPath, text, 'utf8');
    this.rawConfig = merged;
  }
}

export default Config;
