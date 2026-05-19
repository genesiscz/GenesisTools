/**
 * @app/logger/client — browser-safe facade mirroring the @app/logger surface.
 *
 * Zero Node-only imports: no pino, no pino-pretty, no @clack/prompts, no
 * node:stream, no chalk. Uses picocolors for ANSI prefixes (browser-safe:
 * picocolors is a pure-JS package with no Node-only deps).
 *
 * Intended for .tsx / browser-context files that need logger/out but cannot
 * pull the server-side @app/logger bundle.
 *
 * Prompts are not available in browser contexts — calling any prompt method
 * throws a clear error. Spinners are no-ops. result()/print() write to
 * console.log (DevTools console = stdout equivalent in browsers).
 */
import { SafeJSON } from "@app/utils/json";
import pc from "picocolors";

// ─── Types (mirrored from @app/logger, without pino) ──────────────────────────

type LogFn = {
    (msg: string, ...args: unknown[]): void;
    (obj: Record<string, unknown>, msg?: string, ...args: unknown[]): void;
};

interface ScopedLog {
    trace: LogFn;
    debug: LogFn;
    info: LogFn;
    warn: LogFn;
    error: LogFn;
    fatal: LogFn;
    out: Out;
    tee: Out;
}

interface ScopedLogger {
    log: ScopedLog;
    out: Out;
}

export interface Out {
    intro(t: string): void;
    outro(m: string): void;
    cancel(m?: string): void;
    note(c: string, t?: string): void;
    log: {
        info(m: string): void;
        success(m: string): void;
        warn(m: string): void;
        warning(m: string): void;
        error(m: string): void;
        step(m: string): void;
        message(m: string | string[]): void;
    };
    spinner(): { start(m?: string): void; stop(m?: string): void; message(m?: string): void };
    text(o: {
        message: string;
        placeholder?: string;
        initialValue?: string;
        validate?: (v: string) => string | undefined;
    }): Promise<string | symbol>;
    confirm(o: { message: string; initialValue?: boolean }): Promise<boolean | symbol>;
    select<V>(o: {
        message: string;
        options: { value: V; label: string; hint?: string }[];
        initialValue?: V;
    }): Promise<V | symbol>;
    multiselect<V>(o: {
        message: string;
        options: { value: V; label: string }[];
        required?: boolean;
    }): Promise<V[] | symbol>;
    password(o: { message: string; validate?: (v: string) => string | undefined }): Promise<string | symbol>;
    isCancel(value: unknown): value is symbol;
    result(data: unknown): void;
    print(raw: string): void;
    detail(m: string): void;
    // Shortcuts (added in COS-T2; present here from the start per T1 spec)
    info(msg: string, ...rest: unknown[]): void;
    warn(msg: string, ...rest: unknown[]): void;
    error(msg: string, ...rest: unknown[]): void;
}

