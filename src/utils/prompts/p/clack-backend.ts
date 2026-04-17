import * as clack from "@clack/prompts";
import { handleCancel, isCancelled } from "@app/utils/prompts/clack/helpers";
import pc from "picocolors";
import type { PromptBackend } from "./backend";
import type { Log, MultiSelectOpts, SelectOpts, Spinner, TextOpts, TypedConfirmOpts } from "./types";

function unwrap<T>(result: T | symbol): T {
    if (isCancelled(result)) {
        handleCancel();
    }

    return result as T;
}

const log: Log = {
    info: (msg) => clack.log.info(msg),
    success: (msg) => clack.log.success(msg),
    warn: (msg) => clack.log.warn(msg),
    error: (msg) => clack.log.error(msg),
    step: (msg) => clack.log.step(msg),
};

async function typedConfirmImpl(opts: TypedConfirmOpts): Promise<boolean> {
    const expected = opts.caseSensitive === false ? opts.phrase.toLowerCase() : opts.phrase;
    const typed = unwrap(
        await clack.text({
            message: `${opts.message} ${pc.dim(`(type "${opts.phrase}" to confirm)`)}`,
            placeholder: opts.phrase,
            validate: (value) => {
                const compared = opts.caseSensitive === false ? value.toLowerCase() : value;
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
    intro: (msg) => clack.intro(msg),
    outro: (msg) => clack.outro(msg),
    cancel: (msg) => clack.cancel(msg),
    note: (content, title) => clack.note(content, title),

    text: async (opts: TextOpts) => unwrap(await clack.text(opts)),

    confirm: async (opts) => {
        const message = opts.danger ? pc.red(opts.message) : opts.message;
        return unwrap(await clack.confirm({ message, initialValue: opts.initialValue }));
    },

    typedConfirm: typedConfirmImpl,

    select: async <T>(opts: SelectOpts<T>) =>
        unwrap(
            await clack.select({
                message: opts.message,
                options: opts.options.map((option) => ({
                    value: option.value,
                    label: option.label,
                    hint: option.hint,
                })),
                initialValue: opts.initialValue,
            })
        ),

    multiselect: async <T>(opts: MultiSelectOpts<T>) =>
        unwrap(
            await clack.multiselect({
                message: opts.message,
                options: opts.options.map((option) => ({
                    value: option.value,
                    label: option.label,
                    hint: option.hint,
                })),
                required: opts.required ?? false,
                initialValues: opts.initialValues,
            })
        ),

    spinner: (): Spinner => {
        const spinner = clack.spinner();
        return {
            start: (msg) => spinner.start(msg),
            stop: (msg) => spinner.stop(msg),
            message: (msg) => spinner.message(msg),
        };
    },

    log,
};
