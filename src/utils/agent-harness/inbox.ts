import { SafeJSON } from "@genesiscz/utils/json";
import { AsyncQueue } from "./async-queue";
import { isReasoningEffort, type ReasoningEffort } from "./llm";

/**
 * Input deduplication for one session, ported from `harness/inbox`.
 *
 * An input carries a caller-supplied id that stays stable across redeliveries; the inbox
 * drops a repeat of an id it has seen (including ids restored from history) and hands the
 * rest to the coordinator in submission order.
 */

export type InputID = string;

export type InputKind = "external" | "control" | "crash";

/** `Payload` is raw JSON text, as in the Go `jsontext.Value`, so validity is checked, not assumed. */
export interface Input {
    ID: InputID;
    Kind: InputKind;
    Payload?: string;
}

export type ControlMode = "hard" | "when_idle" | "heartbeat" | "settings";

export interface Settings {
    ReasoningEffort?: ReasoningEffort;
}

export interface ControlMessage {
    Mode: ControlMode;
    Reason: string;
    Parameters?: Settings;
}

export class InputError extends Error {}

/** Strict: a payload is raw JSON text by contract, so comments and trailing commas are invalid here. */
export function parseJsonText(text: string): unknown {
    return SafeJSON.parse(text, { strict: true });
}

export function isValidJsonText(text: string): boolean {
    try {
        parseJsonText(text);
        return true;
    } catch {
        return false;
    }
}

function rejectUnknownMembers(value: Record<string, unknown>, allowed: string[], what: string): void {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) {
            throw new InputError(`decode ${what}: unknown name "${key}"`);
        }
    }
}

export function decodeControlMessage(input: Input): ControlMessage {
    if (input.Kind !== "control") {
        throw new InputError(`control message input has kind "${input.Kind}"`);
    }

    let envelope: unknown;

    try {
        envelope = parseJsonText(input.Payload ?? "");
    } catch (error) {
        throw new InputError(`decode control message: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
        throw new InputError("decode control message: not an object");
    }

    const record = envelope as Record<string, unknown>;
    rejectUnknownMembers(record, ["Mode", "Reason", "Parameters"], "control message");
    const mode = record.Mode;
    const reason = record.Reason;

    if (reason !== undefined && typeof reason !== "string") {
        throw new InputError("decode control message: Reason must be a string");
    }

    const request: ControlMessage = { Mode: mode as ControlMode, Reason: reason ?? "" };
    const hasParameters = record.Parameters !== undefined && record.Parameters !== null;

    if (mode !== "settings" && hasParameters) {
        throw new InputError(`control mode "${String(mode)}" does not accept parameters`);
    }

    switch (mode) {
        case "hard":
        case "when_idle":
            break;
        case "heartbeat":
            if (!request.Reason) {
                throw new InputError("heartbeat reason is empty");
            }
            break;
        case "settings": {
            const parameters = record.Parameters;

            if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) {
                throw new InputError("decode settings parameters: not an object");
            }

            rejectUnknownMembers(parameters as Record<string, unknown>, ["ReasoningEffort"], "settings parameters");
            const effort = (parameters as Record<string, unknown>).ReasoningEffort;

            if (!isReasoningEffort(effort)) {
                throw new InputError(`unsupported reasoning effort "${effort === undefined ? "" : String(effort)}"`);
            }

            request.Parameters = { ReasoningEffort: effort };
            break;
        }
        default:
            throw new InputError(`unsupported control mode "${String(mode)}"`);
    }

    return request;
}

export function validateInput(input: Input): void {
    if (!input.ID) {
        throw new InputError("input ID is empty");
    }

    switch (input.Kind) {
        case "external":
        case "crash":
            break;
        case "control":
            decodeControlMessage(input);
            break;
        default:
            throw new InputError(`input "${input.ID}" has unsupported kind "${String(input.Kind)}"`);
    }

    if (input.Payload !== undefined && !isValidJsonText(input.Payload)) {
        throw new InputError(`input "${input.ID}" payload is not valid JSON`);
    }
}

export interface Writer {
    submit(input: Input, signal?: AbortSignal): Promise<void>;
}

export class Inbox implements Writer {
    private readonly seen: Set<InputID>;
    private readonly output = new AsyncQueue<Input>();

    constructor(
        private readonly signal: AbortSignal,
        seenIDs: InputID[] = []
    ) {
        for (const id of seenIDs) {
            if (!id) {
                throw new InputError("seen input ID is empty");
            }
        }

        this.seen = new Set(seenIDs);
        signal.addEventListener("abort", () => this.output.close(), { once: true });

        if (signal.aborted) {
            this.output.close();
        }
    }

    async submit(input: Input, signal?: AbortSignal): Promise<void> {
        try {
            validateInput(input);
        } catch (error) {
            throw new InputError(`submit input: ${error instanceof Error ? error.message : String(error)}`);
        }

        if (signal?.aborted) {
            throw signal.reason ?? new Error("aborted");
        }

        if (this.signal.aborted) {
            throw this.signal.reason ?? new Error("inbox closed");
        }

        if (this.seen.has(input.ID)) {
            return;
        }

        this.seen.add(input.ID);
        this.output.push({ ...input });
    }

    outputQueue(): AsyncQueue<Input> {
        return this.output;
    }
}
