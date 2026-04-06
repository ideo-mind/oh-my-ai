export class KeyRotator {
  constructor(apiKeys, apiType = 'unknown', apiKeysDetailed = []) {
    this.apiType = apiType;
    this.apiKeyDetails = this.normalizeApiKeyDetails(apiKeysDetailed, apiKeys);
    this.apiKeys = this.apiKeyDetails
      .filter((key) => key.active !== false)
      .map((key) => key.value);
    this.lastFailedKey = null; // Track the key that failed in the last request
    console.log(`[${apiType.toUpperCase()}-ROTATOR] init keys=${this.apiKeys.length}`);
  }

  /**
   * Creates a new request context for per-request key rotation with smart shuffling
   * @returns {RequestKeyContext} A new context for managing keys for a single request
   */
  createRequestContext(options = {}) {
    const eligibleKeys = this.selectKeysForRequest(options);
    return new RequestKeyContext(eligibleKeys, this.apiType, this.lastFailedKey, options);
  }

  /**
   * Updates the last failed key from the completed request
   * @param {string|null} failedKey The key that failed in the last request, or null if no key failed
   */
  updateLastFailedKey(failedKey) {
    this.lastFailedKey = failedKey;
    if (failedKey) {
      const maskedKey = this.maskApiKey(failedKey);
      console.log(`[${this.apiType.toUpperCase()}-ROTATOR] last=${maskedKey}`);
    }
  }

  getTotalKeysCount() {
    return this.apiKeys.length;
  }

  normalizeApiKeyDetails(apiKeysDetailed, fallbackKeys) {
    const detailed = Array.isArray(apiKeysDetailed)
      ? apiKeysDetailed
          .filter((key) => typeof key?.value === 'string' && key.value.trim().length > 0)
          .map((key) => ({
            value: key.value.trim(),
            label: key.label?.trim() || null,
            tier: key.tier?.trim() || null,
            active: key.active !== false
          }))
      : [];

    if (detailed.length > 0) {
      return detailed;
    }

    return (Array.isArray(fallbackKeys) ? fallbackKeys : [])
      .filter((key) => typeof key === 'string' && key.trim().length > 0)
      .map((key) => ({
        value: key.trim(),
        label: null,
        tier: null,
        active: true
      }));
  }

  selectKeysForRequest(options = {}) {
    const activeKeys = this.apiKeyDetails
      .filter((key) => key.active !== false)
      .map((key) => key.value);

    const minTier = this.normalizeTier(options.minTier);
    if (minTier === null) {
      return activeKeys;
    }

    const tieredKeys = this.apiKeyDetails.filter((key) => {
      if (key.active === false) {
        return false;
      }

      const tier = this.normalizeTier(key.tier);
      return tier !== null && tier >= minTier;
    }).map((key) => key.value);

    return tieredKeys.length > 0 ? tieredKeys : activeKeys;
  }

  normalizeTier(tier) {
    if (tier === undefined || tier === null || tier === '') {
      return null;
    }

    const parsed = Number(tier);
    return Number.isFinite(parsed) ? parsed : null;
  }

  maskApiKey(key) {
    if (!key || key.length < 8) return '***';
    return key.substring(0, 4) + '...' + key.substring(key.length - 4);
  }
}

/**
 * Manages API key rotation for a single request
 * Each request gets its own context to try all available keys with smart shuffling
 */
class RequestKeyContext {
  constructor(apiKeys, apiType, lastFailedKey = null, options = {}) {
    this.originalApiKeys = [...apiKeys];
    this.apiType = apiType;
    this.currentIndex = 0;
    this.triedKeys = new Set();
    this.rateLimitedKeys = new Set();
    this.lastFailedKeyForThisRequest = null;
    this.minTier = options.minTier ?? null;
    
    // Apply smart shuffling: shuffle keys but move last failed key to end
    this.apiKeys = this.smartShuffle(apiKeys, lastFailedKey);
    
    if (lastFailedKey) {
      const maskedKey = this.maskApiKey(lastFailedKey);
      console.log(`[${this.apiType.toUpperCase()}] shuffle tail=${maskedKey}`);
    }
  }
  
