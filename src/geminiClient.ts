import * as https from 'node:https';
import * as crypto from 'node:crypto';
import { URL } from 'node:url';

export class GeminiClient {
  constructor(keyRotator, baseUrl = 'https://generativelanguage.googleapis.com', burstSize = 1) {
    this.keyRotator = keyRotator;
    this.baseUrl = baseUrl;
    this.burstSize = burstSize;
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
        return this.attachResponseMeta(response, providedApiKey, 'provided');
      } catch (error) {
        console.error(`[GEMINI::${maskedKey}] fail ${error.message}`);
        throw error;
      }
    }

    // No API key provided, use rotation system
    // Create a new request context for this specific request
    const requestContext = this.keyRotator.createRequestContext();
    let lastError = null;
    let lastResponse = null;

    // Determine which status codes should trigger rotation
    // Default is just 429, but can be overridden
    const rotationStatusCodes = customStatusCodes || new Set([429]);

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

          return { type: 'hard_error', response, apiKey };
        } catch (error) {
          if (error.name === 'AbortError') {
            return { type: 'aborted' };
          }
          console.error(`[GEMINI::${maskedKey}] fail ${error.message}`);
          return { type: 'error', error, apiKey };
        }
      }));

      const successResult = results.find(r => r.status === 'fulfilled' && r.value.type === 'success');
      if (successResult) {
        const { response, apiKey } = successResult.value;
        const maskedKey = this.maskApiKey(apiKey);
        console.log(`[GEMINI::${maskedKey}] ok ${response.statusCode}`);
        return this.attachResponseMeta(response, apiKey, 'rotation');
      }

      const hardErrorResult = results.find(r => r.status === 'fulfilled' && r.value.type === 'hard_error');
      if (hardErrorResult) {
        const { response, apiKey } = hardErrorResult.value;
        const maskedKey = this.maskApiKey(apiKey);
        console.log(`[GEMINI::${maskedKey}] fail ${response.statusCode} (terminal)`);
        return this.attachResponseMeta(response, apiKey, 'rotation');
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

    // Update the KeyRotator with the last failed key from this request
    const lastFailedKey = requestContext.getLastFailedKey();
    this.keyRotator.updateLastFailedKey(lastFailedKey);

    // If all tried keys were rate limited, return 429
    if (requestContext.allTriedKeysRateLimited()) {
      console.warn('[GEMINI] 429 exhausted');
      return this.attachResponseMeta(lastResponse || {
        statusCode: 429,
        headers: { 'content-type': 'application/json' },
        data: JSON.stringify({
          error: {
            code: 429,
            message: 'All API keys returned 429',
            status: 'RESOURCE_EXHAUSTED'
          }
        })
      }, requestContext.getLastFailedKey(), 'rotation');
    }

    // If we had other types of errors, throw the last one
    if (lastError) {
      throw lastError;
    }

    // Fallback error
    throw new Error('All API keys exhausted without clear error');
  }

  attachResponseMeta(response, apiKey, requestType = 'rotation') {
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
      apiKeyLabel: `${apiKeyMasked} (${apiKeyId})`
    };

    return response;
  }

  sendRequest(method, path, body, headers, apiKey, useHeader = false, signal = null) {
    return new Promise((resolve, reject) => {
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
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            data: Buffer.concat(chunks)
          });
        });
      });

      req.on('error', (error) => {
        const maskedKey = this.maskApiKey(apiKey);
        console.error(`[GEMINI::${maskedKey}] http ${error.message}`);
        reject(error);
      });

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

    return finalHeaders;
  }

  sanitizeGeminiHeaders(headers) {
    const allowedHeaders = new Set([
      'content-type',
      'accept',
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
