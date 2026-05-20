import { isInteractive } from "@app/utils/cli";
import { checkbox, confirm, editor, input, number, password, search, select } from "@inquirer/prompts";
import pc from "picocolors";

import type { PromptBackend } from "./backend";
import type {
    ConfirmOpts,
    EditorOpts,
    Log,
    MultiSelectOpts,
    NumberOpts,
    PasswordOpts,
    SearchOpts,
    SelectOpts,
    SelectValue,
    Spinner,
    TextOpts,
    TypedConfirmOpts,
} from "./types";

/**
 * Compatibility alias kept for external imports (mcp-manager mock + the public
 * re-export from p/index.ts). After the canonical search/editor/number landed
 * directly on PromptBackend (Agent B), inquirerBackend has nothing extra —
 * it's a PromptBackend implementation backed by @inquirer/prompts.
 */
export type InquirerBackend = PromptBackend;

function writeStderr(msg: string): void {
    process.stderr.write(`${msg}\n`);
}

function exitOnCancel(err: unknown): never {
    if (err instanceof Error && err.name === "ExitPromptError") {
        writeStderr(pc.red("Operation cancelled"));
        process.exit(0);
    }

    throw err;
}

const log: Log = {
    info: (msg) => writeStderr(`${pc.cyan("ℹ")} ${msg}`),
    success: (msg) => writeStderr(`${pc.green("✔")} ${msg}`),
    warn: (msg) => writeStderr(`${pc.yellow("⚠")} ${msg}`),
    warning: (msg) => writeStderr(`${pc.yellow("⚠")} ${msg}`),
    error: (msg) => writeStderr(`${pc.red("✘")} ${msg}`),
    step: (msg) => writeStderr(`${pc.cyan("❯")} ${msg}`),
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

async function searchImpl<T>(opts: SearchOpts<T>): Promise<T> {
    if (!isInteractive()) {
        writeStderr(`${pc.red("✘")} search prompt requires an interactive terminal`);
        process.exit(1);
    }

    try {
        // PromptBackend.search uses { value, label, hint }; inquirer's source
        // callback shape is { value, name, description }. Adapt at the boundary.
        const result = await search<T>({
            message: opts.message,
            source: async (term) => {
                const items = await opts.options(term ?? "");
                return items.map((i) => ({ value: i.value, name: i.label, description: i.hint }));
            },
            ...(opts.pageSize !== undefined ? { pageSize: opts.pageSize } : {}),
        });

        return result;
    } catch (err) {
        exitOnCancel(err);
    }
}

async function editorImpl(opts: EditorOpts): Promise<string> {
    if (!isInteractive()) {
        writeStderr(`${pc.red("✘")} editor prompt requires an interactive terminal`);
        process.exit(1);
    }

    try {
        const result = await editor({
            message: opts.message,
            default: opts.initialValue,
            postfix: opts.postfix,
        });

        return result;
    } catch (err) {
        exitOnCancel(err);
    }
}

async function numberImpl(opts: NumberOpts): Promise<number> {
    if (!isInteractive()) {
        writeStderr(`${pc.red("✘")} number prompt requires an interactive terminal`);
        process.exit(1);
    }

    try {
        // Inquirer's number prompt validate returns string | boolean | Promise<…>.
        // PromptBackend.NumberOpts.validate returns string | undefined (string =
        // error, undefined = ok). Bridge the two so the canonical type works.
        // Also wrap the required check: inquirer can return undefined if input
        // is empty AND no default — we require a value so the canonical return
        // type Promise<number> is honored.
        const result = await number({
            message: opts.message,
            default: opts.initialValue,
            min: opts.min,
            max: opts.max,
            validate: (v) => {
                if (v === undefined) {
                    return "A number is required";
                }
                if (opts.validate) {
                    const err = opts.validate(v);
                    return err === undefined ? true : err;
                }
                return true;
            },
        });

        // validate guarantees non-undefined at acceptance
        return result as number;
    } catch (err) {
        exitOnCancel(err);
    }
}

export const inquirerBackend: InquirerBackend = {
    intro: (msg) => writeStderr(pc.bold(`${pc.cyan("◆")} ${msg}`)),
    outro: (msg) => writeStderr(pc.bold(`${pc.green("◆")} ${msg}`)),
    cancel: (msg) => writeStderr(`${pc.red("■")} ${msg}`),
    note: (content, title?) => {
        const border = pc.dim("─".repeat(40));
        const lines = [border, title ? pc.bold(title) : "", content, border].filter((l) => l !== "");
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
