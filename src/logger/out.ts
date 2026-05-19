import { isQuietOutput } from "@app/utils/cli/output-mode";
import { createQuietSpinner } from "@app/utils/cli/quiet-spinner";
import { asResult } from "@app/utils/cli/result";
import { writeStdout } from "@app/utils/cli/stdout";
import type { SelectValue } from "@app/utils/prompts/p";
import * as p from "@app/utils/prompts/p";
import { isCancel } from "@clack/prompts";
import { type Logger, logger } from "../logger";

export interface OutConfig {
    clack: "auto" | "off";
    console: "chalk" | "plain";
    mirrorToLogger: boolean;
    mirrorPrompts: boolean;
    timestamps: boolean;
    showComponent: boolean;
}

const cfg: OutConfig = {
    clack: "auto",
    console: "chalk",
    mirrorToLogger: true,
    mirrorPrompts: true,
    timestamps: false,
    showComponent: false,
};

export function configureOut(patch: Partial<OutConfig>): void {
    Object.assign(cfg, patch);
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
    select<V extends SelectValue>(o: {
        message: string;
        options: { value: V; label: string; hint?: string }[];
        initialValue?: V;
    }): Promise<V | symbol>;
    multiselect<V extends SelectValue>(o: {
        message: string;
        options: { value: V; label: string }[];
        required?: boolean;
    }): Promise<V[] | symbol>;
    password(o: { message: string; validate?: (v: string) => string | undefined }): Promise<string | symbol>;
    isCancel: typeof isCancel;
    result(data: unknown): void;
    print(raw: string): void;
    detail(m: string): void;
    // Convenience shortcuts — match console.* ergonomics (rest args appended).
    // out.info/warn/error forward to out.log.info/warn/error but also accept
    // extra args (e.g. `out.warn("msg", err)`) matching the codemod output shape.
    info(msg: string, ...rest: unknown[]): void;
    warn(msg: string, ...rest: unknown[]): void;
    error(msg: string, ...rest: unknown[]): void;
}

// Drain-safe stdout write; a rejected write is surfaced to the logger (file)
// rather than swallowed into an UnhandledRejection. logger here is the lazy
// facade — safe to reference at call time even though logger.ts statically
// imports makeOut (the ESM cycle resolves because makeOut is hoisted and
// `logger` is only touched inside these closures, never at module-eval).
function emitResult(text: string): void {
    writeStdout(text).catch((err) => {
        logger.debug({ err }, "out: stdout write failed");
    });
}

/**
 * Build an Out bound to an optional component + how it mirrors to the logger.
 * `mirrorLogger`: a pre-built child to mirror through — pass it (e.g. from
 * logger.scoped()) to avoid re-deriving a scoped child (and two makeOut
 * closures) on every mirrored line (PR #176 review t4/t5).
 */
export function makeOut(component: string | null, mirror: "component" | "config" | "none", mirrorLogger?: Logger): Out {
    const mirrorLine = (m: string): void => {
        if (mirror === "none") {
            return;
        }

        if (mirror === "config" && !cfg.mirrorToLogger) {
            return;
        }

        const target = mirrorLogger ?? (component ? logger.scoped(component).log : logger);
        target.debug(m);
    };

    const L =
        (k: "info" | "success" | "warn" | "warning" | "error" | "step") =>
        (m: string): void => {
            p.log[k](m);
            mirrorLine(m);
        };

    // Lrest: like L but accepts rest args (matches console.* ergonomics).
    // Extra args are appended after a space so `out.warn("msg", err)` stays readable.
    const Lrest =
        (k: "info" | "warn" | "error") =>
        (msg: string, ...rest: unknown[]): void => {
            const m = rest.length > 0 ? `${msg} ${rest.map((a) => (typeof a === "object" ? String(a) : a)).join(" ")}` : msg;
            p.log[k](m);
            mirrorLine(m);
        };

    return {
        intro: (t) => p.intro(t),
        outro: (m) => p.outro(m),
        cancel: (m) => p.cancel(m ?? ""),
        note: (c, t) => p.note(c, t),
        log: {
            info: L("info"),
            success: L("success"),
            warn: L("warn"),
            warning: L("warning"),
            error: L("error"),
            step: L("step"),
            message: (m) => p.log.message(m),
        },
        spinner: () => (isQuietOutput() ? createQuietSpinner() : p.spinner()),
        text: (o) => p.text(o),
        confirm: (o) => p.confirm(o),
        // p/ is intentionally non-generic (SelectValue); the Out contract is
        // generic for ergonomic call sites. The variance gap is real and only
        // bridgeable with a cast at this boundary — `never` is assignable to
        // any `V | symbol` result.
        select: (o) => p.select(o) as Promise<never>,
        multiselect: (o) => p.multiselect(o) as Promise<never>,
        password: (o) => p.password(o),
        isCancel,
        result: (data) => emitResult(asResult(data)),
        print: (raw) => emitResult(asResult(raw)),
        detail: (m) => {
            p.log.message(m);
            mirrorLine(m);
        },
        info: Lrest("info"),
        warn: Lrest("warn"),
        error: Lrest("error"),
    };
}

// Standalone unscoped out — mirror governed by configureOut.mirrorToLogger.
export const out: Out = makeOut(null, "config");
