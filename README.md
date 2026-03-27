# oh-my-ai

`oh-my-ai` is a Bun-native proxy runner for OpenAI-compatible and Gemini-compatible APIs.

It gives you one local endpoint with automatic API key rotation, provider-level access control, and a web admin panel for live configuration updates.

## Why teams use it

- Automatic key rotation on retryable failures (default: `429`)
- Multi-provider support (OpenAI, Gemini, Groq, OpenRouter, custom-compatible backends)
- Bun-first runner experience with `bunx oh-my-ai`
- Live admin panel to manage providers, keys, models, and rotation behavior
- Optional per-provider access keys for controlled usage
- In-memory request metrics and key/provider health visibility

## Quick Start

### Option A: Run instantly (recommended)

```bash
bunx oh-my-ai
```

On first run, if `CONFIG_FILE` does not exist, `oh-my-ai` creates a default config automatically.

### Option B: Clone for local development

```bash
git clone https://github.com/ideo-mind/oh-my-ai.git
cd oh-my-ai
bun install
bun start
```

Open the admin panel at `http://localhost:8990/admin`.

## Runtime Model

- Runtime: **Bun** (`"engines": { "bun": ">=1.0.0" }`)
- Entrypoint: `bunx oh-my-ai`
- This project is a runner/server, not an SDK package.

## Configuration

By default, config is read from:

- `CONFIG_FILE` (if set)
- otherwise `./config.toml` in your current working directory

If the file is missing, a default config is created automatically.

### Default generated config

```toml
[server]
port = 8990
adminPassword = "admin"

provider = {}
```

### Recommended production baseline

```toml
[server]
port = 8990
adminPassword = "replace-this-with-a-strong-password"
# Optional
# logFilePath = "/var/log/oh-my-ai/proxy.log"

[provider.openai]
apiType = "openai"
apiKeys = ["sk-openai-key-1", "sk-openai-key-2"]
baseUrl = "https://api.openai.com/v1"
accessKey = "team-openai"
defaultModel = "gpt-4o-mini"
modelHistory = ["gpt-4o-mini", "gpt-4.1-mini"]
rotationStatusCodes = [429, 500, 502, 503]

[provider.gemini]
apiType = "gemini"
apiKeys = ["AIza...", "AIza..."]
baseUrl = "https://generativelanguage.googleapis.com/v1beta"
accessKey = "team-gemini"
defaultModel = "gemini-2.5-flash"
modelHistory = ["gemini-2.5-flash"]
rotationStatusCodes = [429, 500, 503]
```

### Provider fields

- `apiType`: `openai` or `gemini` (lowercase recommended)
- `apiKeys`: array of API keys
- `apiKeysDetailed`: optional detailed key objects (`value`, `label`, `tier`)
- `baseUrl`: optional override (defaults are inferred by `apiType`)
- `accessKey`: optional per-provider gate key
- `defaultModel`: optional default model
- `modelHistory`: optional model history list
- `rotationStatusCodes`: optional HTTP codes that trigger key rotation

## Environment Variables

- `CONFIG_FILE`: absolute or relative path to config file
- `PORT`: runtime override for server port
- `ADMIN_PASSWORD`: fallback only when config has no `server.adminPassword`

Port resolution order:

1. `PORT`
2. `server.port` from config
3. default `8990`

## Request Usage

### OpenAI-compatible example

```bash
curl -X POST "http://localhost:8990/groq/chat/completions" \
  -H "Authorization: Bearer [STATUS_CODES:429][ACCESS_KEY:team-openai]" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-oss-120b",
    "messages": [
      {"role": "user", "content": "Say hello."}
    ]
  }'
```

### Gemini-compatible example

```bash
curl -X POST "http://localhost:8990/gemini/models/gemini-2.5-flash:generateContent" \
  -H "x-goog-api-key: [STATUS_CODES:429][ACCESS_KEY:team-gemini]" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [
      {"parts": [{"text": "Say hello."}]}
    ]
  }'
```

If `accessKey` is not configured for a provider, omit `[ACCESS_KEY:...]`.

## Security Notes

- Change the default `adminPassword` before exposing the service.
- Keep `CONFIG_FILE` outside shared/public paths.
- Prefer unique `accessKey` values per provider in shared environments.

## Releases

This repo uses Changesets.

- Create a changeset: `bun run changeset`
- Version locally: `bun run version-packages`
- Publish via workflow: push a tag like `v1.0.2`

`CHANGELOG.md` is generated from changesets during versioning.

## Contributing

Contributions are welcome.

1. Open an issue describing the bug/feature.
2. Wait for alignment.
3. Submit a focused PR with clear rationale.

## License

GNU GPL v3.0 or later. See `LICENSE`.
