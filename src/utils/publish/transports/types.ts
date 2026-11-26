import type { PublishTarget, TargetWith, TransportKind } from "../targets";
import { isHttpUrl } from "../targets";

export interface SetupPrompt {
    flag: string;
    message: string;
    initial?: string;
    validate?: (value: string) => string | undefined;
}

export type SetupAsk = (prompt: SetupPrompt) => Promise<string>;

export interface TransportSetupInput {
    name: string;
    values: Partial<Record<string, string>>;
    ask: SetupAsk;
}

export class MissingSetupValueError extends Error {
    constructor(readonly flag: string) {
        super(`--${flag} is required`);
    }
}

export interface TransportCheck {
    label: string;
    ok: boolean;
    detail: string;
}

export interface PublishTransport {
    readonly kind: TransportKind;
    readonly summary: string;
    /** This target serves the source itself and has no snapshot to sync. */
    readonly live: boolean;
    pageUrl(input: { target: PublishTarget; kind: string; id: string }): string | null;
    send(input: { target: PublishTarget; kind: string; id: string; dir: string }): Promise<void>;
    remove(input: { target: PublishTarget; kind: string; id: string }): Promise<void>;
    /** Null if this transport cannot list snapshots. */
    list(input: { target: PublishTarget; kind: string }): Promise<string[] | null>;
    check(target: PublishTarget): Promise<TransportCheck[]>;
    setup(input: TransportSetupInput): Promise<PublishTarget>;
    forget(target: PublishTarget): Promise<void>;
}

export function targetWith<K extends TransportKind>(target: PublishTarget, kind: K): TargetWith<K> {
    if (target.transport.kind !== kind) {
        throw new Error(`publish target "${target.name}" uses ${target.transport.kind}, not ${kind}`);
    }

    return target as TargetWith<K>;
}

export async function setupValue(input: TransportSetupInput, prompt: SetupPrompt): Promise<string> {
    const raw = input.values[prompt.flag]?.trim();
    const given = (raw || (await input.ask(prompt))).trim();
    const problem = prompt.validate?.(given);
    if (problem) {
        throw new Error(`--${prompt.flag}: ${problem}`);
    }

    return given;
}

export function validateUrl(value: string): string | undefined {
    return URL.canParse(value) && isHttpUrl(new URL(value)) ? undefined : "an HTTP(S) URL without credentials";
}
