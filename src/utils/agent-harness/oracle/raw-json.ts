import { SafeJSON } from "@genesiscz/utils/json";
import type { Input } from "../inbox";
import type { Item as LlmItem, Reasoning, Request, Response } from "../llm";
import type { Operation, Spec } from "../operation";
import type { Item, ResumeState } from "../sessionstore";
import type { Definition } from "../tool";

/**
 * Go keeps raw JSON (`jsontext.Value`) in `Input.Payload`, `Operation.State`/`Idempotency`,
 * `Spec.State`/`Idempotency`, `Definition.Metadata`, `Usage.Raw` and `Reasoning.Raw`; the port keeps
 * those as JSON text in strings. On the wire Go expects the value embedded, so the bridge parses the
 * port's text on the way in and re-serializes on the way out.
 */

export function rawToGo(text: string | undefined): unknown {
    return text === undefined || text === "" ? undefined : SafeJSON.parse(text, { strict: true });
}

export function rawFromGo(value: unknown): string | undefined {
    return value === undefined || value === null ? undefined : SafeJSON.stringify(value, { strict: true });
}

type Loose<T> = { [K in keyof T]: unknown };

function withRaw<T extends object, K extends keyof T>(value: T, key: K, convert: (raw: unknown) => unknown): T {
    if (!(key in value) || value[key] === undefined) {
        return value;
    }

    const converted = convert(value[key]);
    const copy: Loose<T> = { ...value };

    if (converted === undefined) {
        delete copy[key];
    } else {
        copy[key] = converted;
    }

    return copy as T;
}

const toGoText = (raw: unknown) => rawToGo(raw as string | undefined);
const fromGoValue = (raw: unknown) => rawFromGo(raw);

export function reasoningFromGo(reasoning: Reasoning): Reasoning {
    return withRaw(reasoning, "Raw", fromGoValue);
}

export function inputToGo(input: Input): Input {
    return withRaw(input, "Payload", toGoText);
}

export function inputFromGo(input: Input): Input {
    return withRaw(input, "Payload", fromGoValue);
}

export function operationToGo(operation: Operation): Operation {
    return withRaw(withRaw(operation, "State", toGoText), "Idempotency", toGoText);
}

export function operationFromGo(operation: Operation): Operation {
    return withRaw(withRaw(operation, "State", fromGoValue), "Idempotency", fromGoValue);
}

export function specToGo(spec: Spec): Spec {
    return withRaw(withRaw(spec, "State", toGoText), "Idempotency", toGoText);
}

export function definitionToGo(definition: Definition): Definition {
    return withRaw(definition, "Metadata", toGoText);
}

function llmItemConvert(item: LlmItem, convert: (raw: unknown) => unknown): LlmItem {
    if (item.Type !== "reasoning") {
        return item;
    }

    return { ...item, Data: withRaw(item.Data, "Raw", convert) };
}

/**
 * Go encodes every struct field, so an item carries `ProviderID: ""` and a message `Phase: ""`
 * where the port leaves the optional field out. Dropped on the way back so `toEqual` twins
 * compare the same shape.
 */
function llmItemFromGo(item: LlmItem): LlmItem {
    const converted = llmItemConvert(item, fromGoValue);
    const { ProviderID, ...rest } = converted;
    const withoutProvider = ProviderID === "" ? (rest as LlmItem) : converted;

    if (withoutProvider.Type === "message" && withoutProvider.Data.Phase === "") {
        const { Phase, ...message } = withoutProvider.Data;
        return { ...withoutProvider, Data: message };
    }

    return withoutProvider;
}

export function responseToGo(response: Response): Response {
    return {
        ...response,
        Usage: withRaw(response.Usage, "Raw", toGoText),
        ...(response.Output ? { Output: response.Output.map((item) => llmItemConvert(item, toGoText)) } : {}),
    };
}

/** Drops the keys Go encodes for an unset optional field (nil pointer, empty string). */
function withoutZero<T extends object>(value: T, keys: Array<keyof T>): T {
    const copy = { ...value };

    for (const key of keys) {
        if (copy[key] === null || copy[key] === undefined || copy[key] === "") {
            delete copy[key];
        }
    }

    return copy;
}

export function responseFromGo(response: Response): Response {
    return withoutZero(
        {
            ...response,
            Usage: withRaw(response.Usage, "Raw", fromGoValue),
            ...(response.Output ? { Output: response.Output.map(llmItemFromGo) } : {}),
        },
        ["Failure"]
    );
}

export function requestToGo(request: Request): Request {
    return { ...request, Input: request.Input.map((item) => llmItemConvert(item, toGoText)) };
}

export function requestFromGo(request: Request): Request {
    return {
        ...request,
        Model: withoutZero(request.Model, ["MaxOutputTokens", "ReasoningEffort"]),
        Input: request.Input.map(llmItemFromGo),
    };
}

/** A session item as the Go store reads it (restore replays these). */
export function itemToGo(item: Item): Item {
    switch (item.Kind) {
        case "input":
            return { ...item, Data: inputToGo(item.Data) };
        case "model_response":
            return { ...item, Data: { ...item.Data, Response: responseToGo(item.Data.Response) } };
        case "tool_call_status":
            return item.Data.Operations
                ? { ...item, Data: { ...item.Data, Operations: item.Data.Operations.map(operationToGo) } }
                : item;
        default:
            return item;
    }
}

export function resumeToGo(state: ResumeState): ResumeState {
    return { ...state, Operations: state.Operations.map(operationToGo) };
}
