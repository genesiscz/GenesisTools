import { createRequire } from "node:module";
import type {
    ConfirmOpts,
    EditorOpts,
    Log,
    MultiSelectOpts,
    NumberOpts,
    PasswordOpts,
    SearchOpts,
    SelectOpts,
    Spinner,
    TextOpts,
    TypedConfirmOpts,
} from "./types";

export interface PromptBackend {
    intro(msg: string): void;
    outro(msg: string): void;
    cancel(msg: string): void;
    note(content: string, title?: string): void;

    // A backend answers a cancelled prompt with `promptCancelSymbol` and never ends the process itself: the facade
    // (p/index.ts) applies the call's `cancel` outcome, so "exit" and "back" mean the same on every backend.
    text(opts: TextOpts): Promise<string | symbol>;
    confirm(opts: ConfirmOpts): Promise<boolean | symbol>;
    typedConfirm(opts: TypedConfirmOpts): Promise<boolean | symbol>;
    select<V>(opts: SelectOpts<V>): Promise<V | symbol>;
    multiselect<V>(opts: MultiSelectOpts<V>): Promise<V[] | symbol>;
    password(opts: PasswordOpts): Promise<string | symbol>;
    search<T>(opts: SearchOpts<T>): Promise<T | symbol>;
    editor(opts: EditorOpts): Promise<string | symbol>;
    number(opts: NumberOpts): Promise<number | symbol>;

    spinner(): Spinner;
    log: Log;
}

// Default to clack on the first getBackend() call (advisor: getBackend stays SYNC — 700+
// sync p.log.*/p.spinner() callers; an async/buffered shim would reorder the
// first log line of every process). clack-backend.ts does not import @opentui
// (separate file), so the "no opentui/solid pulled" constraint holds.
const requireLazy = createRequire(import.meta.url);
let active: PromptBackend | undefined;

export function setBackend(backend: PromptBackend): void {
    active = backend; // doctor's plain/tui paths override the clack default
}

export function getBackend(): PromptBackend {
    // lazy: saves ~9 ms cold import of @clack/prompts for every logger importer (tools ts imports analyze, 2026-10-01); require is synchronous, so the first log line keeps its order
    active ??= (requireLazy("./clack-backend") as { clackBackend: PromptBackend }).clackBackend;
    return active;
}
