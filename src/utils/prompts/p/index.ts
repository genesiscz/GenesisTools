import type {
    ProgressOptions,
    ProgressResult,
    PromptGroup,
    PromptGroupAwaitedReturn,
    PromptGroupOptions,
} from "@clack/prompts";
import * as clack from "@clack/prompts";
import { isCancelled } from "@genesiscz/utils/prompts/clack/helpers";
import { getBackend, setBackend } from "./backend";
import { settle } from "./settle";
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

// tableSelect and inquirerBackend are deliberately NOT value-re-exported:
// both pulled their whole implementation (clack table renderer, all of
// @inquirer/prompts) into every `import * as p` at module load. Import them
// from their own subpaths instead; the type re-exports below stay free.
export type {
    TableSelectColumn,
    TableSelectOptions,
    TableSelectRow,
} from "@genesiscz/utils/prompts/clack/table-select";
export type { PromptBackend } from "./backend";
export type { InquirerBackend } from "./inquirer-backend";
export type * from "./types";
export { setBackend };

/** Any option value. Listing the primitives keeps a literal option value ("text") as its literal type, as clack does. */
type LiteralValue = string | number | boolean | bigint | symbol | object | null | undefined;

/**
 * True for a cancelled answer: the facade's `promptCancelSymbol` (a prompt called with `cancel: "back"`), clack's
 * own symbol (a custom prompt from `@genesiscz/utils/prompts/clack`) or the light input's.
 */
export function isCancel(value: unknown): value is symbol {
    return isCancelled(value);
}

export function intro(msg: string): void {
    getBackend().intro(msg);
}

export function outro(msg: string): void {
    getBackend().outro(msg);
}

export function cancel(msg: string): void {
    getBackend().cancel(msg);
}

export function note(content: string, title?: string): void {
    getBackend().note(content, title);
}

export function text(opts: TextOpts & { cancel: "back" }): Promise<string | symbol>;
export function text(opts: TextOpts & { cancel?: "exit" }): Promise<string>;
export function text(opts: TextOpts): Promise<string | symbol>;
export async function text(opts: TextOpts): Promise<string | symbol> {
    return settle(await getBackend().text(opts), opts.cancel);
}

export function confirm(opts: ConfirmOpts & { cancel: "back" }): Promise<boolean | symbol>;
export function confirm(opts: ConfirmOpts & { cancel?: "exit" }): Promise<boolean>;
export function confirm(opts: ConfirmOpts): Promise<boolean | symbol>;
export async function confirm(opts: ConfirmOpts): Promise<boolean | symbol> {
    return settle(await getBackend().confirm(opts), opts.cancel);
}

export function typedConfirm(opts: TypedConfirmOpts & { cancel: "back" }): Promise<boolean | symbol>;
export function typedConfirm(opts: TypedConfirmOpts & { cancel?: "exit" }): Promise<boolean>;
export function typedConfirm(opts: TypedConfirmOpts): Promise<boolean | symbol>;
export async function typedConfirm(opts: TypedConfirmOpts): Promise<boolean | symbol> {
    return settle(await getBackend().typedConfirm(opts), opts.cancel);
}

export function select<V extends LiteralValue>(opts: SelectOpts<V> & { cancel: "back" }): Promise<V | symbol>;
export function select<V extends LiteralValue>(opts: SelectOpts<V> & { cancel?: "exit" }): Promise<V>;
export function select<V extends LiteralValue>(opts: SelectOpts<V>): Promise<V | symbol>;
export async function select<V extends LiteralValue>(opts: SelectOpts<V>): Promise<V | symbol> {
    return settle(await getBackend().select(opts), opts.cancel);
}

export function multiselect<V extends LiteralValue>(
    opts: MultiSelectOpts<V> & { cancel: "back" }
): Promise<V[] | symbol>;
export function multiselect<V extends LiteralValue>(opts: MultiSelectOpts<V> & { cancel?: "exit" }): Promise<V[]>;
export function multiselect<V extends LiteralValue>(opts: MultiSelectOpts<V>): Promise<V[] | symbol>;
export async function multiselect<V extends LiteralValue>(opts: MultiSelectOpts<V>): Promise<V[] | symbol> {
    return settle(await getBackend().multiselect(opts), opts.cancel);
}

export function password(opts: PasswordOpts & { cancel: "back" }): Promise<string | symbol>;
export function password(opts: PasswordOpts & { cancel?: "exit" }): Promise<string>;
export function password(opts: PasswordOpts): Promise<string | symbol>;
export async function password(opts: PasswordOpts): Promise<string | symbol> {
    return settle(await getBackend().password(opts), opts.cancel);
}

export function search<T>(opts: SearchOpts<T> & { cancel: "back" }): Promise<T | symbol>;
export function search<T>(opts: SearchOpts<T> & { cancel?: "exit" }): Promise<T>;
export function search<T>(opts: SearchOpts<T>): Promise<T | symbol>;
export async function search<T>(opts: SearchOpts<T>): Promise<T | symbol> {
    return settle(await getBackend().search(opts), opts.cancel);
}

export function editor(opts: EditorOpts & { cancel: "back" }): Promise<string | symbol>;
export function editor(opts: EditorOpts & { cancel?: "exit" }): Promise<string>;
export function editor(opts: EditorOpts): Promise<string | symbol>;
export async function editor(opts: EditorOpts): Promise<string | symbol> {
    return settle(await getBackend().editor(opts), opts.cancel);
}

export function number(opts: NumberOpts & { cancel: "back" }): Promise<number | symbol>;
export function number(opts: NumberOpts & { cancel?: "exit" }): Promise<number>;
export function number(opts: NumberOpts): Promise<number | symbol>;
export async function number(opts: NumberOpts): Promise<number | symbol> {
    return settle(await getBackend().number(opts), opts.cancel);
}

export function spinner(): Spinner {
    return getBackend().spinner();
}

export const log: Log = {
    info: (msg) => getBackend().log.info(msg),
    success: (msg) => getBackend().log.success(msg),
    warn: (msg) => getBackend().log.warn(msg),
    warning: (msg) => getBackend().log.warning(msg),
    error: (msg) => getBackend().log.error(msg),
    step: (msg) => getBackend().log.step(msg),
    message: (msg) => getBackend().log.message(msg),
};

/**
 * Prompts shown one after another, each given the answers so far. A cancelled answer (a prompt called with
 * `cancel: "back"`) calls `opts.onCancel` and is stored as "canceled", as clack's own group does.
 */
export async function group<T>(
    prompts: PromptGroup<T>,
    opts?: PromptGroupOptions<T>
): Promise<PromptGroupAwaitedReturn<T>> {
    const results: Partial<PromptGroupAwaitedReturn<T>> = {};

    for (const name of Object.keys(prompts) as (keyof T & string)[]) {
        const answer = await prompts[name]({ results });

        if (opts?.onCancel && isCancel(answer)) {
            Object.assign(results, { [name]: "canceled" });
            opts.onCancel({ results });
            continue;
        }

        Object.assign(results, { [name]: answer });
    }

    // Every key of `prompts` now has its answer.
    return results as PromptGroupAwaitedReturn<T>;
}

/** A progress bar; clack draws it on every backend, on stderr like the backends' other non-prompt output. */
export function progress(opts?: ProgressOptions): ProgressResult {
    return clack.progress({ output: process.stderr, ...opts });
}

export type { OfferInstallOpts } from "./offer-install";
export { buildInstallPrompt, offerInstall } from "./offer-install";
