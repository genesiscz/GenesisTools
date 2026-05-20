import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCancel, isCancelled } from "@app/utils/prompts/clack/helpers";
import { multilineText } from "@app/utils/prompts/clack/multiline";
import { searchSelect } from "@app/utils/prompts/clack/search-select";
import type { TextOptions } from "@clack/prompts";
import * as clack from "@clack/prompts";
import pc from "picocolors";

// stdout is reserved for machine results (out.result/print). Route clack's
// non-prompt rendering (log.*, spinner, note, intro/outro/cancel) to stderr.
// @clack/prompts@1.0.0 ClackSettings has no `output` field, so the plan's
// `updateSettings({ output })` recipe is a no-op on this pin; the portable
// surface is the per-call `output` on CommonOptions (inherited by
// LogMessageOptions/NoteOptions/SpinnerOptions). Interactive prompts
// (text/confirm/select/multiselect/password) intentionally do NOT pass this —
// they stay on the TTY.
const STDERR: { output: typeof process.stderr } = { output: process.stderr };

import type { PromptBackend } from "./backend";
import type {
    EditorOpts,
    Log,
    MultiSelectOpts,
    NumberOpts,
    PasswordOpts,
    SearchOpts,
    SelectOption,
    SelectOpts,
    Spinner,
    TextOpts,
    TypedConfirmOpts,
} from "./types";

function unwrap<T>(result: T | symbol): T {
    if (isCancelled(result)) {
        handleCancel();
    }

    return result as T;
}

const log: Log = {
    info: (msg) => clack.log.info(msg, STDERR),
    success: (msg) => clack.log.success(msg, STDERR),
    warn: (msg) => clack.log.warn(msg, STDERR),
    warning: (msg) => clack.log.warn(msg, STDERR),
    error: (msg) => clack.log.error(msg, STDERR),
    step: (msg) => clack.log.step(msg, STDERR),
    message: (msg) => clack.log.message(Array.isArray(msg) ? msg.join("\n") : msg, STDERR),
};

function toTextOptions(opts: TextOpts): TextOptions {
    const textOpts: TextOptions = { message: opts.message };
    if (opts.placeholder !== undefined) {
        textOpts.placeholder = opts.placeholder;
    }

    if (opts.initialValue !== undefined) {
        textOpts.initialValue = opts.initialValue;
    }

    if (opts.validate) {
        textOpts.validate = (value) => opts.validate?.(value ?? "");
    }

    return textOpts;
}

function toClackOptions(options: SelectOption[]) {
    return options.map((option) => ({
        value: option.value,
        label: option.label,
        hint: option.hint ?? "",
    }));
}

async function typedConfirmImpl(opts: TypedConfirmOpts): Promise<boolean> {
    const expected = opts.caseSensitive === false ? opts.phrase.toLowerCase() : opts.phrase;
    const typed = unwrap(
        await clack.text({
            message: `${opts.message} ${pc.dim(`(type "${opts.phrase}" to confirm)`)}`,
            placeholder: opts.phrase,
            validate: (value) => {
                const typedValue = value ?? "";
                const compared = opts.caseSensitive === false ? typedValue.toLowerCase() : typedValue;
                if (compared !== expected) {
                    return `Must type exactly: ${opts.phrase}`;
                }

                return undefined;
            },
        })
    );

    const compared = opts.caseSensitive === false ? typed.toLowerCase() : typed;
    return compared === expected;
}

