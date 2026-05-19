import { homedir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { formatLocalDate } from "@app/utils/date";
import { SafeJSON } from "@app/utils/json";
import chalk from "chalk";
import pino from "pino";
import PinoPretty from "pino-pretty";
// ESM cycle logger.ts ⇄ logger/out.ts is safe: makeOut is a HOISTED
// `export function` (resolvable while out.ts is mid-eval) and out.ts touches
// `logger` only inside closures, never at module-eval. Never convert to
// require() (not a Bun ESM default) or a dynamic import (loses sync ordering).
import { makeOut, type Out } from "./logger/out";
// Surface the standalone unscoped `out` through the package entry so callers
// can `import { out } from "@app/logger"` (the two-layer model's user-facing
// channel). No new ESM-cycle risk: logger.ts already statically depends on
// ./logger/out for makeOut — this re-export adds nothing to the cycle graph.
export { out } from "./logger/out";

type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "silent";

// Console threshold is a runtime-mutable module-level value; the pino root
// stays "trace" (file never starves) and a gated Writable (built in
// createLogger) drops sub-threshold records before pino-pretty. Mutating this
// via setConsoleLevel()/configureLogger() retroactively re-gates already
// created children — no rebuild, see spec §3.1.
function getConsoleLevel(): pino.LevelWithSilent {
    if (process.env.LOG_TRACE === "1") {
        return "trace";
    }

    if (process.env.LOG_DEBUG === "1") {
        return "debug";
    }

    if (process.env.LOG_SILENT === "1") {
        return "silent";
    }

    const env = process.env.LOG_CONSOLE_LEVEL as pino.LevelWithSilent | undefined;
    if (env && env in pino.levels.values) {
        return env;
    }

    return "info";
}

let consoleLevel: pino.LevelWithSilent = getConsoleLevel();
export function setConsoleLevel(l: pino.LevelWithSilent): void {
    consoleLevel = l;
}

const prefixPid = process.env.LOG_PID === "1" || process.env.DEBUG === "1";
const isTerminal = process.stdout.isTTY === true;

export interface LoggerOptions {
    level?: LogLevel;
    logToFile?: boolean;
    includeTimestamp?: boolean;
    prefixPid?: boolean;
    timestampFormat?: string | false;
    /** Hide level prefix for info/debug/trace, only show for warn/error */
    minimalLevels?: boolean;
}

export interface LoggerConfig {
    includeTimestamp?: boolean;
    timestampFormat?: string;
    logToFile?: boolean;
    level?: LogLevel;
}

// Global config
let globalConfig: LoggerConfig = {
    includeTimestamp: false, // Default: no timestamps
    timestampFormat: "HH:MM:ss",
};
let fileLogWarningShown = false;

/**
 * Create a pino logger with pretty printing
 */
export const createLogger = (options: LoggerOptions = {}): pino.Logger => {
    const {
        logToFile = false,
        includeTimestamp = globalConfig.includeTimestamp ?? false,
        prefixPid: showPid = prefixPid,
        timestampFormat = includeTimestamp ? (globalConfig.timestampFormat ?? "HH:MM:ss") : false,
        minimalLevels = false,
    } = options;

    const streams: pino.StreamEntry[] = [];

    // File stream (if enabled) — ALWAYS debug+, independent of the console
    // gate, so the file never starves no matter how high the console threshold.
    if (logToFile) {
        const date = formatLocalDate(new Date());
        const logDir = path.join(homedir(), ".genesis-tools", "logs");
        const logFilePath = path.join(logDir, `${date}.log`);

        try {
            streams.push({
                level: "debug" as pino.Level,
                stream: pino.destination({ dest: logFilePath, sync: true, mkdir: true }),
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);

            if (!fileLogWarningShown && process.stderr && typeof process.stderr.write === "function") {
                fileLogWarningShown = true;
                process.stderr.write(`[logger] Failed to open log file ${logFilePath}: ${message}\n`);
            }
        }
    }

    // Console stream → STDERR (stdout is reserved for machine results via
    // out.result). A gated Writable drops records below the *mutable*
    // module-level consoleLevel before pino-pretty, so setConsoleLevel() /
    // configureLogger() retroactively re-gate already-created children — the
    // root pino stays "trace" so the file sink never starves (spec §3.1).
    // `destination` is the process.stderr STREAM, not fd 2: same fd in prod,
    // but pino-pretty pipes through it so test stderr shims still intercept.
    if (process.stderr && typeof process.stderr.write === "function") {
        const prettyOptions: PinoPretty.PrettyOptions = {
            destination: process.stderr,
            sync: true,
            colorize: process.stderr.isTTY === true,
            translateTime: timestampFormat,
            ignore: showPid ? "hostname" : "pid,hostname",
        };

        // minimalLevels: hide level for info/debug/trace, colored WARN:/ERROR:.
        if (minimalLevels) {
            prettyOptions.customPrettifiers = {
                level: (logLevelValue: unknown) => {
                    const lvl = String(logLevelValue).toLowerCase();
                    // pino sends level as number (40=warn, 50=error) or label
                    if (lvl === "warn" || lvl === "40") {
                        return isTerminal ? chalk.yellow("WARN:") : "WARN:";
                    }

                    if (lvl === "error" || lvl === "50") {
                        return isTerminal ? chalk.red("ERROR:") : "ERROR:";
                    }

                    return ""; // hide for trace/debug/info
                },
            };
        }

        const pretty = PinoPretty(prettyOptions);
        const gated = new Writable({
            write(chunk, _enc, cb) {
                try {
                    const lvl = (SafeJSON.parse(chunk.toString()) as { level: number }).level;
                    if (lvl >= pino.levels.values[consoleLevel]) {
                        pretty.write(chunk);
                    }
                } catch {
                    // Fail-open: an unparseable record still reaches the user.
                    // We cannot logger.* here — that recurses into this sink.
                    pretty.write(chunk);
                }

                cb();
            },
        });
        streams.push({ level: "trace" as pino.Level, stream: gated });
    }

    const baseConfig: pino.LoggerOptions = {
        level: "trace",
        timestamp: includeTimestamp ? pino.stdTimeFunctions.isoTime : false,
        ...(showPid && { base: { pid: process.pid } }),
    };

    const logger = pino(baseConfig, pino.multistream(streams));

    // Streams are sync (file + pretty); no per-call flush wrap needed — pino
    // writes synchronously, so output ordering is preserved as-is.
    return logger;
};

export type Logger = pino.Logger;

let _pino: pino.Logger | null = null;
function get(): pino.Logger {
    if (_pino === null) {
        _pino = createLogger({ logToFile: true, minimalLevels: true });
    }

    return _pino;
}

// Base binding (e.g. `{ tool }`) set once by the runTool bootstrap before
// parseAsync. The root pino is NEVER rebuilt; instead a single long-lived
// child carries the base bindings, and every facade method + scoped()
// delegates through eff() so the binding is in the chain. The `.level`
// getter/setter stays on get() (root level is the right setter; child levels
// propagate down — eff() is a child of get(), so the console gate, which
// reads the module-level consoleLevel not logger.level, still works).
// NOTE: scoped children created BEFORE setBaseBinding() (module-init time) do
// NOT retroactively gain the base binding — only post-call scoped/log calls
// do. runTool calls setBaseBinding before parseAsync, so action code is fine.
let _base: Record<string, unknown> = {};
let _effective: pino.Logger | null = null;
function eff(): pino.Logger {
    // Plan used `return (_effective ??= …)`; biome's noAssignInExpressions
    // blocks assignment-in-expression. Block form is semantically identical
    // (_effective is only ever null before first init — never undefined).
    if (_effective === null) {
        _effective = Object.keys(_base).length ? get().child(_base) : get();
    }

    return _effective;
}

export function setBaseBinding(b: Record<string, unknown>): void {
    _base = { ..._base, ...b };
    _effective = get().child(_base);
}

// Hand-coded stable facade. NOT a Proxy (pino .level/.bindings getter+setter
// and method count make Proxy traps fragile — see spec §3.1).
interface ScopedLogger {
    log: pino.Logger & { out: Out; tee: Out };
    out: Out;
}

export interface LoggerFacade {
    trace: pino.LogFn;
    debug: pino.LogFn;
    info: pino.LogFn;
    warn: pino.LogFn;
    error: pino.LogFn;
    fatal: pino.LogFn;
    child(bindings: pino.Bindings, options?: pino.ChildLoggerOptions): pino.Logger;
    get level(): string;
    set level(v: string);
    flush(): void;
    scoped(component: string, opts?: { level?: string; bindings?: Record<string, unknown> }): ScopedLogger;
}

export const logger: LoggerFacade = {
    trace: (...a: Parameters<pino.LogFn>) => eff().trace(...a),
    debug: (...a: Parameters<pino.LogFn>) => eff().debug(...a),
    info: (...a: Parameters<pino.LogFn>) => eff().info(...a),
    warn: (...a: Parameters<pino.LogFn>) => eff().warn(...a),
    error: (...a: Parameters<pino.LogFn>) => eff().error(...a),
    fatal: (...a: Parameters<pino.LogFn>) => eff().fatal(...a),
    child: (b: pino.Bindings, o?: pino.ChildLoggerOptions) => eff().child(b, o),
    get level() {
        return get().level;
    },
    set level(v: string) {
        get().level = v;
    },
    flush: () => eff().flush(),
    scoped(component, opts) {
        const child = eff().child(
            { component, ...(opts?.bindings ?? {}) },
            opts?.level ? { level: opts.level } : undefined
        );
        // log.out/log.tee ALWAYS mirror with the component tag (ignores
        // configureOut.mirrorToLogger — "tee" means tee). The destructured
        // `out` is only-out (mirror "none"): clack/stdout, no debug mirror.
        const scopedOut = makeOut(component, "component");
        const logExt = child as pino.Logger & { out: Out; tee: Out };
        logExt.out = scopedOut;
        logExt.tee = scopedOut;

        return { log: logExt, out: makeOut(component, "none") };
    },
};

/**
 * Bridging stubs: the facade replaced the old mutable `let logger`/`let
 * consoleLog`, but configureLogger (2 ext callers) and getLogger (3 ext
 * callers — ApiClient, WebViewPool) must keep compiling through Phase 1.
 * Task 4 rewrites configureLogger to drive the console gate; here it only
 * records globalConfig (no rebuild — the facade singleton never rebuilds).
 */
export const configureLogger = (config: LoggerConfig): void => {
    globalConfig = { ...globalConfig, ...config };
    if (config.level) {
        // Drive the runtime console gate in place — the facade singleton is
        // never rebuilt, so this retroactively re-gates existing children.
        setConsoleLevel(config.level);
    }
    // Timestamp opts merged into globalConfig only take effect if set BEFORE
    // the first log (createLogger reads them lazily on first use).
};

/** Returns the underlying pino (now the lazy singleton). */
export function getLogger(): pino.Logger {
    return get();
}

export const consoleLog = logger; // transitional alias (Phase 4 migrates importers)
export default logger; // transitional default (removed in Task 22)
