import * as https from 'node:https';
import * as crypto from 'node:crypto';
import { URL } from 'node:url';

export class GeminiClient {
  constructor(keyRotator, baseUrl = 'https://generativelanguage.googleapis.com', burstSize = 1, requestTimeoutMs = 120000) {
    this.keyRotator = keyRotator;
    this.baseUrl = baseUrl;
    this.burstSize = burstSize;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async makeRequest(method, path, body, headers = {}, customStatusCodes = null) {
    // Check if an API key was provided in headers
    const providedApiKey = headers['x-goog-api-key'];

    // If an API key was provided, use it directly without rotation
    if (providedApiKey) {
      const maskedKey = this.maskApiKey(providedApiKey);
      console.log(`[GEMINI::${maskedKey}] direct`);

      // Remove the x-goog-api-key from headers since we'll handle it
      const cleanHeaders = { ...headers };
      delete cleanHeaders['x-goog-api-key'];

      try {
        const response = await this.sendRequest(method, path, body, cleanHeaders, providedApiKey, true);
        console.log(`[GEMINI::${maskedKey}] ok ${response.statusCode}`);
        return this.attachResponseMeta(response, providedApiKey, 'provided', 1, 1);
      } catch (error) {
        console.error(`[GEMINI::${maskedKey}] fail ${error.message}`);
        throw error;
      }
    }

    const rotationStatusCodes = this.resolveRotationStatusCodes(customStatusCodes);
    const initialAttempt = await this.executeRotatingRequest(method, path, body, headers, rotationStatusCodes);

    if (initialAttempt.type === 'success') {
      const { response, apiKey, requestContext } = initialAttempt;
      const maskedKey = this.maskApiKey(apiKey);
      console.log(`[GEMINI::${maskedKey}] ok ${response.statusCode}`);
      return this.attachResponseMeta(response, apiKey, 'rotation', this.burstSize, requestContext.triedKeys.size);
    }

    if (initialAttempt.type === 'model_upgrade_needed') {
      const upgraded = this.upgradeGeminiModelRequest(path, body);
      const fallbackAttempt = await this.executeRotatingRequest(
        method,
        upgraded.path,
        upgraded.body,
        headers,
        rotationStatusCodes,
        { minTier: 1 }
      );

      if (fallbackAttempt.type === 'success') {
        const { response, apiKey, requestContext } = fallbackAttempt;
        const maskedKey = this.maskApiKey(apiKey);
        console.log(`[GEMINI::${maskedKey}] ok ${response.statusCode}`);
        return this.attachResponseMeta(response, apiKey, 'rotation', this.burstSize, requestContext.triedKeys.size);
      }

      if (fallbackAttempt.type === 'hard_error') {
        const { response, apiKey, requestContext } = fallbackAttempt;
        const maskedKey = this.maskApiKey(apiKey);
        console.log(`[GEMINI::${maskedKey}] fail ${response.statusCode} (terminal)`);
        return this.attachResponseMeta(response, apiKey, 'rotation', this.burstSize, requestContext.triedKeys.size);
      }

      if (fallbackAttempt.type === 'model_upgrade_needed') {
        const { response, apiKey, requestContext } = fallbackAttempt;
        const maskedKey = this.maskApiKey(apiKey);
        console.log(`[GEMINI::${maskedKey}] fail ${response.statusCode} (terminal)`);
        return this.attachResponseMeta(response, apiKey, 'rotation', this.burstSize, requestContext.triedKeys.size);
      }

      if (fallbackAttempt.type === 'rate_limited') {
        console.warn('[GEMINI] 429 exhausted');
        return this.attachResponseMeta(fallbackAttempt.response, fallbackAttempt.apiKey, 'rotation', this.burstSize, fallbackAttempt.requestContext.triedKeys.size);
      }

      if (fallbackAttempt.lastError) {
        throw fallbackAttempt.lastError;
      }

      throw fallbackAttempt.error || initialAttempt.error || new Error('All API keys exhausted without clear error');
    }

    if (initialAttempt.type === 'hard_error') {
      const { response, apiKey, requestContext } = initialAttempt;
      const maskedKey = this.maskApiKey(apiKey);
      console.log(`[GEMINI::${maskedKey}] fail ${response.statusCode} (terminal)`);
      return this.attachResponseMeta(response, apiKey, 'rotation', this.burstSize, requestContext.triedKeys.size);
    }

    if (initialAttempt.type === 'model_upgrade_needed') {
      const { response, apiKey, requestContext } = initialAttempt;
      const maskedKey = this.maskApiKey(apiKey);
      console.log(`[GEMINI::${maskedKey}] fail ${response.statusCode} (terminal)`);
      return this.attachResponseMeta(response, apiKey, 'rotation', this.burstSize, requestContext.triedKeys.size);
    }

    if (initialAttempt.type === 'rate_limited') {
      console.warn('[GEMINI] 429 exhausted');
      return this.attachResponseMeta(initialAttempt.response, initialAttempt.apiKey, 'rotation', this.burstSize, initialAttempt.requestContext.triedKeys.size);
    }

    if (initialAttempt.lastError) {
      throw initialAttempt.lastError;
    }

    throw initialAttempt.error || new Error('All API keys exhausted without clear error');
  }

  resolveRotationStatusCodes(customStatusCodes = null) {
    if (customStatusCodes instanceof Set) {
      return customStatusCodes;
    }

    if (Array.isArray(customStatusCodes)) {
      return new Set(customStatusCodes);
    }

    // Burst size 1 is the conservative mode for Gemini. In that mode we do not
    // implicitly fan out on 429, because Gemini often rate limits per project/IP
    // and retrying every key just burns the whole pool.
    if (this.burstSize <= 1) {
      return new Set();
    }

    return new Set([429]);
  }

  async executeRotatingRequest(method, path, body, headers, rotationStatusCodes, options = {}) {
    const requestContext = options.requestContext || this.keyRotator.createRequestContext(options);
    let lastError = null;
    let lastResponse = null;

    while (true) {
      const batch = requestContext.getNextBatch(this.burstSize);
      if (batch.length === 0) {
        break;
      }

      const abortController = new AbortController();

      const results = await Promise.allSettled(batch.map(async (apiKey) => {
        const maskedKey = this.maskApiKey(apiKey);
        console.log(`[GEMINI::${maskedKey}] try ${method} ${path}${batch.length > 1 ? ` (Burst: ${batch.length})` : ''}`);

        try {
          const response = await this.sendRequest(method, path, body, headers, apiKey, false, abortController.signal);

          if (response.statusCode >= 200 && response.statusCode < 300) {
            abortController.abort();
            return { type: 'success', response, apiKey };
          }

          if (rotationStatusCodes.has(response.statusCode)) {
            requestContext.markKeyAsRateLimited(apiKey, response.statusCode);
            return { type: 'retryable', response, apiKey };
          }

          requestContext.markKeyAsFailed(apiKey);
          if (this.shouldRetryWithTieredKeys(path, response)) {
            return { type: 'model_upgrade_needed', response, apiKey };
          }

          return { type: 'hard_error', response, apiKey };
        } catch (error) {
          if (error.name === 'AbortError') {
            return { type: 'aborted' };
          }
          console.error(`[GEMINI::${maskedKey}] fail ${error.message}`);
          requestContext.markKeyAsFailed(apiKey);
          return { type: 'error', error, apiKey };
        }
      }));

      const successResult = results.find(r => r.status === 'fulfilled' && r.value.type === 'success');
      if (successResult) {
        const { response, apiKey } = successResult.value;
        return { type: 'success', response, apiKey, requestContext };
      }

      const fallbackCandidate = results.find(r => r.status === 'fulfilled' && r.value.type === 'model_upgrade_needed');
      if (fallbackCandidate) {
        const { response, apiKey } = fallbackCandidate.value;
        this.keyRotator.updateLastFailedKey(requestContext.getLastFailedKey() || apiKey);
        return { type: 'model_upgrade_needed', response, apiKey, requestContext };
      }

      const hardErrorResult = results.find(r => r.status === 'fulfilled' && r.value.type === 'hard_error');
      if (hardErrorResult) {
        const { response, apiKey } = hardErrorResult.value;
        this.keyRotator.updateLastFailedKey(requestContext.getLastFailedKey() || apiKey);
        return { type: 'hard_error', response, apiKey, requestContext };
      }

      for (const result of results) {
        if (result.status === 'fulfilled') {
          const val = result.value;
          if (val.type === 'retryable') {
            lastResponse = val.response;
          } else if (val.type === 'error') {
            lastError = val.error;
          }
        }
      }
    }

    if (requestContext.allTriedKeysRateLimited()) {
      const lastFailedKey = requestContext.getLastFailedKey();
      this.keyRotator.updateLastFailedKey(lastFailedKey);
      return {
        type: 'rate_limited',
        response: lastResponse || {
          statusCode: 429,
          headers: { 'content-type': 'application/json' },
          data: JSON.stringify({
            error: {
              code: 429,
              message: 'All API keys returned 429',
              status: 'RESOURCE_EXHAUSTED'
            }
          })
        },
        apiKey: lastFailedKey,
        requestContext
      };
    }

    const lastFailedKey = requestContext.getLastFailedKey();
    this.keyRotator.updateLastFailedKey(lastFailedKey);

    if (lastError) {
      return { type: 'error', error: lastError, lastError, requestContext };
    }

    return { type: 'exhausted', error: new Error('All API keys exhausted without clear error'), requestContext };
  }

  attachResponseMeta(response, apiKey, requestType = 'rotation', burstSize = 1, burstAttempts = 1) {
    if (!response) {
      return response;
    }

    const apiKeyMasked = this.maskApiKey(apiKey);
    const apiKeyId = crypto.createHash('sha256').update(String(apiKey || '')).digest('hex').slice(0, 12);
    response.meta = {
      ...(response.meta || {}),
      requestType,
      apiKeyMasked,
      apiKeyId,
      apiKeyLabel: `${apiKeyMasked} (${apiKeyId})`,
      burstSize,
      burstAttempts
    };

    return response;
  }

  shouldRetryWithTieredKeys(path, response) {
    const responseText = this.getResponseText(response?.data).toLowerCase();
    if (!responseText.includes('no longer available to new users')) {
      return false;
    }

    return this.isGeminiModelPath(path) || this.hasGeminiModelInBody(path);
  }

  upgradeGeminiModelRequest(path, body) {
    const upgradedPath = this.upgradeGeminiModelPath(path);
    const upgradedBody = this.upgradeGeminiModelBody(body);

    if (upgradedPath !== path || upgradedBody !== body) {
      console.warn(`[GEMINI] retrying with upgraded model route: ${upgradedPath}`);
    }

    return {
      path: upgradedPath,
      body: upgradedBody
    };
  }

  upgradeGeminiModelPath(path) {
    if (typeof path !== 'string') {
      return path;
    }

    const modelMap = [
      ['gemini-2.0-flash-lite', 'gemini-2.5-flash-lite'],
      ['gemini-2.0-flash', 'gemini-2.5-flash'],
      ['gemini-2.0-pro', 'gemini-2.5-pro'],
      ['gemini-2.0-pro-exp', 'gemini-2.5-pro'],
      ['gemini-1.5-flash', 'gemini-2.5-flash'],
      ['gemini-1.5-pro', 'gemini-2.5-pro']
    ];

    let nextPath = path;
    for (const [from, to] of modelMap) {
      nextPath = nextPath.replace(new RegExp(from.replace(/\./g, '\\.'), 'g'), to);
    }

    return nextPath;
  }

  upgradeGeminiModelBody(body) {
    const parsedBody = this.tryParseBody(body);
    if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
      return body;
    }

    const nextBody = { ...parsedBody };
    let changed = false;

    if (typeof nextBody.model === 'string') {
      const upgradedModel = this.upgradeGeminiModelPath(nextBody.model);
      if (upgradedModel !== nextBody.model) {
        nextBody.model = upgradedModel;
        changed = true;
      }
    }

    if (!changed) {
      return body;
    }

    return typeof body === 'string' ? JSON.stringify(nextBody) : nextBody;
  }

