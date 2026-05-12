export interface Logger {
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

const consoleLogger: Logger = {
  warn: (msg, ...args) => console.warn(msg, ...args),
  error: (msg, ...args) => console.error(msg, ...args),
  info: (msg, ...args) => console.info(msg, ...args),
  debug: () => {},
};

let currentLogger: Logger = consoleLogger;

export function setLogger(logger: Logger): void {
  currentLogger = logger;
}

export function getLogger(): Logger {
  return currentLogger;
}
