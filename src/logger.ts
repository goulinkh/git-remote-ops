export type LogLevel = "silent" | "info" | "debug" | "trace";

const LEVEL_RANK: Record<LogLevel, number> = {
  silent: 0,
  info: 1,
  debug: 2,
  trace: 3,
};

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

const LEVEL_COLOR: Record<Exclude<LogLevel, "silent">, string> = {
  info: ANSI.cyan,
  debug: ANSI.blue,
  trace: ANSI.gray,
};

export interface LoggerOptions {
  level?: LogLevel;
  sink?: (line: string) => void;
  collectMetrics?: boolean;
  color?: boolean; // default: auto-detect stderr TTY
  timestamps?: boolean; // default: true
}

export interface Metrics {
  httpRequests: number;
  httpBytesIn: number;
  httpBytesOut: number;
  httpDurationMs: number;
  packObjects: number;
  packBytes: number;
  packParseMs: number;
  byType: Record<"commit" | "tree" | "blob" | "tag", number>;
}

function emptyMetrics(): Metrics {
  return {
    httpRequests: 0,
    httpBytesIn: 0,
    httpBytesOut: 0,
    httpDurationMs: 0,
    packObjects: 0,
    packBytes: 0,
    packParseMs: 0,
    byType: { commit: 0, tree: 0, blob: 0, tag: 0 },
  };
}

function detectColor(): boolean {
  try {
    if (Deno.env.get("NO_COLOR")) return false;
    return Deno.stderr.isTerminal();
  } catch {
    return false;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const min = Math.floor(ms / 60_000);
  const s = ((ms % 60_000) / 1000).toFixed(1);
  return `${min}m${s}s`;
}

export class Logger {
  readonly level: LogLevel;
  readonly metrics: Metrics;
  private sink: (line: string) => void;
  private namespace: string;
  private collect: boolean;
  private color: boolean;
  private timestamps: boolean;
  private epoch: number;

  constructor(options: LoggerOptions = {}, namespace = "") {
    this.level = options.level ?? "silent";
    this.sink = options.sink ?? ((line) => console.error(line));
    this.collect = options.collectMetrics ?? true;
    this.namespace = namespace;
    this.color = options.color ?? detectColor();
    this.timestamps = options.timestamps ?? true;
    this.metrics = emptyMetrics();
    this.epoch = performance.now();
  }

  child(namespace: string): Logger {
    const ns = this.namespace ? `${this.namespace}.${namespace}` : namespace;
    const c = new Logger({
      level: this.level,
      sink: this.sink,
      collectMetrics: this.collect,
      color: this.color,
      timestamps: this.timestamps,
    }, ns);
    (c as unknown as { metrics: Metrics }).metrics = this.metrics;
    (c as unknown as { epoch: number }).epoch = this.epoch;
    return c;
  }

  private enabled(level: LogLevel): boolean {
    return LEVEL_RANK[this.level] >= LEVEL_RANK[level];
  }

  private paint(s: string, color: string): string {
    return this.color ? `${color}${s}${ANSI.reset}` : s;
  }

  private emit(level: Exclude<LogLevel, "silent">, message: string): void {
    if (!this.enabled(level)) return;
    const parts: string[] = [];
    if (this.timestamps) {
      const elapsed = performance.now() - this.epoch;
      parts.push(this.paint(`+${formatDuration(elapsed).padStart(7)}`, ANSI.gray));
    }
    parts.push(this.paint(level.padEnd(5), LEVEL_COLOR[level]));
    if (this.namespace) parts.push(this.paint(this.namespace.padEnd(16), ANSI.dim));
    parts.push(message);
    this.sink(parts.join(" "));
  }

  info(message: string): void {
    this.emit("info", message);
  }
  debug(message: string): void {
    this.emit("debug", message);
  }
  trace(message: string): void {
    this.emit("trace", message);
  }

  /** Time an async op; emits at `level` with duration. */
  async time<T>(
    level: Exclude<LogLevel, "silent">,
    label: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!this.enabled(level)) return await fn();
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.emit(
        level,
        `${label} ${this.paint(formatDuration(performance.now() - start), ANSI.yellow)}`,
      );
    }
  }

  recordHttp(opts: { bytesIn: number; bytesOut: number; durationMs: number }): void {
    if (!this.collect) return;
    this.metrics.httpRequests++;
    this.metrics.httpBytesIn += opts.bytesIn;
    this.metrics.httpBytesOut += opts.bytesOut;
    this.metrics.httpDurationMs += opts.durationMs;
  }

  recordPack(opts: {
    bytes: number;
    durationMs: number;
    byType: Record<"commit" | "tree" | "blob" | "tag", number>;
  }): void {
    if (!this.collect) return;
    this.metrics.packBytes += opts.bytes;
    this.metrics.packParseMs += opts.durationMs;
    for (const k of ["commit", "tree", "blob", "tag"] as const) {
      this.metrics.byType[k] += opts.byType[k];
      this.metrics.packObjects += opts.byType[k];
    }
  }

  summary(): string {
    const m = this.metrics;
    const bold = (s: string) => this.paint(s, ANSI.bold);
    const dim = (s: string) => this.paint(s, ANSI.dim);
    const num = (s: string) => this.paint(s, ANSI.green);

    const rows: [string, string][] = [
      ["HTTP requests", num(String(m.httpRequests))],
      ["  bytes in", num(formatBytes(m.httpBytesIn))],
      ["  bytes out", num(formatBytes(m.httpBytesOut))],
      ["  total time", num(formatDuration(m.httpDurationMs))],
      [
        "  avg / req",
        num(
          m.httpRequests > 0 ? formatDuration(m.httpDurationMs / m.httpRequests) : "n/a",
        ),
      ],
      ["Pack objects", num(String(m.packObjects))],
      [
        "  by type",
        dim(
          `${m.byType.commit} commit, ${m.byType.tree} tree, ${m.byType.blob} blob, ${m.byType.tag} tag`,
        ),
      ],
      ["  bytes", num(formatBytes(m.packBytes))],
      ["  parse time", num(formatDuration(m.packParseMs))],
    ];
    const labelW = Math.max(...rows.map(([l]) => l.length));
    const lines = rows.map(([l, v]) => `  ${l.padEnd(labelW)}  ${v}`);
    return [bold("── stats ──────────────────────────────"), ...lines].join("\n");
  }
}

export const NULL_LOGGER = new Logger({ level: "silent", collectMetrics: false });