  hasGeminiModelInBody(path) {
    if (typeof path !== 'string') {
      return false;
    }

    return /\/models\/[^/:]+:/.test(path);
  }

  getResponseText(data) {
    if (!data) {
      return '';
    }

    if (Buffer.isBuffer(data)) {
      return data.toString('utf8');
    }

    return String(data);
  }

  isGeminiModelPath(path, modelNames = []) {
    if (typeof path !== 'string') {
      return false;
    }

    if (modelNames.length === 0) {
      return /\/models\/[^/:]+:/.test(path);
    }

    return modelNames.some((modelName) => path.includes(`/models/${modelName}`) || path.includes(`/${modelName}:`));
  }

  sendRequest(method, path, body, headers, apiKey, useHeader = false, signal = null) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const normalizedBody = this.normalizeRequestBodyForProvider(path, body);

      // Construct full URL with smart version handling
      let fullUrl = this.baseUrl;
      if (!path || path === '/') {
        fullUrl = this.baseUrl;
      } else if (path.startsWith('/')) {
        // Handle version replacement if needed
        let effectiveBaseUrl = this.baseUrl;

        // Extract version from path (anything that looks like /vXXX/)
        const pathVersionMatch = path.match(/^\/v[^\/]+\//);
        // Extract version from base URL (anything that ends with /vXXX)
        const baseVersionMatch = this.baseUrl.match(/\/v[^\/]+$/);

        if (pathVersionMatch && baseVersionMatch) {
          const pathVersion = pathVersionMatch[0].slice(0, -1); // Remove trailing /
          const baseVersion = baseVersionMatch[0];

          // If versions are different, replace base URL version with path version
          if (pathVersion !== baseVersion) {
            effectiveBaseUrl = this.baseUrl.replace(baseVersion, pathVersion);
            // Remove the version from path since it's now in the base URL
            path = path.substring(pathVersion.length);
          }
        }

        fullUrl = effectiveBaseUrl.endsWith('/') ? effectiveBaseUrl + path.substring(1) : effectiveBaseUrl + path;
      } else {
        fullUrl = this.baseUrl.endsWith('/') ? this.baseUrl + path : this.baseUrl + '/' + path;
      }

      const url = new URL(fullUrl);

      // Set up headers
      const finalHeaders = this.buildGeminiHeaders(headers);

      // Add API key either as header or URL parameter
      if (useHeader) {
        // Use x-goog-api-key header (official Gemini way)
        finalHeaders['x-goog-api-key'] = apiKey;
      } else {
        // Use URL parameter for backward compatibility
        url.searchParams.append('key', apiKey);
      }

      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: method,
        headers: finalHeaders,
        signal: signal
      };

