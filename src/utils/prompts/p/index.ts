import { getBackend, setBackend } from "./backend";
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

export { setBackend };
export type { PromptBackend } from "./backend";
export type * from "./types";

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

export function text(opts: TextOpts): Promise<string> {
    return getBackend().text(opts);
}

export function confirm(opts: ConfirmOpts): Promise<boolean> {
    return getBackend().confirm(opts);
}

export function typedConfirm(opts: TypedConfirmOpts): Promise<boolean> {
    return getBackend().typedConfirm(opts);
}

export function select(opts: SelectOpts): Promise<SelectValue> {
    return getBackend().select(opts);
}

export function multiselect(opts: MultiSelectOpts): Promise<SelectValue[]> {
    return getBackend().multiselect(opts);
}

export function spinner(): Spinner {
    return getBackend().spinner();
}

export const log: Log = {
    info: (msg) => getBackend().log.info(msg),
    success: (msg) => getBackend().log.success(msg),
    warn: (msg) => getBackend().log.warn(msg),
    error: (msg) => getBackend().log.error(msg),
    step: (msg) => getBackend().log.step(msg),
};

export type { OfferInstallOpts } from "./offer-install";
export { buildInstallPrompt, offerInstall } from "./offer-install";
