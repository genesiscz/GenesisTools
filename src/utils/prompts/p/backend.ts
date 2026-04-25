import type {
    ConfirmOpts,
    Log,
    MultiSelectOpts,
    SelectOpts,
    SelectValue,
    Spinner,
    TextOpts,
    TypedConfirmOpts,
} from "./types";

export interface PromptBackend {
    intro(msg: string): void;
    outro(msg: string): void;
    cancel(msg: string): void;
    note(content: string, title?: string): void;

    text(opts: TextOpts): Promise<string>;
    confirm(opts: ConfirmOpts): Promise<boolean>;
    typedConfirm(opts: TypedConfirmOpts): Promise<boolean>;
    select(opts: SelectOpts): Promise<SelectValue>;
    multiselect(opts: MultiSelectOpts): Promise<SelectValue[]>;

    spinner(): Spinner;
    log: Log;
}

let active: PromptBackend | null = null;

export function setBackend(backend: PromptBackend): void {
    active = backend;
}

export function getBackend(): PromptBackend {
    if (!active) {
        throw new Error("p.* backend not set. Call setBackend(...) during startup.");
    }

    return active;
}
