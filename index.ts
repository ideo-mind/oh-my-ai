import { Config } from './src/config';
import { KeyRotator } from './src/keyRotator';
import { GeminiClient } from './src/geminiClient';
import { OpenAIClient } from './src/openaiClient';
import { installConsoleFormatting } from './src/logger';
import { ProxyServer } from './src/server';

function main() {
  try {
    installConsoleFormatting();
    const config = new Config();

    const server = new ProxyServer(config);
    server.start();
    
    process.on('SIGINT', () => {
      console.log('Shutting down');
      server.stop();
      process.exit(0);
    });
    
  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
}

const isEntryPoint =
  import.meta.main ||
  (typeof Bun !== 'undefined' &&
    typeof Bun.main === 'string' &&
    (import.meta.url === Bun.main || import.meta.url === `file:///${Bun.main.replaceAll('\\', '/')}`));

if (isEntryPoint) {
  main();
}

export { Config, KeyRotator, GeminiClient, OpenAIClient, ProxyServer };
export default { Config, KeyRotator, GeminiClient, OpenAIClient, ProxyServer };
