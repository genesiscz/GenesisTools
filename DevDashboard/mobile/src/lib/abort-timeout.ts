/**
 * `AbortSignal.timeout(ms)` is not implemented in Hermes (React Native's JS engine) — calling it
 * throws `AbortSignal.timeout is not a function`, which silently failed every transport reachability
 * probe. This helper uses the native implementation when present (web / future Hermes) and otherwise
 * falls back to an `AbortController` + `setTimeout`, which Hermes does support.
 */
export function timeoutSignal(ms: number): AbortSignal {
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
        return AbortSignal.timeout(ms);
    }

    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
}
