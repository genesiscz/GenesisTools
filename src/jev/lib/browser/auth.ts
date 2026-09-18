import type { BrowserObservation } from "./types";

export function authenticationBarrier(observation: BrowserObservation, inputs: Record<string, string>): boolean {
    const password = observation.candidates.some(
        (candidate) => candidate.fillable && /password|passwd/i.test(candidate.name)
    );
    if (!password) {
        return false;
    }
    return !Object.keys(inputs).some((key) => /password|passwd/i.test(key));
}

export function sameOrigin(start: string, next: string): boolean {
    try {
        const a = new URL(start);
        const b = new URL(next);
        return a.origin === b.origin;
    } catch {
        return false;
    }
}
