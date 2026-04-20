import type { PromptTask, PromptTaskValue } from "@app/doctor/ui/tui/stores/prompt-store";
import { usePromptStore } from "@app/doctor/ui/tui/stores/prompt-store";
import type { PromptBackend } from "@app/utils/prompts/p/backend";
import type {
    ConfirmOpts,
    Log,
    MultiSelectOpts,
    SelectOpts,
    SelectValue,
    Spinner,
    TextOpts,
    TypedConfirmOpts,
} from "@app/utils/prompts/p/types";
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

function enqueue<T extends PromptTaskValue>(task: PromptTask, coerce: (value: PromptTaskValue) => T): Promise<T> {
    return new Promise<T>((resolve) => {
        resolvers.set(task.id, (value) => resolve(coerce(value)));
        usePromptStore.getState().enqueue(task);
    });
}

function isSelectValue(value: PromptTaskValue): value is SelectValue {
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function coerceText(value: PromptTaskValue): string {
    return typeof value === "string" ? value : "";
}

function coerceBoolean(value: PromptTaskValue): boolean {
    return value === true;
}

function coerceSelectValue(value: PromptTaskValue): SelectValue {
    if (isSelectValue(value)) {
        return value;
    }

    return "";
}

function coerceSelectValues(value: PromptTaskValue): SelectValue[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.filter((item): item is SelectValue => isSelectValue(item));
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
        error: (message) => logSink("error", message),
        step: (message) => logSink("step", message),
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
        select: (opts: SelectOpts) => enqueue({ id: nextTaskId(), type: "select", opts }, coerceSelectValue),
        multiselect: (opts: MultiSelectOpts) =>
            enqueue({ id: nextTaskId(), type: "multiselect", opts }, coerceSelectValues),

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

        log,
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
