import * as https from 'node:https';
import * as crypto from 'node:crypto';
import { URL } from 'node:url';

export class OpenAIClient {
  constructor(keyRotator, baseUrl = 'https://api.openai.com', burstSize = 1, requestTimeoutMs = 120000) {
    this.keyRotator = keyRotator;
    this.baseUrl = baseUrl;
    this.burstSize = burstSize;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async makeRequest(method, path, body, headers = {}, customStatusCodes = null) {
    const requestContext = this.keyRotator.createRequestContext();
    let lastError = null;
    let lastResponse = null;
    const rotationStatusCodes = customStatusCodes || new Set([429]);

    while (true) {
      const batch = requestContext.getNextBatch(this.burstSize);
      if (batch.length === 0) {
        break;
      }

      const abortController = new AbortController();

      const results = await Promise.allSettled(batch.map(async (apiKey) => {
        const maskedKey = this.maskApiKey(apiKey);
        console.log(`[OPENAI::${maskedKey}] try ${method} ${path}${batch.length > 1 ? ` (Burst: ${batch.length})` : ''}`);

        try {
          const response = await this.sendRequest(method, path, body, headers, apiKey, abortController.signal);

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
          console.error(`[OPENAI::${maskedKey}] fail ${error.message}`);
          return { type: 'error', error, apiKey };
        }
      }));

      const successResult = results.find(r => r.status === 'fulfilled' && r.value.type === 'success');
      if (successResult) {
        const { response, apiKey } = successResult.value;
        const maskedKey = this.maskApiKey(apiKey);
        console.log(`[OPENAI::${maskedKey}] ok ${response.statusCode}`);
        return this.attachResponseMeta(response, apiKey, 'rotation', this.burstSize, requestContext.triedKeys.size);
      }

      const hardErrorResult = results.find(r => r.status === 'fulfilled' && r.value.type === 'hard_error');
      if (hardErrorResult) {
        const { response, apiKey } = hardErrorResult.value;
        const maskedKey = this.maskApiKey(apiKey);
        console.log(`[OPENAI::${maskedKey}] fail ${response.statusCode} (terminal)`);
        return this.attachResponseMeta(response, apiKey, 'rotation', this.burstSize, requestContext.triedKeys.size);
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

    const lastFailedKey = requestContext.getLastFailedKey();
    this.keyRotator.updateLastFailedKey(lastFailedKey);

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
      }, requestContext.getLastFailedKey(), 'rotation', this.burstSize, requestContext.triedKeys.size);
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error('All API keys exhausted without clear error');
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

  sendRequest(method, path, body, headers, apiKey, signal = null) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let fullUrl = '';
      if (!path || path === '/') {
        fullUrl = this.baseUrl;
      } else if (path.startsWith('/')) {
        fullUrl = this.baseUrl.endsWith('/') ? this.baseUrl + path.substring(1) : this.baseUrl + path;
      } else {
        fullUrl = this.baseUrl.endsWith('/') ? this.baseUrl + path : this.baseUrl + '/' + path;
      }

      const url = new URL(fullUrl);

      const finalHeaders = {
        'Content-Type': 'application/json',
        ...headers
      };

      if (!headers || !headers.authorization) {
        finalHeaders['Authorization'] = `Bearer ${apiKey}`;
      }

      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: method,
        headers: finalHeaders,
        signal: signal
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
        console.error(`[OPENAI::${maskedKey}] http ${error.message}`);
        reject(error);
      });

      if (signal) {
        signal.addEventListener('abort', () => clearTimeout(timeoutId), { once: true });
      }

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