  /**
   * Smart shuffle: randomize key order but move last failed key to the end
   * @param {Array} keys Array of API keys
   * @param {string|null} lastFailedKey The key that failed in the previous request
   * @returns {Array} Shuffled array with last failed key at the end
   */
  smartShuffle(keys, lastFailedKey) {
    const shuffled = [...keys];
    
    // Fisher-Yates shuffle algorithm
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    
    // If we have a last failed key, move it to the end
    if (lastFailedKey && keys.includes(lastFailedKey)) {
      const failedKeyIndex = shuffled.indexOf(lastFailedKey);
      if (failedKeyIndex !== -1) {
        // Remove the failed key from its current position
        shuffled.splice(failedKeyIndex, 1);
        // Add it to the end
        shuffled.push(lastFailedKey);
      }
    }
    
    return shuffled;
  }

  /**
   * Gets the next available key to try for this request
   * @returns {string|null} The next API key to try, or null if all keys have been tried
   */
  getNextKey() {
    // If we've tried all keys, return null
    if (this.triedKeys.size >= this.apiKeys.length) {
      return null;
    }

    // Find the next untried key
    let attempts = 0;
    while (attempts < this.apiKeys.length) {
      const key = this.apiKeys[this.currentIndex];
      
      if (!this.triedKeys.has(key)) {
        this.triedKeys.add(key);
        const maskedKey = this.maskApiKey(key);
        console.log(`[${this.apiType.toUpperCase()}::${maskedKey}] try ${this.triedKeys.size}/${this.apiKeys.length}`);
        return key;
      }
      
      this.currentIndex = (this.currentIndex + 1) % this.apiKeys.length;
      attempts++;
    }
    
    return null;
  }

  /**
   * Gets a batch of available keys to try for this request
   * @param {number} size The maximum number of keys to return
   * @returns {string[]} An array of API keys, up to size
   */
  getNextBatch(size) {
    const batch = [];
    for (let i = 0; i < size; i++) {
      const key = this.getNextKey();
      if (!key) break;
      batch.push(key);
    }
    return batch;
  }

  /**
   * Marks the current key as rate limited for this request
   * @param {string} key The API key that was rate limited
   */
  markKeyAsRateLimited(key, statusCode = 429) {
    this.rateLimitedKeys.add(key);
    this.lastFailedKeyForThisRequest = key; // Track the most recent failed key
    const maskedKey = this.maskApiKey(key);
    console.warn(`[${this.apiType.toUpperCase()}::${maskedKey}] ${statusCode} ${this.rateLimitedKeys.size}/${this.triedKeys.size}`);
    
    // Move to next key for the next attempt
    this.currentIndex = (this.currentIndex + 1) % this.apiKeys.length;
  }

  /**
   * Marks the current key as the latest failure for this request.
   * This is used for terminal errors where we still want to remember the last key.
   * @param {string} key The API key that failed
   */
  markKeyAsFailed(key) {
    this.lastFailedKeyForThisRequest = key;
  }

  /**
   * Gets the key that failed most recently in this request (for updating global state)
   * @returns {string|null} The last key that was rate limited in this request
   */
  getLastFailedKey() {
    return this.lastFailedKeyForThisRequest;
  }

  /**
   * Checks if all tried keys were rate limited
   * @returns {boolean} True if all keys that were tried returned 429
   */
  allTriedKeysRateLimited() {
    return this.triedKeys.size > 0 && this.rateLimitedKeys.size === this.triedKeys.size;
  }

  /**
   * Checks if all available keys have been tried
   * @returns {boolean} True if all keys have been attempted
   */
  allKeysTried() {
    return this.triedKeys.size >= this.apiKeys.length;
  }

  /**
   * Gets statistics about this request's key usage
   * @returns {object} Statistics object
   */
  getStats() {
    return {
      totalKeys: this.apiKeys.length,
      triedKeys: this.triedKeys.size,
      rateLimitedKeys: this.rateLimitedKeys.size,
      hasUntriedKeys: this.triedKeys.size < this.apiKeys.length
    };
  }

  maskApiKey(key) {
    if (!key || key.length < 8) return '***';
    return key.substring(0, 4) + '...' + key.substring(key.length - 4);
  }
}

export default KeyRotator;
