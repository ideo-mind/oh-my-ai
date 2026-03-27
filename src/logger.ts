const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[90m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m'
};

const FORMATTER_STATE_KEY = Symbol.for('aikey.console_formatter_installed');

function padTime(value: number) {
  return String(value).padStart(2, '0');
}

function formatTimestamp() {
  const now = new Date();
  return `${padTime(now.getHours())}:${padTime(now.getMinutes())}:${padTime(now.getSeconds())}`;
}

function shouldUseColor() {
  return Boolean(process.stdout?.isTTY) && !process.env.NO_COLOR;
}

function formatPrefix(label: string, color: string) {
  const timestamp = formatTimestamp();
  if (!shouldUseColor()) {
    return `${timestamp} ${label}`;
  }

  return `${COLORS.dim}${timestamp}${COLORS.reset} ${color}${label}${COLORS.reset}`;
}

function wrapConsoleMethod(method: 'log' | 'warn' | 'error', label: string, color: string) {
  const original = console[method].bind(console);

  console[method] = (...args: unknown[]) => {
    original(formatPrefix(label, color), ...args);
  };
}

export function installConsoleFormatting() {
  const state = globalThis as Record<PropertyKey, unknown>;
  if (state[FORMATTER_STATE_KEY]) {
    return;
  }

  state[FORMATTER_STATE_KEY] = true;

  wrapConsoleMethod('log', 'INF', COLORS.cyan);
  wrapConsoleMethod('warn', 'WRN', COLORS.yellow);
  wrapConsoleMethod('error', 'ERR', COLORS.red);
}
