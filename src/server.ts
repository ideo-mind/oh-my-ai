import * as http from 'node:http';
import { URL } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { KeyRotator } from './keyRotator';
import { GeminiClient } from './geminiClient';
import { OpenAIClient } from './openaiClient';

export class ProxyServer {
  constructor(config, geminiClient = null, openaiClient = null) {
    this.config = config;
    this.geminiClient = geminiClient;
    this.openaiClient = openaiClient;
    this.providerClients = new Map(); // Map of provider_name -> client instance
    this.server = null;
    this.adminSessionToken = null;
    this.logBuffer = [];
    this.logHistory = this.logBuffer;
    this.sseLogClients = new Map();
    this.logFilePath = this.resolveLogFilePath();
    this.ensureLogFileDirectory();
    this.responseStorage = new Map(); // Store response data for viewing

    // Rate limiting for login
    this.failedLoginAttempts = 0;
    this.loginBlockedUntil = null;


  }

  start() {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    this.server.listen(this.config.getPort(), () => {
      console.log(`Multi-API proxy server running on port ${this.config.getPort()}`);

      const providers = this.config.getProviders();
      for (const [providerName, config] of providers.entries()) {
        console.log(`Provider '${providerName}' (${config.apiType}): /${providerName}/* → ${config.baseUrl}`);
      }

      // Backward compatibility logging
      if (this.config.hasGeminiKeys()) {
        console.log(`Legacy Gemini endpoints: /gemini/*`);
      }
      if (this.config.hasOpenaiKeys()) {
        console.log(`Legacy OpenAI endpoints: /openai/*`);
      }

      if (this.config.hasAdminPassword()) {
        console.log(`Admin panel available at: http://localhost:${this.config.getPort()}/admin`);
      }

      console.log(`Request logs persisted to: ${this.logFilePath}`);
    });

    this.server.on('error', (error) => {
      console.error('Server error:', error);
    });
  }

  async handleRequest(req, res) {
    const requestId = Math.random().toString(36).substring(2, 11);
    const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const startTime = Date.now();

    // Set CORS headers for all responses - accept all origins
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
    res.setHeader('Access-Control-Max-Age', '86400'); // Cache preflight for 24 hours

    // Handle preflight OPTIONS requests
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Only log to file for API calls, always log to console
    const isApiCall = this.parseRoute(req.url) !== null;
    console.log(`[REQ-${requestId}] ${req.method} ${req.url} from ${clientIp}`);

    try {
      const body = await this.readRequestBody(req);

      // Serve static files from public directory
      if (req.url === '/tailwind-3.4.17.js' && (req.method === 'GET' || req.method === 'HEAD')) {
        try {
          const filePath = path.join(process.cwd(), 'public', 'tailwind-3.4.17.js');
          console.log(`[STATIC] Serving file from: ${filePath}`);

          if (req.method === 'HEAD') {
            // For HEAD requests, just send headers without body
            const stats = fs.statSync(filePath);
            res.writeHead(200, {
              'Content-Type': 'application/javascript',
              'Content-Length': stats.size,
              'Cache-Control': 'public, max-age=31536000' // Cache for 1 year
            });
            res.end();
          } else {
            // For GET requests, send the file content
            const fileContent = fs.readFileSync(filePath, 'utf8');
            res.writeHead(200, {
              'Content-Type': 'application/javascript',
              'Content-Length': Buffer.byteLength(fileContent),
              'Cache-Control': 'public, max-age=31536000' // Cache for 1 year
            });
            res.end(fileContent);
          }
          console.log(`[STATIC] Successfully served: ${req.url}`);
          return;
        } catch (error) {
          console.log(`[STATIC] Error serving file: ${error.message}`);
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('File not found');
          return;
        }
      }

      // Handle root route - redirect to admin
      if (req.url === '/' || req.url === '') {
        res.writeHead(302, { 'Location': '/admin' });
        res.end();
        return;
      }

      // Handle admin routes
      if (req.url.startsWith('/admin')) {
        await this.handleAdminRequest(req, res, body);
        return;
      }

      // Handle common browser requests that aren't API calls
      if (req.url === '/favicon.ico' || req.url === '/robots.txt') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      const routeInfo = this.parseRoute(req.url);

      if (!routeInfo) {
        console.log(`[REQ-${requestId}] Invalid path: ${req.url}`);
        console.log(`[REQ-${requestId}] Response: 400 Bad Request - Invalid API path`);

        if (isApiCall) {
          const responseTime = Date.now() - startTime;
          this.logApiRequest(requestId, req.method, req.url, 'unknown', 400, responseTime, 'Invalid API path', clientIp);
        }

        this.sendError(res, 400, 'Invalid API path. Use /{provider}/* format');
        return;
      }

      const { providerName, apiType, path, provider, legacy } = routeInfo;
      console.log(`[REQ-${requestId}] Proxying to provider '${providerName}' (${apiType.toUpperCase()}): ${path}`);

      // Get the appropriate header based on API type
      const authHeader = apiType === 'gemini'
        ? req.headers['x-goog-api-key']
        : req.headers['authorization'];

      // Parse custom status codes and access key from header
      const customStatusCodes = this.parseStatusCodesFromAuth(authHeader);

      // Validate ACCESS_KEY for this provider
      if (!this.validateAccessKey(providerName, authHeader)) {
        console.log(`[REQ-${requestId}] Response: 401 Unauthorized - Invalid or missing ACCESS_KEY for provider '${providerName}'`);

        if (isApiCall) {
          const responseTime = Date.now() - startTime;
          this.logApiRequest(requestId, req.method, path, providerName, 401, responseTime, 'Invalid or missing ACCESS_KEY', clientIp);
        }

        this.sendError(res, 401, `Invalid or missing ACCESS_KEY for provider '${providerName}'`);
        return;
      }

      // Log the initial request
      if (isApiCall) {
        this.logApiRequest(requestId, req.method, path, providerName, null, null, null, clientIp);
      }

      // Clean the auth header before passing to API
      const headers = this.extractRelevantHeaders(req.headers, apiType);
      if (authHeader) {
        const cleanedAuth = this.cleanAuthHeader(authHeader);
        if (cleanedAuth) {
          if (apiType === 'gemini') {
            headers['x-goog-api-key'] = cleanedAuth;
          } else {
            headers['authorization'] = cleanedAuth;
          }
        }
        // Important: don't set undefined/null as it would override the client's API key
      }

      let response: any;

      // Get or create client for this provider
      const client = await this.getProviderClient(providerName, provider, legacy);
      if (!client) {
        console.log(`[REQ-${requestId}] Response: 503 Service Unavailable - Provider '${providerName}' not configured`);

        if (isApiCall) {
          const responseTime = Date.now() - startTime;
          this.logApiRequest(requestId, req.method, path, providerName, 503, responseTime, `Provider '${providerName}' not configured`, clientIp);
        }

        this.sendError(res, 503, `Provider '${providerName}' not configured`);
        return;
      }

      // Pass custom status codes to client if provided
      if (customStatusCodes) {
        console.log(`[REQ-${requestId}] Using custom status codes for rotation: ${Array.from(customStatusCodes).join(', ')}`);
      }

      response = await client.makeRequest(req.method, path, body, headers, customStatusCodes);

      // Log the successful response
      if (isApiCall) {
        const responseTime = Date.now() - startTime;
        const error = response.statusCode >= 400 ? `HTTP ${response.statusCode}` : null;
        this.logApiRequest(
          requestId,
          req.method,
          path,
          providerName,
          response.statusCode,
          responseTime,
          error,
          clientIp,
          response.meta || { requestType: 'proxy' }
        );
      }

      this.logApiResponse(requestId, response, body);
      this.sendResponse(res, response);
    } catch (error) {
      console.log(`[REQ-${requestId}] Request handling error: ${error.message}`);
      console.log(`[REQ-${requestId}] Response: 500 Internal Server Error`);

      if (isApiCall) {
        const responseTime = Date.now() - startTime;
        this.logApiRequest(requestId, req.method, req.url, 'unknown', 500, responseTime, error.message, clientIp, {
          requestType: 'proxy'
        });
      }

      this.sendError(res, 500, 'Internal server error');
    }
  }

