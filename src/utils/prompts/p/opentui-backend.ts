import type { PromptBackend } from "@genesiscz/utils/prompts/p/backend";
import type {
    ConfirmOpts,
    Log,
    MultiSelectOpts,
    PasswordOpts,
    SelectOption,
    SelectOpts,
    Spinner,
    TextOpts,
    TypedConfirmOpts,
} from "@genesiscz/utils/prompts/p/types";
import type { PromptTask, PromptTaskValue } from "@genesiscz/utils/tui/prompt-store";
import { usePromptStore } from "@genesiscz/utils/tui/prompt-store";
import type { CliRenderer } from "@opentui/core";

export interface LogEntry {
    level: "info" | "success" | "warn" | "error" | "step";
    message: string;
    timestamp: string;
}

const resolvers = new Map<string, (value: PromptTaskValue) => void>();
const logEntries: LogEntry[] = [];
const logSubscribers = new Set<(entries: LogEntry[]) => void>();

function nextTaskId(): string {
    return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function enqueue<T>(task: PromptTask, coerce: (value: PromptTaskValue) => T): Promise<T> {
    return new Promise<T>((resolve) => {
        resolvers.set(task.id, (value) => resolve(coerce(value)));
        usePromptStore.getState().enqueue(task);
    });
}

function coerceText(value: PromptTaskValue): string {
    return typeof value === "string" ? value : "";
}

function coerceBoolean(value: PromptTaskValue): boolean {
    return value === true;
}

/**
 * The prompt store holds primitive values, while a facade option may hold any value. The store gets each option's
 * index as its value, and the answer index maps back to the option's own value.
 */
function indexed<V>(options: SelectOption<V>[]): SelectOption[] {
    return options.map((option, index) => ({ value: index, label: option.label, hint: option.hint }));
}

function indexOfValue<V>(options: SelectOption<V>[], value: V | undefined): number | undefined {
    const index = options.findIndex((option) => option.value === value);
    return index >= 0 ? index : undefined;
}

function optionValues<V>(options: SelectOption<V>[], value: PromptTaskValue): V[] {
    const picked = Array.isArray(value) ? value : [value];
    return picked.flatMap((item) => (typeof item === "number" && options[item] ? [options[item].value] : []));
}

function optionValue<V>(options: SelectOption<V>[], value: PromptTaskValue): V {
    const [first] = optionValues(options, value);

    if (first === undefined && options.length > 0) {
        throw new Error("opentuiBackend select answered with no option");
    }

    return first;
}

export function completeTask(id: string, value: PromptTaskValue): void {
    const resolver = resolvers.get(id);

    if (!resolver) {
        return;
    }

    resolvers.delete(id);
    usePromptStore.getState().complete(id);
    resolver(value);
}

export function opentuiBackend(_renderer: CliRenderer): PromptBackend {
    const log: Log = {
        info: (message) => logSink("info", message),
        success: (message) => logSink("success", message),
        warn: (message) => logSink("warn", message),
        warning: (message) => logSink("warn", message),
        error: (message) => logSink("error", message),
        step: (message) => logSink("step", message),
        message: (message) => logSink("info", Array.isArray(message) ? message.join("\n") : message),
    };

    return {
        intro: (message) => logSink("info", `> ${message}`),
        outro: (message) => logSink("info", `OK ${message}`),
        cancel: (message) => logSink("warn", `CANCEL ${message}`),
        note: (content, title) => logSink("info", `${title ? `[${title}] ` : ""}${content}`),

        text: (opts: TextOpts) => enqueue({ id: nextTaskId(), type: "text", opts }, coerceText),
        confirm: (opts: ConfirmOpts) => enqueue({ id: nextTaskId(), type: "confirm", opts }, coerceBoolean),
        typedConfirm: (opts: TypedConfirmOpts) =>
            enqueue({ id: nextTaskId(), type: "typedConfirm", opts }, coerceBoolean),
        // opentui is doctor-only and its renderer has no password widget; route
        // through the text prompt (no visual masking — out of scope for the
        // logger/out overhaul, which never touches the opentui renderer).
        // opentui is doctor-only with no password widget; route through the
        // text prompt. validate is intentionally dropped here — opentui TUI
        // validation is renderer scope, out of the logger/out overhaul; the
        // clack default (the real backend) does honor PasswordOpts.validate.
        password: (opts: PasswordOpts) =>
            enqueue({ id: nextTaskId(), type: "text", opts: { message: opts.message } }, coerceText),
        select: <V>(opts: SelectOpts<V>) =>
            enqueue(
                {
                    id: nextTaskId(),
                    type: "select",
                    opts: {
                        message: opts.message,
                        options: indexed(opts.options),
                        initialValue: indexOfValue(opts.options, opts.initialValue),
                    },
                },
                (value) => optionValue(opts.options, value)
            ),
        multiselect: <V>(opts: MultiSelectOpts<V>) =>
            enqueue(
                {
                    id: nextTaskId(),
                    type: "multiselect",
                    opts: {
                        message: opts.message,
                        options: indexed(opts.options),
                        required: opts.required,
                        initialValues: opts.initialValues?.flatMap((v) => indexOfValue(opts.options, v) ?? []),
                    },
                },
                (value) => optionValues(opts.options, value)
            ),

        spinner: (): Spinner => {
            let message = "";

            return {
                start: (nextMessage) => {
                    message = nextMessage ?? "";
                    logSink("info", `... ${message}`);
                },
                stop: (nextMessage) => {
                    logSink("success", `OK ${nextMessage ?? message}`);
                },
                message: (nextMessage) => {
                    message = nextMessage;
                    logSink("info", `... ${message}`);
                },
            };
        },

        // search/editor/number are not supported in the opentui TUI renderer.
        // The doctor tool (the only opentui consumer) does not use these prompts.
        search: makeUnsupported("search"),
        editor: makeUnsupported("editor"),
        number: makeUnsupported("number"),

        log,
    };
}

function makeUnsupported(method: string): () => never {
    return () => {
        throw new Error(`opentuiBackend does not support "${method}" — use clackBackend or implement a TUI widget`);
    };
}

function logSink(level: LogEntry["level"], message: string): void {
    logEntries.push({ level, message, timestamp: new Date().toISOString() });

    if (logEntries.length > 200) {
        logEntries.shift();
    }

    for (const subscriber of logSubscribers) {
        subscriber([...logEntries]);
    }
}

export function subscribeToLogs(callback: (entries: LogEntry[]) => void): () => void {
    logSubscribers.add(callback);
    callback([...logEntries]);
    return () => {
        logSubscribers.delete(callback);
    };
}