export const clackBackend: PromptBackend = {
    intro: (msg) => clack.intro(msg, STDERR),
    outro: (msg) => clack.outro(msg, STDERR),
    cancel: (msg) => clack.cancel(msg, STDERR),
    note: (content, title) => clack.note(content, title, STDERR),

    text: async (opts: TextOpts) => unwrap(await clack.text(toTextOptions(opts))),

    confirm: async (opts) => {
        const message = opts.danger ? pc.red(opts.message) : opts.message;
        return unwrap(await clack.confirm({ message, initialValue: opts.initialValue }));
    },

    typedConfirm: typedConfirmImpl,

    select: async (opts: SelectOpts) =>
        unwrap(
            await clack.select({
                message: opts.message,
                options: toClackOptions(opts.options),
                initialValue: opts.initialValue,
            })
        ),

    multiselect: async (opts: MultiSelectOpts) =>
        unwrap(
            await clack.multiselect({
                message: opts.message,
                options: toClackOptions(opts.options),
                required: opts.required ?? false,
                initialValues: opts.initialValues,
            })
        ),

    password: async (opts: PasswordOpts) =>
        unwrap(
            await clack.password({
                message: opts.message,
                // clack's validate is (string|undefined)=>string|Error|undefined;
                // adapt our (string)=>string|void.
                validate: opts.validate ? (v) => opts.validate?.(v ?? "") ?? undefined : undefined,
            })
        ),

    spinner: (): Spinner => {
        const spinner = clack.spinner(STDERR);
        return {
            start: (msg) => spinner.start(msg),
            stop: (msg) => spinner.stop(msg),
            message: (msg) => spinner.message(msg),
        };
    },

    // search: pre-load with opts.options("") to get the initial static item set,
    // then pass to searchSelect which has its own typed-query filter on the list.
    // Dynamic-filter behavior (re-fetching as user types) is not supported by
    // searchSelect's UX — it filters the initial snapshot instead.
    search: async <T>(opts: SearchOpts<T>): Promise<T> => {
        const items = await opts.options("");
        const result = await searchSelect<T>({
            message: opts.message,
            items,
        });

        if (typeof result === "symbol") {
            handleCancel();
        }

        return result as T;
    },

    editor: async (opts: EditorOpts): Promise<string> => {
        const editor = process.env.EDITOR ?? process.env.VISUAL;

        if (editor) {
            // PR #179 t13: use os.tmpdir() — /tmp doesn't exist on Windows.
            const tmpPath = join(tmpdir(), `clack-editor-${Date.now()}${opts.postfix ?? ".txt"}`);
            if (opts.initialValue !== undefined) {
                await Bun.write(tmpPath, opts.initialValue);
            }

            const proc = Bun.spawn([editor, tmpPath], {
                stdin: "inherit",
                stdout: "inherit",
                stderr: "inherit",
            });
            await proc.exited;

            const content = await Bun.file(tmpPath).text();
            // PR #179 t14: the previous `Bun.file().writer().end()` closes a
            // writer handle but does NOT delete the file — leaving stale
            // editor scratch files in tmpdir. Use unlinkSync to actually
            // remove the file. Wrapped in try/catch so a missing file (e.g.
            // editor moved it) doesn't propagate.
            try {
                unlinkSync(tmpPath);
            } catch {
                // ignore — file may have been moved/deleted by the editor
            }

            return content;
        }

        // PR #179 t15: $EDITOR-less fallback uses multilineText from
        // @app/utils/prompts/clack/multiline — gives the user a real
        // multi-line editing surface (Enter twice to submit) instead of a
        // single-line clack.text. Strictly better UX for "edit a message"
        // semantics that an editor prompt implies.
        return unwrap(
            await multilineText({
                message: `${opts.message} ${pc.dim("($EDITOR not set — multiline; press Enter twice to submit)")}`,
            })
        );
    },

    number: async (opts: NumberOpts): Promise<number> => {
        const raw = unwrap(
            await clack.text({
                message: opts.message,
                initialValue: opts.initialValue !== undefined ? String(opts.initialValue) : undefined,
                validate: (value) => {
                    // PR #179 t16: explicitly reject empty input — Number("")
                    // evaluates to 0 (a finite number), which would silently
                    // accept an empty submission. inquirerBackend requires
                    // input via its validate wrapper; match that semantic.
                    if (value === undefined || value.trim() === "") {
                        return "A number is required";
                    }

                    const n = Number(value);
                    if (!Number.isFinite(n)) {
                        return "Please enter a valid number";
                    }

                    if (opts.min !== undefined && n < opts.min) {
                        return `Must be ≥ ${opts.min}`;
                    }

                    if (opts.max !== undefined && n > opts.max) {
                        return `Must be ≤ ${opts.max}`;
                    }

                    if (opts.validate) {
                        return opts.validate(n);
                    }

                    return undefined;
                },
            })
        );

        return Number(raw);
    },

    log,
};
