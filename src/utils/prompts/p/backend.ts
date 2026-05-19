import { clackBackend } from "./clack-backend"; // STATIC: clack only, no opentui (verified separate file)
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
    password(opts: PasswordOpts): Promise<string>;

    spinner(): Spinner;
    log: Log;
}

// Default to clack at module load (advisor: getBackend stays SYNC — 700+
// sync p.log.*/p.spinner() callers; an async/buffered shim would reorder the
// first log line of every process). clack-backend.ts does not import @opentui
// (separate file), so the "no opentui/solid pulled" constraint holds.
let active: PromptBackend = clackBackend;

export function setBackend(backend: PromptBackend): void {
    active = backend; // doctor's plain/tui paths override the clack default
}

export function getBackend(): PromptBackend {
    return active;
}