      if (normalizedBody && method !== 'GET') {
        const bodyData = typeof normalizedBody === 'string' ? normalizedBody : JSON.stringify(normalizedBody);
        options.headers['Content-Length'] = Buffer.byteLength(bodyData);
      }

      const req = https.request(options, (res) => {
        const chunks = [];

        res.on('data', (chunk) => {
          chunks.push(chunk);
        });

        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            data: Buffer.concat(chunks)
          });
        });
      });

      const timeoutId = Number.isFinite(this.requestTimeoutMs) && this.requestTimeoutMs > 0
        ? setTimeout(() => {
            if (settled) {
              return;
            }
            settled = true;
            const timeoutError = new Error(`Request timed out after ${this.requestTimeoutMs}ms`);
            timeoutError.name = 'TimeoutError';
            reject(timeoutError);
            req.destroy(timeoutError);
          }, this.requestTimeoutMs)
        : null;

      req.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        const maskedKey = this.maskApiKey(apiKey);
        console.error(`[GEMINI::${maskedKey}] http ${error.message}`);
        reject(error);
      });

      if (signal) {
        signal.addEventListener('abort', () => clearTimeout(timeoutId), { once: true });
      }

      if (normalizedBody && method !== 'GET') {
        const bodyData = typeof normalizedBody === 'string' ? normalizedBody : JSON.stringify(normalizedBody);
        req.write(bodyData);
      }

      req.end();
    });
  }

  normalizeRequestBodyForProvider(path, body) {
    if (!body || typeof path !== 'string') {
      return body;
    }

    if (!this.shouldNormalizeGeminiPayload(path)) {
      return body;
    }

    const parsedBody = this.tryParseBody(body);
    if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
      return body;
    }

    const normalizedBody = { ...parsedBody };
    let wasChanged = false;

    if (Object.prototype.hasOwnProperty.call(normalizedBody, 'systemInstruction') && !Object.prototype.hasOwnProperty.call(normalizedBody, 'system_instruction')) {
      normalizedBody.system_instruction = normalizedBody.systemInstruction;
      delete normalizedBody.systemInstruction;
      wasChanged = true;
    }

    if (Object.prototype.hasOwnProperty.call(normalizedBody, 'cachedContent') && !Object.prototype.hasOwnProperty.call(normalizedBody, 'cached_content')) {
      normalizedBody.cached_content = normalizedBody.cachedContent;
      delete normalizedBody.cachedContent;
      wasChanged = true;
    }

    if (!wasChanged) {
      return body;
    }

    return typeof body === 'string' ? JSON.stringify(normalizedBody) : normalizedBody;
  }

  shouldNormalizeGeminiPayload(path) {
    const isGenerateContentPath = path.includes(':generateContent') || path.includes(':streamGenerateContent');
    if (!isGenerateContentPath) {
      return false;
    }

    return this.baseUrl.includes('generativelanguage.googleapis.com');
  }

  buildGeminiHeaders(headers) {
    const finalHeaders = this.sanitizeGeminiHeaders(headers);

    if (!finalHeaders['content-type']) {
      finalHeaders['content-type'] = 'application/json';
    }

    if (!finalHeaders['user-agent']) {
      finalHeaders['user-agent'] = this.getRandomBrowserUserAgent();
    }

    return finalHeaders;
  }

  sanitizeGeminiHeaders(headers) {
    const allowedHeaders = new Set([
      'content-type',
      'accept',
      'x-goog-api-client',
      'x-goog-user-project'
    ]);
    const sanitizedHeaders = {};

    for (const [key, value] of Object.entries(headers || {})) {
      const normalizedKey = key.toLowerCase();
      if (!allowedHeaders.has(normalizedKey)) {
        continue;
      }

      const normalizedValue = this.normalizeHeaderValue(value);
      if (normalizedValue !== null) {
        sanitizedHeaders[normalizedKey] = normalizedValue;
      }
    }

    return sanitizedHeaders;
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

  getRandomBrowserUserAgent() {
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:138.0) Gecko/20100101 Firefox/138.0',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 Edg/137.0.0.0'
    ];

    const index = crypto.randomInt(0, userAgents.length);
    return userAgents[index];
  }

  tryParseBody(body) {
    if (!body) {
      return null;
    }

    if (typeof body === 'object') {
      return body;
    }

    if (typeof body !== 'string') {
      return null;
    }

    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }

  maskApiKey(key) {
    if (!key || key.length < 8) return '***';
    return key.substring(0, 4) + '...' + key.substring(key.length - 4);
  }
}

export default GeminiClient;