export interface LoggerFacade {
    trace: LogFn;
    debug: LogFn;
    info: LogFn;
    warn: LogFn;
    error: LogFn;
    fatal: LogFn;
    child(bindings: Record<string, unknown>): LoggerFacade;
    get level(): string;
    set level(v: string);
    flush(): void;
    scoped(component: string, opts?: { level?: string; bindings?: Record<string, unknown> }): ScopedLogger;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function promptUnavailable(): never {
    throw new Error("@app/logger/client: prompts are not available in browser contexts");
}

function noopSpinner() {
    return {
        start(_m?: string) {},
        stop(_m?: string) {},
        message(_m?: string) {},
    };
}

function formatArgs(args: unknown[]): string {
    return args.map((a) => (typeof a === "object" ? SafeJSON.stringify(a) : String(a))).join(" ");
}

function makeLogFn(
    consoleFn: (...args: unknown[]) => void,
    prefix: string
): LogFn {
    return (objOrMsg: string | Record<string, unknown>, ...rest: unknown[]) => {
        if (typeof objOrMsg === "string") {
            const extra = rest.length > 0 ? ` ${formatArgs(rest)}` : "";
            consoleFn(`${prefix}${objOrMsg}${extra}`);
        } else {
            const msg = rest[0] !== undefined ? ` ${String(rest[0])}` : "";
            consoleFn(`${prefix}${SafeJSON.stringify(objOrMsg)}${msg}`);
        }
    };
}

// ─── Scoped Out (for scoped logger's .log.out / .log.tee / .out) ─────────────

function makeScopedOut(scope: string): Out {
    const tag = `[${scope}] `;

    const L = (prefix: string, fn: (...a: unknown[]) => void) =>
        (m: string): void => {
            fn(`${prefix}${tag}${m}`);
        };

    return {
        intro: (t) => console.log(`${pc.cyan("◆")} ${tag}${t}`),
        outro: (m) => console.log(`${pc.green("◆")} ${tag}${m}`),
        cancel: (m) => console.warn(`${pc.red("■")} ${tag}${m ?? ""}`),
        note: (c, t) => console.log(`${pc.dim(t ? `[${t}]` : "note")} ${tag}${c}`),
        log: {
            info: L(pc.cyan("◆") + " ", console.log),
            success: L(pc.green("✔") + " ", console.log),
            warn: L(pc.yellow("▲") + " ", console.warn),
            warning: L(pc.yellow("▲") + " ", console.warn),
            error: L(pc.red("✖") + " ", console.error),
            step: L(pc.cyan("◆") + " ", console.log),
            message: (m) => console.log(`${tag}${Array.isArray(m) ? m.join("\n") : m}`),
        },
        spinner: noopSpinner,
        text: () => promptUnavailable(),
        confirm: () => promptUnavailable(),
        select: () => promptUnavailable(),
        multiselect: () => promptUnavailable(),
        password: () => promptUnavailable(),
        isCancel: (v): v is symbol => typeof v === "symbol",
        result: (data) => console.log(SafeJSON.stringify(data)),
        print: (raw) => console.log(raw),
        detail: (m) => console.log(`  ${tag}${m}`),
        info: (msg, ...rest) => {
            const extra = rest.length > 0 ? ` ${formatArgs(rest)}` : "";
            console.log(`${pc.cyan("◆")} ${tag}${msg}${extra}`);
        },
        warn: (msg, ...rest) => {
            const extra = rest.length > 0 ? ` ${formatArgs(rest)}` : "";
            console.warn(`${pc.yellow("▲")} ${tag}${msg}${extra}`);
        },
        error: (msg, ...rest) => {
            const extra = rest.length > 0 ? ` ${formatArgs(rest)}` : "";
            console.error(`${pc.red("✖")} ${tag}${msg}${extra}`);
        },
    };
}

// ─── Top-level Out ────────────────────────────────────────────────────────────

function makeTopLevelOut(): Out {
    return {
        intro: (t) => console.log(`${pc.cyan("◆")}  ${t}`),
        outro: (m) => console.log(`${pc.green("◆")}  ${m}`),
        cancel: (m) => console.warn(`${pc.red("■")}  ${m ?? ""}`),
        note: (c, t) => console.log(`${pc.dim(t ? `[${t}]` : "note")}  ${c}`),
        log: {
            info: (m) => console.log(`${pc.cyan("◆")}  ${m}`),
            success: (m) => console.log(`${pc.green("✔")}  ${m}`),
            warn: (m) => console.warn(`${pc.yellow("▲")}  ${m}`),
            warning: (m) => console.warn(`${pc.yellow("▲")}  ${m}`),
            error: (m) => console.error(`${pc.red("✖")}  ${m}`),
            step: (m) => console.log(`${pc.cyan("◆")}  ${m}`),
            message: (m) => console.log(Array.isArray(m) ? m.join("\n") : m),
        },
        spinner: noopSpinner,
        text: () => promptUnavailable(),
        confirm: () => promptUnavailable(),
        select: () => promptUnavailable(),
        multiselect: () => promptUnavailable(),
        password: () => promptUnavailable(),
        isCancel: (v): v is symbol => typeof v === "symbol",
        result: (data) => console.log(SafeJSON.stringify(data)),
        print: (raw) => console.log(raw),
        detail: (m) => console.log(`  ${m}`),
        info: (msg, ...rest) => {
            const extra = rest.length > 0 ? ` ${formatArgs(rest)}` : "";
            console.log(`${pc.cyan("◆")}  ${msg}${extra}`);
        },
        warn: (msg, ...rest) => {
            const extra = rest.length > 0 ? ` ${formatArgs(rest)}` : "";
            console.warn(`${pc.yellow("▲")}  ${msg}${extra}`);
        },
        error: (msg, ...rest) => {
            const extra = rest.length > 0 ? ` ${formatArgs(rest)}` : "";
            console.error(`${pc.red("✖")}  ${msg}${extra}`);
        },
    };
}

// ─── Logger factory ───────────────────────────────────────────────────────────

function makeLogger(scope?: string): LoggerFacade {
    const prefix = scope ? `[${scope}] ` : "";
    let _level = "info";

    return {
        trace: makeLogFn(console.debug, prefix),
        debug: makeLogFn(console.debug, prefix),
        info: makeLogFn(console.debug, prefix),
        warn: makeLogFn(console.warn, prefix),
        error: makeLogFn(console.error, prefix),
        fatal: makeLogFn(console.error, prefix),
        child: (bindings) => {
            const childScope = scope
                ? `${scope}:${Object.values(bindings).join(",")}`
                : Object.values(bindings).join(",");
            return makeLogger(childScope);
        },
        get level() {
            return _level;
        },
        set level(v: string) {
            _level = v;
        },
        flush: () => {},
        scoped(component, _opts) {
            const childLogger = makeLogger(component);
            const scopedOut = makeScopedOut(component);
            const logExt = childLogger as LoggerFacade & { out: Out; tee: Out };
            logExt.out = scopedOut;
            logExt.tee = scopedOut;
            return { log: logExt as ScopedLog, out: makeScopedOut(component) };
        },
    };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export const logger: LoggerFacade = makeLogger();
export const out: Out = makeTopLevelOut();
