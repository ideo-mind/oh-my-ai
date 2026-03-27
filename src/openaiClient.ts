import * as https from 'node:https';
import * as crypto from 'node:crypto';
import { URL } from 'node:url';

export class OpenAIClient {
  constructor(keyRotator, baseUrl = 'https://api.openai.com') {
    this.keyRotator = keyRotator;
    this.baseUrl = baseUrl;
  }

  async makeRequest(method, path, body, headers = {}, customStatusCodes = null) {
    // Create a new request context for this specific request
    const requestContext = this.keyRotator.createRequestContext();
    let lastError = null;
    let lastResponse = null;

    // Determine which status codes should trigger rotation
    // Default is just 429, but can be overridden
    const rotationStatusCodes = customStatusCodes || new Set([429]);

    // Try each available key for this request
    let apiKey;
    while ((apiKey = requestContext.getNextKey()) !== null) {
      const maskedKey = this.maskApiKey(apiKey);

      console.log(`[OPENAI::${maskedKey}] try ${method} ${path}`);

      try {
        const response = await this.sendRequest(method, path, body, headers, apiKey);

        // Check if this status code should trigger rotation
        if (rotationStatusCodes.has(response.statusCode)) {
          requestContext.markKeyAsRateLimited(apiKey, response.statusCode);
          lastResponse = response; // Keep the response in case all keys fail
          continue;
        }

        console.log(`[OPENAI::${maskedKey}] ok ${response.statusCode}`);
        return this.attachResponseMeta(response, apiKey, 'rotation');
      } catch (error) {
        console.error(`[OPENAI::${maskedKey}] fail ${error.message}`);
        lastError = error;
        // For network errors, we still try the next key
        continue;
      }
    }

    // Update the KeyRotator with the last failed key from this request
    const lastFailedKey = requestContext.getLastFailedKey();
    this.keyRotator.updateLastFailedKey(lastFailedKey);

    // If all tried keys were rate limited, return 429
    if (requestContext.allTriedKeysRateLimited()) {
      console.warn('[OPENAI] 429 exhausted');
      return this.attachResponseMeta(lastResponse || {
        statusCode: 429,
        headers: { 'content-type': 'application/json' },
        data: JSON.stringify({
          error: {
            message: 'All OpenAI API keys returned 429',
            type: 'rate_limit_exceeded',
            code: 'rate_limit_exceeded'
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

  sendRequest(method, path, body, headers, apiKey) {
    return new Promise((resolve, reject) => {
      // Construct full URL - handle cases where path might be empty or just "/"
      let fullUrl;
      if (!path || path === '/') {
        fullUrl = this.baseUrl;
      } else if (path.startsWith('/')) {
        fullUrl = this.baseUrl.endsWith('/') ? this.baseUrl + path.substring(1) : this.baseUrl + path;
      } else {
        fullUrl = this.baseUrl.endsWith('/') ? this.baseUrl + path : this.baseUrl + '/' + path;
      }

      const url = new URL(fullUrl);

      // Build headers, ensuring Authorization header is properly set
      const finalHeaders = {
        'Content-Type': 'application/json',
        ...headers
      };

      // Only set Authorization if not already provided in headers
      if (!headers || !headers.authorization) {
        finalHeaders['Authorization'] = `Bearer ${apiKey}`;
      }

      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: method,
        headers: finalHeaders
      };

      if (body && method !== 'GET') {
        const bodyData = typeof body === 'string' ? body : JSON.stringify(body);
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
        console.error(`[OPENAI::${maskedKey}] http ${error.message}`);
        reject(error);
      });

      if (body && method !== 'GET') {
        const bodyData = typeof body === 'string' ? body : JSON.stringify(body);
        req.write(bodyData);
      }

      req.end();
    });
  }

  maskApiKey(key) {
    if (!key || key.length < 8) return '***';
    return key.substring(0, 4) + '...' + key.substring(key.length - 4);
  }
}

export default OpenAIClient;
