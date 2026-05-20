/**
 * @app/logger/client — browser-safe facade mirroring the @app/logger surface.
 *
 * Zero Node-only imports: no pino, no pino-pretty, no @clack/prompts, no
 * node:stream, no chalk, no picocolors.
 *
 * Earlier versions used picocolors for ANSI prefixes — that's a pure-JS
 * package import-wise, but the OUTPUT (ANSI escape codes) renders as garbage
 * in browser DevTools (e.g. `[36m`). PR #179 t11 fix: use plain
 * Unicode glyphs (◆ ✔ ▲ ✖ ℹ ■) — they render fine without any escapes.
 *
 * Intended for .tsx / browser-context files that need logger/out but cannot
 * pull the server-side @app/logger bundle.
 *
 * Prompts are not available in browser contexts — calling any prompt method
 * throws a clear error. Spinners are no-ops. result()/print() write to
 * console.log (DevTools console = stdout equivalent in browsers).
 */
import { SafeJSON } from "@app/utils/json";

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

function makeLogFn(consoleFn: (...args: unknown[]) => void, prefix: string): LogFn {
    return (objOrMsg: string | Record<string, unknown>, ...rest: unknown[]) => {
        // PR #179 t10 fix: pass objects directly to consoleFn so browser
        // DevTools can render an interactive inspector. Pre-stringifying via
        // SafeJSON loses that capability. The pino-style signature accepts
        // either (msg, ...args) or (obj, msg?, ...args) — keep object as a
        // separate arg in both branches so DevTools sees it as a structured
        // value, not a string.
        if (typeof objOrMsg === "string") {
            if (rest.length > 0) {
                consoleFn(`${prefix}${objOrMsg}`, ...rest);
            } else {
                consoleFn(`${prefix}${objOrMsg}`);
            }
        } else if (typeof rest[0] === "string") {
            // pino-style (obj, msg, ...args) — emit "[prefix]msg" + obj + extras
            consoleFn(`${prefix}${rest[0]}`, objOrMsg, ...rest.slice(1));
        } else {
            // (obj, ...args) with no string message — emit prefix + obj + extras
            consoleFn(prefix.trim() || "", objOrMsg, ...rest);
        }
    };
}

// ─── Scoped Out (for scoped logger's .log.out / .log.tee / .out) ─────────────

// Plain Unicode prefixes — render cleanly in browser DevTools without ANSI
// escape sequences (PR #179 t11 fix). Browser consoles ignore ANSI; pre-fix
// they showed `[36m◆[39m` instead of `◆`. These constants make
// the intent of "no ANSI here" obvious to future readers.
const ICON_INFO = "◆";
const ICON_OK = "✔";
const ICON_WARN = "▲";
const ICON_ERR = "✖";
const ICON_CANCEL = "■";

function makeScopedOut(scope: string): Out {
    const tag = `[${scope}] `;

    return {
        intro: (t) => console.info(`${ICON_INFO} ${tag}${t}`),
        outro: (m) => console.info(`${ICON_INFO} ${tag}${m}`),
        cancel: (m) => console.warn(`${ICON_CANCEL} ${tag}${m ?? ""}`),
        note: (c, t) => console.info(`${t ? `[${t}]` : "note"} ${tag}${c}`),
        log: {
            info: (m) => console.info(`${ICON_INFO} ${tag}${m}`),
            success: (m) => console.info(`${ICON_OK} ${tag}${m}`),
            warn: (m) => console.warn(`${ICON_WARN} ${tag}${m}`),
            warning: (m) => console.warn(`${ICON_WARN} ${tag}${m}`),
            error: (m) => console.error(`${ICON_ERR} ${tag}${m}`),
            step: (m) => console.info(`${ICON_INFO} ${tag}${m}`),
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
        // Pass rest-args directly to console so DevTools keeps inspectors
        // (PR #179 t10 fix — same rationale as makeLogFn).
        info: (msg, ...rest) => console.info(`${ICON_INFO} ${tag}${msg}`, ...rest),
        warn: (msg, ...rest) => console.warn(`${ICON_WARN} ${tag}${msg}`, ...rest),
        error: (msg, ...rest) => console.error(`${ICON_ERR} ${tag}${msg}`, ...rest),
    };
}

// ─── Top-level Out ────────────────────────────────────────────────────────────

function makeTopLevelOut(): Out {
    return {
        intro: (t) => console.info(`${ICON_INFO}  ${t}`),
        outro: (m) => console.info(`${ICON_INFO}  ${m}`),
        cancel: (m) => console.warn(`${ICON_CANCEL}  ${m ?? ""}`),
        note: (c, t) => console.info(`${t ? `[${t}]` : "note"}  ${c}`),
        log: {
            info: (m) => console.info(`${ICON_INFO}  ${m}`),
            success: (m) => console.info(`${ICON_OK}  ${m}`),
            warn: (m) => console.warn(`${ICON_WARN}  ${m}`),
            warning: (m) => console.warn(`${ICON_WARN}  ${m}`),
            error: (m) => console.error(`${ICON_ERR}  ${m}`),
            step: (m) => console.info(`${ICON_INFO}  ${m}`),
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
        info: (msg, ...rest) => console.info(`${ICON_INFO}  ${msg}`, ...rest),
        warn: (msg, ...rest) => console.warn(`${ICON_WARN}  ${msg}`, ...rest),
        error: (msg, ...rest) => console.error(`${ICON_ERR}  ${msg}`, ...rest),
    };
}

// ─── Logger factory ───────────────────────────────────────────────────────────

function makeLogger(scope?: string): LoggerFacade {
    const prefix = scope ? `[${scope}] ` : "";
    let _level = "info";

    return {
        trace: makeLogFn(console.debug, prefix),
        debug: makeLogFn(console.debug, prefix),
        // PR #179 t1+t9 fix: info → console.info (not console.debug). Browser
        // DevTools hide console.debug by default ("Verbose" log level required);
        // info is a higher severity than debug and should be visible in default
        // views — matches the server-side logger's stream semantics.
        info: makeLogFn(console.info, prefix),
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