  readRequestBody(req) {
    return new Promise((resolve) => {
      let body = '';

      req.on('data', (chunk) => {
        body += chunk;
      });

      req.on('end', () => {
        resolve(body || null);
      });
    });
  }

  parseRoute(url) {
    if (!url) return null;

    const urlObj = new URL(url, 'http://localhost');
    const path = urlObj.pathname;

    // Parse new provider format: /{provider}/* (no version required)
    const pathParts = path.split('/').filter(part => part.length > 0);
    if (pathParts.length >= 1) {
      const providerName = pathParts[0].toLowerCase();
      const provider = this.config.getProvider(providerName);

      if (provider) {
        // Extract the API path after /{provider}
        const apiPath = '/' + pathParts.slice(1).join('/') + urlObj.search;

        return {
          providerName: providerName,
          apiType: provider.apiType,
          path: apiPath, // Use path as-is, no adjustment needed
          provider: provider
        };
      }
    }

    // Backward compatibility - Legacy Gemini routes: /gemini/*
    if (path.startsWith('/gemini/')) {
      const geminiPath = path.substring(7); // Remove '/gemini'

      return {
        providerName: 'gemini',
        apiType: 'gemini',
        path: geminiPath + urlObj.search,
        legacy: true
      };
    }

    // Backward compatibility - Legacy OpenAI routes: /openai/*
    if (path.startsWith('/openai/')) {
      const openaiPath = path.substring(7); // Remove '/openai'

      return {
        providerName: 'openai',
        apiType: 'openai',
        path: openaiPath + urlObj.search,
        legacy: true
      };
    }

    return null;
  }


  async getProviderClient(providerName, provider, legacy = false) {
    // Handle legacy clients
    if (legacy) {
      if (providerName === 'gemini' && this.geminiClient) {
        return this.geminiClient;
      }
      if (providerName === 'openai' && this.openaiClient) {
        return this.openaiClient;
      }
      return null;
    }

    // Check if we already have a client for this provider
    if (this.providerClients.has(providerName)) {
      return this.providerClients.get(providerName);
    }

    // Create new client for this provider
    if (!provider) {
      return null;
    }

    try {
      const keyRotator = new KeyRotator(provider.apiKeys, provider.apiType);
      let client: any;

      if (provider.apiType === 'openai') {
        client = new OpenAIClient(keyRotator, provider.baseUrl);
      } else if (provider.apiType === 'gemini') {
        client = new GeminiClient(keyRotator, provider.baseUrl);
      } else {
        return null;
      }

      this.providerClients.set(providerName, client);
      console.log(`[SERVER] Created client for provider '${providerName}' (${provider.apiType})`);
      return client;
    } catch (error) {
      console.error(`[SERVER] Failed to create client for provider '${providerName}': ${error.message}`);
      return null;
    }
  }

  parseStatusCodesFromAuth(authHeader) {
    // Extract [STATUS_CODES:...] from the Authorization header
    const match = authHeader?.match(/\[STATUS_CODES:([^\]]+)\]/i);
    if (!match) return null;

    const statusCodeStr = match[1];
    const codes = new Set();

    // Parse each part (e.g., "429", "400-420", "500+", "400=+")
    const parts = statusCodeStr.split(',').map(s => s.trim());

    for (const part of parts) {
      if (part.includes('-')) {
        // Range: 400-420
        const [start, end] = part.split('-').map(n => parseInt(n.trim()));
        if (!isNaN(start) && !isNaN(end)) {
          for (let i = start; i <= end; i++) {
            codes.add(i);
          }
        }
      } else if (part.endsWith('=+')) {
        // Equal or greater: 400=+
        const base = parseInt(part.slice(0, -2).trim());
        if (!isNaN(base)) {
          // Add codes from base to 599 (reasonable upper limit for HTTP status codes)
          for (let i = base; i <= 599; i++) {
            codes.add(i);
          }
        }
      } else if (part.endsWith('+')) {
        // Greater than: 400+
        const base = parseInt(part.slice(0, -1).trim());
        if (!isNaN(base)) {
          // Add codes from base+1 to 599
          for (let i = base + 1; i <= 599; i++) {
            codes.add(i);
          }
        }
      } else {
        // Single code: 429
        const code = parseInt(part.trim());
        if (!isNaN(code)) {
          codes.add(code);
        }
      }
    }

