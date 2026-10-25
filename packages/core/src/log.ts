export interface Logger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(bindings: Record<string, unknown> = {}, level = 'info'): Logger {
  const rank: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  const threshold = rank[level] ?? 20;
  const write = (name: 'info' | 'warn' | 'error', obj: Record<string, unknown>, msg?: string) => {
    if ((rank[name] ?? 20) < threshold) return;
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level: name,
      msg: msg ?? name,
      ...bindings,
      ...obj,
    });
    const stream = name === 'error' ? process.stderr : process.stdout;
    stream.write(`${line}\n`);
  };
  return {
    info: (obj, msg) => write('info', obj, msg),
    warn: (obj, msg) => write('warn', obj, msg),
    error: (obj, msg) => write('error', obj, msg),
    child: (extra) => createLogger({ ...bindings, ...extra }, level),
  };
}

export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};
