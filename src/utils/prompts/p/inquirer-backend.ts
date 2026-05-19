import { isInteractive } from "@app/utils/cli";
import { checkbox, confirm, editor, input, number, password, search, select } from "@inquirer/prompts";
import pc from "picocolors";

import type { PromptBackend } from "./backend";
import type {
    ConfirmOpts,
    Log,
    MultiSelectOpts,
    PasswordOpts,
    SelectOpts,
    SelectValue,
    Spinner,
    TextOpts,
    TypedConfirmOpts,
} from "./types";

/** Additional prompt methods not in PromptBackend, for inquirer-specific consumers. */
export interface InquirerExtras {
    search<T>(opts: { message: string; source: (term?: string) => Promise<{ value: T; name: string }[]>; pageSize?: number }): Promise<T>;
    editor(opts: { message: string; default?: string }): Promise<string>;
    number(opts: { message: string; default?: number; min?: number; max?: number }): Promise<number | undefined>;
}

export type InquirerBackend = PromptBackend & InquirerExtras;

function writeStderr(msg: string): void {
    process.stderr.write(msg + "\n");
}

function exitOnCancel(err: unknown): never {
    if (err instanceof Error && err.name === "ExitPromptError") {
        writeStderr(pc.red("Operation cancelled"));
        process.exit(0);
    }

    throw err;
}

const log: Log = {
    info: (msg) => writeStderr(pc.cyan("ℹ") + " " + msg),
    success: (msg) => writeStderr(pc.green("✔") + " " + msg),
    warn: (msg) => writeStderr(pc.yellow("⚠") + " " + msg),
    warning: (msg) => writeStderr(pc.yellow("⚠") + " " + msg),
    error: (msg) => writeStderr(pc.red("✘") + " " + msg),
    step: (msg) => writeStderr(pc.cyan("❯") + " " + msg),
    message: (msg) => writeStderr(Array.isArray(msg) ? msg.join("\n") : msg),
};

const noopSpinner: Spinner = {
    start: (_msg?: string) => {},
    stop: (_msg?: string) => {},
    message: (_msg: string) => {},
};

async function textImpl(opts: TextOpts): Promise<string> {
    try {
        const result = await input({
            message: opts.message,
            default: opts.initialValue,
            validate: opts.validate
                ? (value: string) => {
                      const err = opts.validate!(value);
                      return err !== undefined ? err : true;
                  }
                : undefined,
        });

        return result;
    } catch (err) {
        exitOnCancel(err);
    }
}

async function confirmImpl(opts: ConfirmOpts): Promise<boolean> {
    try {
        const message = opts.danger ? pc.red(opts.message) : opts.message;

        const result = await confirm({
            message,
            default: opts.initialValue,
        });

        return result;
    } catch (err) {
        exitOnCancel(err);
    }
}

async function typedConfirmImpl(opts: TypedConfirmOpts): Promise<boolean> {
    const expected = opts.caseSensitive === false ? opts.phrase.toLowerCase() : opts.phrase;

    try {
        const result = await input({
            message: `${opts.message} ${pc.dim(`(type "${opts.phrase}" to confirm)`)}`,
            validate: (value: string) => {
                const compared = opts.caseSensitive === false ? value.toLowerCase() : value;

                if (compared !== expected) {
                    return `Must type exactly: ${opts.phrase}`;
                }

                return true;
            },
        });

        const compared = opts.caseSensitive === false ? result.toLowerCase() : result;
        return compared === expected;
    } catch (err) {
        exitOnCancel(err);
    }
}

async function selectImpl(opts: SelectOpts): Promise<SelectValue> {
    try {
        const result = await select({
            message: opts.message,
            choices: opts.options.map((o) => ({
                name: o.label,
                value: o.value,
                description: o.hint,
            })),
            default: opts.initialValue,
        });

        return result as SelectValue;
    } catch (err) {
        exitOnCancel(err);
    }
}

async function multiselectImpl(opts: MultiSelectOpts): Promise<SelectValue[]> {
    try {
        const result = await checkbox({
            message: opts.message,
            choices: opts.options.map((o) => ({
                name: o.label,
                value: o.value,
                description: o.hint,
            })),
            required: opts.required,
        });

        return result as SelectValue[];
    } catch (err) {
        exitOnCancel(err);
    }
}

async function passwordImpl(opts: PasswordOpts): Promise<string> {
    try {
        const result = await password({
            message: opts.message,
            mask: "*",
            validate: opts.validate
                ? (value: string) => {
                      const err = opts.validate!(value);
                      return err !== undefined ? err : true;
                  }
                : undefined,
        });

        return result;
    } catch (err) {
        exitOnCancel(err);
    }
}

async function searchImpl<T>(opts: {
    message: string;
    source: (term?: string) => Promise<{ value: T; name: string }[]>;
    pageSize?: number;
}): Promise<T> {
    if (!isInteractive()) {
        writeStderr(pc.red("✘") + " search prompt requires an interactive terminal");
        process.exit(1);
    }

    try {
        const result = await search<T>({
            message: opts.message,
            source: opts.source,
            pageSize: opts.pageSize,
        });

        return result;
    } catch (err) {
        exitOnCancel(err);
    }
}

async function editorImpl(opts: { message: string; default?: string }): Promise<string> {
    if (!isInteractive()) {
        writeStderr(pc.red("✘") + " editor prompt requires an interactive terminal");
        process.exit(1);
    }

    try {
        const result = await editor({
            message: opts.message,
            default: opts.default,
        });

        return result;
    } catch (err) {
        exitOnCancel(err);
    }
}

async function numberImpl(opts: {
    message: string;
    default?: number;
    min?: number;
    max?: number;
}): Promise<number | undefined> {
    if (!isInteractive()) {
        writeStderr(pc.red("✘") + " number prompt requires an interactive terminal");
        process.exit(1);
    }

    try {
        const result = await number({
            message: opts.message,
            default: opts.default,
            min: opts.min,
            max: opts.max,
        });

        return result;
    } catch (err) {
        exitOnCancel(err);
    }
}

export const inquirerBackend: InquirerBackend = {
    intro: (msg) => writeStderr(pc.bold(pc.cyan("◆") + " " + msg)),
    outro: (msg) => writeStderr(pc.bold(pc.green("◆") + " " + msg)),
    cancel: (msg) => writeStderr(pc.red("■") + " " + msg),
    note: (content, title?) => {
        const border = pc.dim("─".repeat(40));
        const lines = [
            border,
            title ? pc.bold(title) : "",
            content,
            border,
        ].filter((l) => l !== "");
        writeStderr(lines.join("\n"));
    },

    text: textImpl,
    confirm: confirmImpl,
    typedConfirm: typedConfirmImpl,
    select: selectImpl,
    multiselect: multiselectImpl,
    password: passwordImpl,

    spinner: () => noopSpinner,
    log,

    search: searchImpl,
    editor: editorImpl,
    number: numberImpl,
};