    return codes.size > 0 ? codes : null;
  }

  parseAccessKeyFromAuth(authHeader) {
    // Extract [ACCESS_KEY:...] from the Authorization header
    const match = authHeader?.match(/\[ACCESS_KEY:([^\]]+)\]/i);
    if (!match) return null;
    return match[1].trim();
  }

  validateAccessKey(provider, authHeader) {
    const providerConfig = this.config.getProvider(provider);
    if (!providerConfig || !providerConfig.accessKey) {
      // No access key required for this provider
      return true;
    }

    const providedAccessKey = this.parseAccessKeyFromAuth(authHeader);
    if (!providedAccessKey) {
      return false;
    }

    return providedAccessKey === providerConfig.accessKey;
  }

  cleanAuthHeader(authHeader) {
    // Remove [STATUS_CODES:...] and [ACCESS_KEY:...] from the auth header before passing to the actual API
    if (!authHeader) return authHeader;

    const cleaned = authHeader
      .replace(/\[STATUS_CODES:[^\]]+\]/gi, '')
      .replace(/\[ACCESS_KEY:[^\]]+\]/gi, '')
      .trim();

    // If after cleaning we're left with just "Bearer" or "Bearer ", return null
    // This allows the client to add its own API key
    if (cleaned === 'Bearer' || cleaned === 'Bearer ') {
      return null;
    }

    return cleaned;
  }

  extractRelevantHeaders(headers, apiType) {
    const relevantHeaders: Record<string, string> = {};
    let headersToInclude = new Set<string>();

    if (apiType === 'gemini') {
      headersToInclude = new Set([
        'content-type',
        'accept',
        'x-goog-user-project'
        // Don't include x-goog-api-key here - we handle it separately
      ]);
    } else if (apiType === 'openai') {
      headersToInclude = new Set([
        'content-type',
        'accept',
        'user-agent',
        'openai-organization',
        'openai-project'
      ]);
    }

    for (const [key, value] of Object.entries(headers)) {
      const normalizedKey = key.toLowerCase();
      if (headersToInclude.has(normalizedKey)) {
        const normalizedValue = this.normalizeHeaderValue(value);
        if (normalizedValue !== null) {
          relevantHeaders[normalizedKey] = normalizedValue;
        }
      }
    }

    return relevantHeaders;
  }

  normalizeHeaderValue(value) {
    if (Array.isArray(value)) {
      const filtered = value.filter((item) => typeof item === 'string' && item.length > 0);
      return filtered.length > 0 ? filtered.join(', ') : null;
    }

    if (typeof value === 'string' && value.length > 0) {
      return value;
    }

    return null;
  }

  sendResponse(res, response) {
    const headers = { ...response.headers };
    // Prevent HTTP module from crashing or violating the HTTP spec by removing chunked encoding header
    // Since we buffered the entire response, it is no longer chunked.
    delete headers['transfer-encoding'];

    // Explicitly set the precise Content-Length
    if (response.data) {
      headers['content-length'] = Buffer.isBuffer(response.data)
        ? response.data.length
        : Buffer.byteLength(response.data);
    }

    res.writeHead(response.statusCode, headers);
    res.end(response.data);
  }

  sendError(res, statusCode, message) {
    const log = statusCode >= 500 ? console.error : console.warn;
    log(`[SERVER] ${statusCode} ${message}`);

    const errorResponse = {
      error: {
        code: statusCode,
        message: message,
        status: statusCode === 400 ? 'INVALID_ARGUMENT' : 'INTERNAL'
      }
    };

    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(errorResponse));
  }

  logApiResponse(requestId, response, requestBody = null) {
    const contentLength = response.headers['content-length'] || (response.data ? response.data.length : 0);
    const contentType = response.headers['content-type'] || 'unknown';

    // Store response data for viewing
    this.storeResponseData(requestId, {
      method: 'API_CALL',
      endpoint: 'proxied_request',
      apiType: 'LLM_API',
      status: response.statusCode,
      statusText: this.getStatusText(response.statusCode),
      contentType: contentType,
      responseData: response.data,
      requestBody: requestBody
    });

    const log = response.statusCode >= 500
      ? console.error
      : response.statusCode >= 400
        ? console.warn
        : console.log;
    const parts = [
      `[REQ-${requestId}]`,
      `${response.statusCode} ${this.getStatusText(response.statusCode)}`,
      `type=${contentType}`,
      `size=${contentLength}b`
    ];
    const errorMessage = this.extractResponseErrorMessage(response.data);

    if (errorMessage && response.statusCode >= 400) {
      parts.push(`err=${JSON.stringify(errorMessage)}`);
    }

    log(parts.join(' '));
  }

  extractResponseErrorMessage(responseData) {
    if (!responseData) {
      return null;
    }

    const rawData = Buffer.isBuffer(responseData) ? responseData.toString('utf8') : String(responseData);

    try {
      const parsed = JSON.parse(rawData);
      if (parsed?.error) {
        return parsed.error.message || parsed.error.code || 'Unknown error';
      }
    } catch {
      return rawData.substring(0, 200);
    }

    return null;
  }

  getStatusText(statusCode) {
    const statusTexts = {
      200: 'OK',
      201: 'Created',
      400: 'Bad Request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not Found',
      429: 'Too Many Requests',
      500: 'Internal Server Error',
      502: 'Bad Gateway',
      503: 'Service Unavailable'
    };
    return statusTexts[statusCode] || 'Unknown Status';
  }

  async handleAdminRequest(req, res, body) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    // Check if admin password is configured
    const adminPassword = this.getAdminPassword();
    if (!adminPassword) {
      this.sendError(res, 503, 'Admin panel not configured');
      return;
    }

    // Serve main admin page
    if (path === '/admin' || path === '/admin/') {
      this.serveAdminPanel(res);
      return;
    }

    // Check authentication status
    if (path === '/admin/api/auth' && req.method === 'GET') {
      const isAuthenticated = this.isAdminAuthenticated(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ authenticated: isAuthenticated }));
      return;
    }

    // Check login rate limit status
    if (path === '/admin/api/login-status' && req.method === 'GET') {
      const now = Date.now();
      const isBlocked = this.loginBlockedUntil && now < this.loginBlockedUntil;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        blocked: isBlocked,
        blockedUntil: this.loginBlockedUntil,
        remainingSeconds: isBlocked ? Math.ceil((this.loginBlockedUntil - now) / 1000) : 0,
        failedAttempts: this.failedLoginAttempts
      }));
      return;
    }

    // Handle login
    if (path === '/admin/login' && req.method === 'POST') {
      await this.handleAdminLogin(req, res, body);
      return;
    }

    // Handle logout
    if (path === '/admin/logout' && req.method === 'POST') {
      this.closeAllSseLogClients();
      this.adminSessionToken = null;
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'adminSession=; HttpOnly; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/admin'
      });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    if (path === '/admin/api/logs/stream' && req.method === 'GET') {
      this.handleLogsStream(req, res);
      return;
    }

    if (path === '/admin/api/metrics' && req.method === 'GET') {
      if (!this.canAccessAdminApi(req)) {
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Basic realm="admin"'
        });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      await this.handleGetMetrics(res);
      return;
    }

    // All other admin routes require authentication
    if (!this.isAdminAuthenticated(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    // Admin API routes
    if (path === '/admin/api/env' && req.method === 'GET') {
      await this.handleGetEnvVars(res);
    } else if (path === '/admin/api/config-file' && req.method === 'GET') {
      await this.handleGetConfigFile(res);
    } else if (path === '/admin/api/env' && req.method === 'POST') {
      await this.handleUpdateEnvVars(res, body);
    } else if (path === '/admin/api/config-file' && req.method === 'POST') {
      await this.handleImportConfigFile(res, body);
    } else if (path === '/admin/api/test' && req.method === 'POST') {
      await this.handleTestApiKey(res, body);
    } else if (path === '/admin/api/logs' && req.method === 'GET') {
      await this.handleGetLogs(res);
    } else if (path.startsWith('/admin/api/response/') && req.method === 'GET') {
      await this.handleGetResponse(res, path);
    } else {
      this.sendError(res, 404, 'Not found');
    }
  }

  generateSessionToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  parseCookies(cookieHeader) {
    const cookies = {};
    if (cookieHeader) {
      cookieHeader.split(';').forEach(cookie => {
        const parts = cookie.trim().split('=');
        if (parts.length === 2) {
          cookies[parts[0]] = parts[1];
        }
      });
    }
    return cookies;
  }

  isAdminAuthenticated(req) {
    const cookies = this.parseCookies(req.headers.cookie);
    return cookies.adminSession === this.adminSessionToken && this.adminSessionToken !== null;
  }

  async handleAdminLogin(req, res, body) {
    try {
      // Check if login is currently blocked
      if (this.loginBlockedUntil && Date.now() < this.loginBlockedUntil) {
        const remainingSeconds = Math.ceil((this.loginBlockedUntil - Date.now()) / 1000);
        const remainingMinutes = Math.ceil(remainingSeconds / 60);
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: `Too many failed login attempts. Please wait ${remainingMinutes} minute(s).`,
          blockedUntil: this.loginBlockedUntil,
          remainingSeconds: remainingSeconds
        }));
        return;
      }

      const data = JSON.parse(body);
      const adminPassword = this.getAdminPassword();

      if (data.password === adminPassword) {
        // Successful login - reset counters
        this.failedLoginAttempts = 0;
        this.loginBlockedUntil = null;
        this.adminSessionToken = this.generateSessionToken();

        // Set session cookie (expires in 24 hours)
        const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toUTCString();
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `adminSession=${this.adminSessionToken}; HttpOnly; Expires=${expires}; Path=/admin`
        });
        res.end(JSON.stringify({ success: true }));
      } else {
        // Failed login - increment counter
        this.failedLoginAttempts++;
        const attemptsRemaining = 5 - this.failedLoginAttempts;

        // Block if reached 5 attempts
        if (this.failedLoginAttempts >= 5) {
          this.loginBlockedUntil = Date.now() + (5 * 60 * 1000); // 5 minutes
          console.log('[SECURITY] Login blocked due to 5 failed attempts. Blocked until:', new Date(this.loginBlockedUntil).toISOString());
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Too many failed login attempts. Please wait 5 minutes.',
            blockedUntil: this.loginBlockedUntil,
            remainingSeconds: 300
          }));
        } else {
          console.log(`[SECURITY] Failed login attempt ${this.failedLoginAttempts}/5`);
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: `Invalid password. ${attemptsRemaining} attempt(s) remaining.`,
            attemptsRemaining: attemptsRemaining
          }));
        }
      }
    } catch (error) {
      this.sendError(res, 400, 'Invalid request');
    }
  }

  async handleGetEnvVars(res) {
    try {
      const payload = this.config.toAdminPayload();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    } catch (error) {
      this.sendError(res, 500, 'Failed to read environment variables');
    }
  }

  async handleGetConfigFile(res) {
    try {
      const tomlContent = this.config.toTomlFileString();
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(tomlContent);
    } catch (error) {
      this.sendError(res, 500, 'Failed to read config.toml');
    }
  }

  getAdminPassword() {
    return this.config.getAdminPassword();
  }

  validateAdminRequest(req) {
    const adminPassword = this.getAdminPassword();
    if (!adminPassword) {
      return false;
    }

    const authHeader = req.headers?.authorization;
    if (!authHeader || typeof authHeader !== 'string') {
      return false;
    }

    const [scheme, token] = authHeader.split(' ');
    if (scheme !== 'Basic' || !token) {
      return false;
    }

    try {
      const decoded = Buffer.from(token, 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx === -1) {
        return false;
      }

      const username = decoded.slice(0, idx);
      const password = decoded.slice(idx + 1);

      return username === 'admin' && password === adminPassword;
    } catch {
      return false;
    }
  }

  canAccessAdminApi(req) {
    return this.isAdminAuthenticated(req) || this.validateAdminRequest(req);
  }

  handleLogsStream(req, res) {
    if (!this.canAccessAdminApi(req)) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Basic realm="admin", charset="UTF-8"'
      });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    if (res.socket) {
      res.socket.setTimeout(0);
      res.socket.setNoDelay(true);
      res.socket.setKeepAlive(true);
    }

    const clientId = crypto.randomBytes(12).toString('hex');

    const keepAliveInterval = setInterval(() => {
      try {
        const ok = res.write(`: ping ${Date.now()}\n\n`);
        if (!ok) {
          this.removeSseLogClient(clientId);
        }
      } catch {
        this.removeSseLogClient(clientId);
      }
    }, 15000);

    this.sseLogClients.set(clientId, { res, keepAliveInterval });

    const cleanup = () => {
      this.removeSseLogClient(clientId);
    };

    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);

    this.writeSseEventToClient(clientId, 'connected', {
      ok: true,
      now: new Date().toISOString()
    });
  }

  removeSseLogClient(clientId) {
    const client = this.sseLogClients.get(clientId);
    if (!client) {
      return;
    }

    this.sseLogClients.delete(clientId);

    try {
      clearInterval(client.keepAliveInterval);
    } catch {}

    try {
      if (client.res && !client.res.writableEnded) {
        client.res.end();
      }
    } catch {}
  }

  closeAllSseLogClients() {
    for (const clientId of Array.from(this.sseLogClients.keys())) {
      this.removeSseLogClient(clientId);
    }
  }

  writeSseEventToClient(clientId, eventName, data) {
    const client = this.sseLogClients.get(clientId);
    if (!client) {
      return;
    }

    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    const frame = `event: ${eventName}\ndata: ${payload}\n\n`;

    try {
      const ok = client.res.write(frame);
      if (!ok) {
        this.removeSseLogClient(clientId);
      }
    } catch {
      this.removeSseLogClient(clientId);
    }
  }


  async handleUpdateEnvVars(res, body) {
    try {
      const payload = JSON.parse(body);
      this.config.updateFromAdminPayload(payload);
      this.reinitializeClients();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (error) {
      this.sendError(res, 500, 'Failed to update environment variables');
    }
  }

  async handleImportConfigFile(res, body) {
    try {
      const payload = JSON.parse(body);
      const tomlContent = typeof payload?.toml === 'string' ? payload.toml : '';

      if (!tomlContent.trim()) {
        this.sendError(res, 400, 'TOML content is required');
        return;
      }

      this.config.updateFromTomlString(tomlContent);
      this.reinitializeClients();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (error) {
      this.sendError(res, 400, `Failed to import config.toml: ${error?.message || 'Unknown error'}`);
    }
  }

  async handleTestApiKey(res, body) {
    try {
      const { apiType, apiKey, baseUrl } = JSON.parse(body);
      let testResult = { success: false, error: 'Unknown API type' };

      if (apiType === 'gemini') {
        // Test Gemini API key with custom base URL if provided
        testResult = await this.testGeminiKey(apiKey, baseUrl);
      } else if (apiType === 'openai') {
        // Test OpenAI API key with custom base URL if provided
        testResult = await this.testOpenaiKey(apiKey, baseUrl);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(testResult));
    } catch (error) {
      this.sendError(res, 500, 'Failed to test API key');
    }
  }

  async testGeminiKey(apiKey, baseUrl = null) {
    const testId = Math.random().toString(36).substring(2, 11);
    const testBaseUrl = baseUrl || 'https://generativelanguage.googleapis.com/v1';
    const startTime = Date.now();

    // Determine the correct path based on base URL
    let testPath = '/models';
    let fullUrl: string;

    if (testBaseUrl.includes('/v1') || testBaseUrl.includes('/v1beta')) {
      // Base URL already includes version, just append models
      fullUrl = `${testBaseUrl.endsWith('/') ? testBaseUrl.slice(0, -1) : testBaseUrl}/models?key=${apiKey}`;
    } else {
      // Base URL doesn't include version, add /v1/models
      fullUrl = `${testBaseUrl.endsWith('/') ? testBaseUrl.slice(0, -1) : testBaseUrl}/v1/models?key=${apiKey}`;
      testPath = '/v1/models';
    }

    try {
      const testResponse = await fetch(fullUrl);
      const responseText = await testResponse.text();
      const contentType = testResponse.headers.get('content-type') || 'unknown';
      const responseTime = Date.now() - startTime;

      // Store response data for viewing
      this.storeResponseData(testId, {
        method: 'GET',
        endpoint: testPath,
        apiType: 'Gemini',
        status: testResponse.status,
        statusText: testResponse.statusText,
        contentType: contentType,
        responseData: responseText,
        requestBody: null
      });

      // Log with structured format
      const error = !testResponse.ok ? `API test failed: ${testResponse.status} ${testResponse.statusText}` : null;
      this.logApiRequest(testId, 'GET', testPath, 'gemini', testResponse.status, responseTime, error, 'admin-test', {
        requestType: 'admin-test',
        ...this.buildApiKeyMeta(apiKey)
      });

      console.log(`[TEST-${testId}] GET ${testPath} (Gemini) → ${testResponse.status} ${testResponse.statusText} | ${contentType} ${responseText.length}b`);

      return {
        success: testResponse.ok,
        error: error
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;

      console.log(`[TEST-${testId}] GET ${testPath} (Gemini) → ERROR: ${error.message}`);
      this.logApiRequest(testId, 'GET', testPath, 'gemini', null, responseTime, error.message, 'admin-test', {
        requestType: 'admin-test',
        ...this.buildApiKeyMeta(apiKey)
      });

      return { success: false, error: error.message };
    }
  }

  async testOpenaiKey(apiKey, baseUrl = null) {
    const testId = Math.random().toString(36).substring(2, 11);
    const testBaseUrl = baseUrl || 'https://api.openai.com/v1';
    const startTime = Date.now();

    // Construct the full URL - just append /models to the base URL
    const fullUrl = `${testBaseUrl.endsWith('/') ? testBaseUrl.slice(0, -1) : testBaseUrl}/models`;

    // Determine display path for logging
    let testPath = '/models';
    if (testBaseUrl.includes('/openai/v1')) {
      testPath = '/openai/v1/models';
    } else if (testBaseUrl.includes('/v1')) {
      testPath = '/v1/models';
    }

    try {
      const testResponse = await fetch(fullUrl, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });

      const responseText = await testResponse.text();
      const contentType = testResponse.headers.get('content-type') || 'unknown';
      const responseTime = Date.now() - startTime;

      // Store response data for viewing
      this.storeResponseData(testId, {
        method: 'GET',
        endpoint: testPath,
        apiType: 'OpenAI',
        status: testResponse.status,
        statusText: testResponse.statusText,
        contentType: contentType,
        responseData: responseText,
        requestBody: null
      });

      // Log with structured format
      const error = !testResponse.ok ? `API test failed: ${testResponse.status} ${testResponse.statusText}` : null;
      this.logApiRequest(testId, 'GET', testPath, 'openai', testResponse.status, responseTime, error, 'admin-test', {
        requestType: 'admin-test',
        ...this.buildApiKeyMeta(apiKey)
      });

      console.log(`[TEST-${testId}] GET ${testPath} (OpenAI) → ${testResponse.status} ${testResponse.statusText} | ${contentType} ${responseText.length}b`);

      return {
        success: testResponse.ok,
        error: error
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;

      console.log(`[TEST-${testId}] GET ${testPath} (OpenAI) → ERROR: ${error.message}`);
      this.logApiRequest(testId, 'GET', testPath, 'openai', null, responseTime, error.message, 'admin-test', {
        requestType: 'admin-test',
        ...this.buildApiKeyMeta(apiKey)
      });

      return { success: false, error: error.message };
    }
  }

  async handleGetLogs(res) {
    try {
      const allLogs = this.readPersistedLogs();
      const recentLogs = allLogs.slice(-200);
      const analytics = this.buildLogAnalytics(allLogs);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        logs: recentLogs,
        totalEntries: allLogs.length,
        format: 'json',
        logFilePath: this.logFilePath,
        summary: analytics.summary,
        apiKeyStats: analytics.apiKeyStats,
        statusCounts: analytics.statusCounts,
        providerCounts: analytics.providerCounts
      }));
    } catch (error) {
      console.error('Failed to get logs:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Failed to retrieve logs',
        logs: []
      }));
    }
  }

  async handleGetMetrics(res) {
    try {
      const logs = Array.isArray(this.logHistory) ? this.logHistory : [];
      const payload = this.buildHealthMetricsPayload(logs);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    } catch (error) {
      console.error('Failed to get metrics:', error?.message || String(error));
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to calculate metrics' }));
    }
  }

  buildHealthMetricsPayload(logs) {
    const initAcc = () => ({
      totalRequests: 0,
      count429: 0,
      count400: 0,
      success: 0,
      latencySum: 0,
      latencyCount: 0
    });

    const updateAcc = (acc, log) => {
      const status = log.status;
      acc.totalRequests += 1;

      if (status === 429) {
        acc.count429 += 1;
      }
      if (status === 400) {
        acc.count400 += 1;
      }
      if (typeof status === 'number' && status < 400) {
        acc.success += 1;
      }

      if (typeof log.responseTime === 'number' && Number.isFinite(log.responseTime)) {
        acc.latencySum += log.responseTime;
        acc.latencyCount += 1;
      }
    };

    const finalize = (acc) => {
      const averageLatency = acc.latencyCount > 0 ? acc.latencySum / acc.latencyCount : null;
      const healthScore = acc.totalRequests > 0
        ? Math.round((acc.success / acc.totalRequests) * 10000) / 100
        : null;

      return {
        totalRequests: acc.totalRequests,
        '429Count': acc.count429,
        '400Count': acc.count400,
        averageLatency,
        healthScore
      };
    };

    const completed = (Array.isArray(logs) ? logs : []).filter((log) => (
      log && typeof log === 'object' && typeof log.status === 'number'
    ));

    const minuteBuckets = new Map();

    const overallAcc = initAcc();
    const providers = {};

    for (const log of completed) {
      updateAcc(overallAcc, log);

      const bucketDate = new Date(log.timestamp || Date.now());
      if (!Number.isNaN(bucketDate.getTime())) {
        bucketDate.setSeconds(0, 0);
        const bucketKey = bucketDate.toISOString();
        if (!minuteBuckets.has(bucketKey)) {
          minuteBuckets.set(bucketKey, {
            timestamp: bucketKey,
            requests: 0,
            latencySum: 0,
            latencyCount: 0
          });
        }

        const bucket = minuteBuckets.get(bucketKey);
        bucket.requests += 1;
        if (typeof log.responseTime === 'number' && Number.isFinite(log.responseTime)) {
          bucket.latencySum += log.responseTime;
          bucket.latencyCount += 1;
        }
      }

      const providerName = log.provider || 'unknown';
      if (!providers[providerName]) {
        providers[providerName] = { acc: initAcc(), keys: {} };
      }
      updateAcc(providers[providerName].acc, log);

      const keyLabel = log.apiKeyLabel || log.apiKeyMasked || log.apiKeyId;
      if (keyLabel) {
        if (!providers[providerName].keys[keyLabel]) {
          providers[providerName].keys[keyLabel] = initAcc();
        }
        updateAcc(providers[providerName].keys[keyLabel], log);
      }
    }

    const providerPayload = {};
    for (const providerName of Object.keys(providers)) {
      const providerEntry = providers[providerName];
      const keysPayload = {};
      for (const keyLabel of Object.keys(providerEntry.keys)) {
        keysPayload[keyLabel] = finalize(providerEntry.keys[keyLabel]);
      }

      providerPayload[providerName] = {
        ...finalize(providerEntry.acc),
        keys: keysPayload
      };
    }

    const timeline = Array.from(minuteBuckets.values())
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
      .slice(-20)
      .map((bucket) => ({
        timestamp: bucket.timestamp,
        requests: bucket.requests,
        averageLatency: bucket.latencyCount > 0 ? Math.round((bucket.latencySum / bucket.latencyCount) * 100) / 100 : null
      }));

    return {
      source: 'memory',
      entries: Array.isArray(logs) ? logs.length : 0,
      completedRequests: completed.length,
      overall: finalize(overallAcc),
      providers: providerPayload,
      timeline
    };
  }


  logApiRequest(requestId, method, endpoint, provider, status = null, responseTime = null, error = null, clientIp = null, meta = {}) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      requestId: requestId || 'unknown',
      method: method || 'UNKNOWN',
      endpoint: endpoint || 'unknown',
      provider: provider || 'unknown',
      status: status,
      responseTime: responseTime,
      error: error,
      clientIp: clientIp,
      requestType: meta.requestType || (status === null ? 'request' : 'response'),
      apiKeyMasked: meta.apiKeyMasked || null,
      apiKeyId: meta.apiKeyId || null,
      apiKeyLabel: meta.apiKeyLabel || meta.apiKeyMasked || meta.apiKeyId || null
    };

    this.logRequest(logEntry);
  }

  logRequest(logEntry) {
    const normalized = this.normalizeLogEntry(logEntry);

    this.logBuffer.push(normalized);
    if (this.logBuffer.length > 100) {
      this.logBuffer.shift();
    }

    this.appendLogToFile(normalized);

    if (!this.sseLogClients || this.sseLogClients.size === 0) {
      return;
    }

    for (const clientId of Array.from(this.sseLogClients.keys())) {
      this.writeSseEventToClient(clientId, 'log', normalized);
    }
  }


  // Helper method for backward compatibility - converts old string calls to new structured calls
  logApiRequestLegacy(message) {
    // Parse message to extract structured data
    const timestamp = new Date().toISOString();

    // Extract request ID if present
    const reqIdMatch = message.match(/\[REQ-([^\]]+)\]/);
    const requestId = reqIdMatch ? reqIdMatch[1] : 'unknown';

    // Extract method and endpoint
    const methodMatch = message.match(/(GET|POST|PUT|DELETE|PATCH)\s+([^\s]+)/);
    const method = methodMatch ? methodMatch[1] : 'UNKNOWN';
    const endpoint = methodMatch ? methodMatch[2] : 'unknown';

    // Extract provider
    let provider = 'unknown';
    if (message.includes('OpenAI')) provider = 'openai';
    else if (message.includes('Gemini')) provider = 'gemini';
    else if (message.includes('groq')) provider = 'groq';
    else if (message.includes('openrouter')) provider = 'openrouter';

    // Extract status code
    const statusMatch = message.match(/(\d{3})\s+/);
    const status = statusMatch ? parseInt(statusMatch[1]) : null;

    // Extract error information
    const error = message.includes('error') || message.includes('Error') || status >= 400 ? message : null;

    this.logApiRequest(requestId, method, endpoint, provider, status, null, error, null);
  }


  resolveLogFilePath() {
    const configuredPath = process.env.AIKEY_LOG_FILE || process.env.LOG_FILE_PATH;
    if (configuredPath && configuredPath.trim()) {
      return path.resolve(configuredPath.trim());
    }
    return path.join(os.tmpdir(), 'aikey.log');
  }

  ensureLogFileDirectory() {
    try {
      const dir = path.dirname(this.logFilePath);
      if (dir && dir !== '.' && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch (error) {
      console.error(`[LOG] Failed to prepare log directory for ${this.logFilePath}: ${error.message}`);
    }
  }

  appendLogToFile(logEntry) {
    try {
      fs.appendFileSync(this.logFilePath, `${JSON.stringify(logEntry)}\n`);
    } catch (error) {
      console.error(`[LOG] Failed to append to ${this.logFilePath}: ${error.message}`);
    }
  }

  readPersistedLogs() {
    try {
      if (fs.existsSync(this.logFilePath)) {
        const content = fs.readFileSync(this.logFilePath, 'utf8');
        if (!content.trim()) {
          return [];
        }

        return content
          .split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0)
          .map((line) => {
            try {
              return this.normalizeLogEntry(JSON.parse(line));
            } catch {
              return this.normalizeLogEntry(line);
            }
          });
      }
    } catch (error) {
      console.error(`[LOG] Failed to read persisted logs from ${this.logFilePath}: ${error.message}`);
    }

    return this.logBuffer.map(log => this.normalizeLogEntry(log));
  }

  normalizeLogEntry(log) {
    if (typeof log === 'string') {
      const match = log.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s+(.*)$/);
      if (match) {
        return {
          timestamp: match[1],
          requestId: 'legacy',
          method: 'UNKNOWN',
          endpoint: 'unknown',
          provider: 'unknown',
          status: null,
          responseTime: null,
          error: null,
          clientIp: null,
          requestType: 'legacy',
          apiKeyMasked: null,
          apiKeyId: null,
          apiKeyLabel: null,
          message: match[2]
        };
      }

      return {
        timestamp: new Date().toISOString(),
        requestId: 'unknown',
        method: 'UNKNOWN',
        endpoint: 'unknown',
        provider: 'unknown',
        status: null,
        responseTime: null,
        error: null,
        clientIp: null,
        requestType: 'legacy',
        apiKeyMasked: null,
        apiKeyId: null,
        apiKeyLabel: null,
        message: log
      };
    }

    if (!log || typeof log !== 'object') {
      return {
        timestamp: new Date().toISOString(),
        requestId: 'unknown',
        method: 'UNKNOWN',
        endpoint: 'unknown',
        provider: 'unknown',
        status: null,
        responseTime: null,
        error: null,
        clientIp: null,
        requestType: 'unknown',
        apiKeyMasked: null,
        apiKeyId: null,
        apiKeyLabel: null,
        message: String(log)
      };
    }

    return {
      timestamp: log.timestamp || new Date().toISOString(),
      requestId: log.requestId || 'unknown',
      method: log.method || 'UNKNOWN',
      endpoint: log.endpoint || 'unknown',
      provider: log.provider || 'unknown',
      status: typeof log.status === 'number' ? log.status : (log.status ?? null),
      responseTime: typeof log.responseTime === 'number' ? log.responseTime : (log.responseTime ?? null),
      error: log.error || null,
      clientIp: log.clientIp || null,
      requestType: log.requestType || (log.status === null || log.status === undefined ? 'request' : 'response'),
      apiKeyMasked: log.apiKeyMasked || null,
      apiKeyId: log.apiKeyId || null,
      apiKeyLabel: log.apiKeyLabel || log.apiKeyMasked || log.apiKeyId || null,
      message: log.message || null
    };
  }

  buildApiKeyMeta(apiKey) {
    if (!apiKey) {
      return {
        apiKeyMasked: null,
        apiKeyId: null,
        apiKeyLabel: null
      };
    }

    const apiKeyMasked = this.maskApiKey(apiKey);
    const apiKeyId = crypto.createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 12);

    return {
      apiKeyMasked,
      apiKeyId,
      apiKeyLabel: `${apiKeyMasked} (${apiKeyId})`
    };
  }

  maskApiKey(key) {
    if (!key || key.length < 8) {
      return '***';
    }

    return `${key.substring(0, 4)}...${key.substring(key.length - 4)}`;
  }

  buildLogAnalytics(logs) {
    const statusCounts = {};
    const providerCounts = {};
    const keyStatsMap = new Map();
    const summary = {
      totalEntries: 0,
      completedRequests: 0,
      successfulRequests: 0,
      errorRequests: 0,
      status400: 0,
      status429: 0,
      other4xx: 0,
      other5xx: 0
    };

    for (const log of logs) {
      if (!log || typeof log !== 'object') {
        continue;
      }

      if (log.status === null || log.status === undefined) {
        continue;
      }

      summary.totalEntries += 1;
      summary.completedRequests += 1;
      providerCounts[log.provider || 'unknown'] = (providerCounts[log.provider || 'unknown'] || 0) + 1;
      statusCounts[log.status] = (statusCounts[log.status] || 0) + 1;

      if (log.status >= 400) {
        summary.errorRequests += 1;
      } else {
        summary.successfulRequests += 1;
      }

      if (log.status === 400) {
        summary.status400 += 1;
      } else if (log.status === 429) {
        summary.status429 += 1;
      } else if (log.status >= 400 && log.status < 500) {
        summary.other4xx += 1;
      } else if (log.status >= 500) {
        summary.other5xx += 1;
      }

      const keyLabel = log.apiKeyLabel || log.apiKeyMasked || log.apiKeyId;
      if (!keyLabel) {
        continue;
      }

      const keyId = `${log.provider || 'unknown'}::${keyLabel}`;
      if (!keyStatsMap.has(keyId)) {
        keyStatsMap.set(keyId, {
          provider: log.provider || 'unknown',
          apiKeyLabel: keyLabel,
          apiKeyMasked: log.apiKeyMasked || keyLabel,
          apiKeyId: log.apiKeyId || null,
          totalRequests: 0,
          status400: 0,
          status429: 0,
          other4xx: 0,
          other5xx: 0,
          success: 0,
          lastSeen: log.timestamp || null
        });
      }

      const keyStats = keyStatsMap.get(keyId);
      keyStats.totalRequests += 1;
      keyStats.lastSeen = log.timestamp || keyStats.lastSeen;

      if (log.status === 400) {
        keyStats.status400 += 1;
      } else if (log.status === 429) {
        keyStats.status429 += 1;
      } else if (log.status >= 400 && log.status < 500) {
        keyStats.other4xx += 1;
      } else if (log.status >= 500) {
        keyStats.other5xx += 1;
      } else {
        keyStats.success += 1;
      }
    }

    const apiKeyStats = Array.from(keyStatsMap.values()).map(stat => ({
      ...stat,
      throttledRequests: stat.status429 + stat.status400,
      errorRequests: stat.status429 + stat.status400 + stat.other4xx + stat.other5xx
    })).sort((a, b) => {
      const throttleDelta = (b.status429 + b.status400) - (a.status429 + a.status400);
      if (throttleDelta !== 0) return throttleDelta;

      const errorDelta = b.errorRequests - a.errorRequests;
      if (errorDelta !== 0) return errorDelta;

      return b.totalRequests - a.totalRequests;
    });

    return {
      summary,
      apiKeyStats,
      statusCounts,
      providerCounts
    };
  }


  storeResponseData(testId, responseData) {
    // Store response data for viewing (keep last 100 responses)
    this.responseStorage.set(testId, responseData);
    if (this.responseStorage.size > 100) {
      const firstKey = this.responseStorage.keys().next().value;
      this.responseStorage.delete(firstKey);
    }
  }

  async handleGetResponse(res, path) {
    try {
      const testId = path.split('/').pop(); // Extract testId from path
      const responseData = this.responseStorage.get(testId);

      if (!responseData) {
        this.sendError(res, 404, 'Response not found');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseData));
    } catch (error) {
      this.sendError(res, 500, 'Failed to get response data');
    }
  }

  serveAdminPanel(res) {
    try {
      const htmlPath = path.join(process.cwd(), 'public', 'admin.html');
      const html = fs.readFileSync(htmlPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch (error) {
      this.sendError(res, 500, 'Admin panel not found');
    }
  }

  /**
   * Reinitialize API clients with updated configuration
   * Called after environment variables are updated via admin panel
   */
  reinitializeClients() {
    console.log('[SERVER] Reinitializing API clients with updated configuration...');

    // Clear all provider clients
    this.providerClients.clear();

    // Reinitialize legacy clients for backward compatibility
    if (this.config.hasGeminiKeys()) {
      const geminiKeyRotator = new KeyRotator(this.config.getGeminiApiKeys(), 'gemini');
      this.geminiClient = new GeminiClient(geminiKeyRotator, this.config.getGeminiBaseUrl());
      console.log('[SERVER] Legacy Gemini client reinitialized');
    } else {
      this.geminiClient = null;
      console.log('[SERVER] Legacy Gemini client disabled (no keys available)');
    }

    if (this.config.hasOpenaiKeys()) {
      const openaiKeyRotator = new KeyRotator(this.config.getOpenaiApiKeys(), 'openai');
      this.openaiClient = new OpenAIClient(openaiKeyRotator, this.config.getOpenaiBaseUrl());
      console.log('[SERVER] Legacy OpenAI client reinitialized');
    } else {
      this.openaiClient = null;
      console.log('[SERVER] Legacy OpenAI client disabled (no keys available)');
    }

    console.log(`[SERVER] ${this.config.getProviders().size} providers available for dynamic initialization`);
  }

  stop() {
    if (this.server) {
      this.server.close();
    }
  }
}

export default ProxyServer;
