# oh-my-ai

Node.js proxy server for automatic API key rotation across multiple LLM providers (OpenAI, Gemini, Groq, OpenRouter, etc.). ***Zero external dependencies***.

## Features

- **Automatic Key Rotation**: Rotates keys on configurable status codes (default: 429)
- **Universal API Compatibility**: Works with any OpenAI or Gemini-compatible API
- **Smart Key Shuffling**: Avoids recently failed keys using intelligent rotation
- **Live Key Validation**: API keys automatically tested before saving
- **Hot Configuration**: Add, edit, rename, or delete providers without restart
- **Custom Status Codes**: Configure which HTTP codes trigger rotation per request
- **Optional Access Control**: Secure providers with access keys requiring authorization
- **Default Models**: Pre-save models for easy curl command generation
- **Modern Admin Panel**: Dark/light theme support for comfortable management
- **Request Monitoring**: Last 100 requests logged in memory with details

## Quick Start

```bash
git clone https://github.com/ideo-mind/oh-my-ai.git
cd oh-my-ai
# Edit config.toml and set server.adminPassword
# Optional: export PORT to override the configured/default port
# Install Bun and run
bun start
```

Access admin panel: `http://localhost:8990/admin`

## Configuration

```toml
[server]
adminPassword = "your-secure-password"

[provider.openai]
apiType = "openai"
apiKeys = ["sk-your-key"]
baseUrl = "https://api.openai.com/v1"
```

`PORT` remains optional as an environment variable override. If unset, the app uses `server.port` from `config.toml`, then falls back to `8990`.

Visit http://localhost:8990/admin to configure your providers and start using the API.

## API Usage Examples

### OpenAI-Compatible APIs
```bash
curl -X POST "http://localhost:8990/groq/chat/completions" \
  -H "Authorization: Bearer [STATUS_CODES:429][ACCESS_KEY:your-access-key]" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-oss-120b",
    "messages": [
      {
        "role": "user",
        "content": "Hello! Please say hello back."
      }
    ]
  }'
```

### Gemini-Compatible APIs
```bash
curl -X POST "http://localhost:8990/gemini/models/gemini-2.5-flash:generateContent" \
  -H "x-goog-api-key: [STATUS_CODES:429][ACCESS_KEY:your-access-key]" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [
      {
        "parts": [
          {
            "text": "Hello! Please say hello back."
          }
        ]
      }
    ]
  }'
```

**Note**: Replace `your-access-key` with your provider's ACCESS_KEY if configured. If no ACCESS_KEY is set for the provider, you can omit the `[ACCESS_KEY:...]` parameter entirely.


### Screenshot

<img width="3024" height="1714" alt="Image" src="https://github.com/user-attachments/assets/f265cc8f-941e-43e4-998e-c713dacfd248" />

<img width="3024" height="3652" alt="Image" src="https://github.com/user-attachments/assets/21bd17c3-763c-482a-97c0-115d8b395d65" />

<img width="3024" height="1714" alt="Image" src="https://github.com/user-attachments/assets/0de6654d-eea8-49ad-9c19-7f2a799b604e" />

## Contributing

Contributions are warmly welcomed and greatly appreciated! Whether it's a bug fix, new feature, or improvement, your input helps make this project better for everyone.

**Before submitting a pull request**, please:
1. Create an issue describing the feature or bug fix you'd like to work on
2. Wait for discussion and approval to ensure alignment with project goals
3. Fork the repository and create your feature branch
4. Submit your pull request with a clear description of changes

This approach helps avoid duplicate efforts and ensures smooth collaboration. Thank you for considering contributing!

## License

This project is licensed under GNU GPL v3.0 (or later) - see the [LICENSE](LICENSE) file for details.
