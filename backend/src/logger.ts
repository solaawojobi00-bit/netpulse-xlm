export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface LogContext {
  component?: string;
  network?: string;
  err?: unknown;
  [key: string]: unknown;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50,
};

function getEffectiveLogLevel(): LogLevel {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase() as LogLevel | undefined;
  if (envLevel && envLevel in LEVEL_PRIORITY) {
    return envLevel;
  }
  if (process.env.NODE_ENV === "test") {
    return "silent";
  }
  return "info";
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ? `\n${err.stack}` : `\n${err.name}: ${err.message}`;
  }
  if (err === undefined || err === null) {
    return "";
  }
  /*
   * `String(err)` alone is wrong for the case that matters most here. Rejected
   * values are not always Errors -- a `fetch` layer or a driver can reject with
   * a plain object -- and stringifying one yields the literal "[object Object]",
   * which throws away the only diagnostic the log line was carrying.
   *
   * So: switch on the type and give each family a representation that survives
   * the trip to a log line.
   */
  switch (typeof err) {
    case "object":
      try {
        return `\n${JSON.stringify(err)}`;
      } catch {
        // JSON refuses circular references and BigInt values. A tag beats
        // throwing from inside the logger.
        return `\n${Object.prototype.toString.call(err)}`;
      }
    case "function":
      return `\n[Function: ${err.name || "anonymous"}]`;
    case "symbol":
      return `\n${err.toString()}`;
    case "string":
      return `\n${err}`;
    /*
     * Spelled out rather than folded into `default`. TypeScript narrows `err`
     * in each `case` of a `typeof` switch but leaves it `unknown` in the
     * default branch, so `String(err)` there is exactly the unchecked
     * stringification this function exists to avoid.
     */
    case "number":
    case "boolean":
    case "bigint":
      return `\n${String(err)}`;
    default:
      return `\n${Object.prototype.toString.call(err)}`;
  }
}

function output(level: "debug" | "info" | "warn" | "error", message: string, context?: LogContext): void {
  const currentLevel = getEffectiveLogLevel();
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[currentLevel]) {
    return;
  }

  const timestamp = new Date().toISOString();
  const component = context?.component ? `[${context.component}]` : "[app]";
  const network = context?.network ? `[${context.network}]` : "";
  const prefix = `${timestamp} [${level.toUpperCase()}] ${component}${network}`;

  // Extract extra fields excluding component, network, err
  const extraFields: Record<string, unknown> = {};
  if (context) {
    for (const [key, value] of Object.entries(context)) {
      if (key !== "component" && key !== "network" && key !== "err") {
        extraFields[key] = value;
      }
    }
  }

  const extraStr = Object.keys(extraFields).length > 0 ? ` ${JSON.stringify(extraFields)}` : "";
  const errStr = formatError(context?.err);
  const line = `${prefix} ${message}${extraStr}${errStr}`;

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug(message: string, context?: LogContext): void {
    output("debug", message, context);
  },
  info(message: string, context?: LogContext): void {
    output("info", message, context);
  },
  warn(message: string, context?: LogContext): void {
    output("warn", message, context);
  },
  error(message: string, context?: LogContext): void {
    output("error", message, context);
  },
};
