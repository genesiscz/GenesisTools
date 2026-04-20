import { handleCancel, isCancelled } from "@app/utils/prompts/clack/helpers";
import type { TextOptions } from "@clack/prompts";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import type { PromptBackend } from "./backend";
import type { Log, MultiSelectOpts, SelectOption, SelectOpts, Spinner, TextOpts, TypedConfirmOpts } from "./types";

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
    intro: (msg) => clack.intro(msg),
    outro: (msg) => clack.outro(msg),
    cancel: (msg) => clack.cancel(msg),
    note: (content, title) => clack.note(content, title),

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
