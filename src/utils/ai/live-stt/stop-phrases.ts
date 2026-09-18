import { normalizeUtterance } from "./wake-word";

export const STOP_PHRASES = ["stop", "cancel", "wait", "abort", "never mind"] as const;

export function isStopUtterance(text: string): boolean {
    const normalized = normalizeUtterance(text);
    return STOP_PHRASES.some((phrase) => normalized === phrase);
}
