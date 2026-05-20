import type { PromptBackend, SelectValue } from "@app/utils/prompts/p";
import { installPromptMock, setPromptBackend } from "@app/utils/testing/prompt-mock";

/**
 * mcp-manager-specific test backend.
 *
 * mcp-manager's commands use named response keys (selectedProvider,
 * inputServerName, selectedOldName, etc.) rather than positional dispatch
 * by prompt-method name. This file owns that key vocabulary; the rest of
 * the prompt-mock machinery is the shared `@app/utils/testing/prompt-mock`.
 *
 * Migration note: this file used to do `mock.module("@app/utils/prompts/p")`
 * directly, which leaked across test files via bun:test's worker-pool
 * reuse. It now drives the canonical `p.setBackend()` path through a
 * fake PromptBackend, which is per-process state with no module-cache
 * side effects.
 */

type MockResponses = Record<string, unknown>;

function getResponses(): MockResponses {
    return ((globalThis as Record<string, unknown>).__inquirerMockResponses as MockResponses) || {};
}

function checkErrors(keys: string[]): void {
    const responses = getResponses();
    for (const key of keys) {
        if (responses[key] instanceof Error) {
            throw responses[key];
        }
    }
}

/** Build a PromptBackend whose method outputs are driven by mcp-manager's
 *  response-key vocabulary. Pass to `installPromptMock(makeBackend(...))`. */
function makeMcpManagerBackend(): PromptBackend {
    return {
        intro: () => {},
        outro: () => {},
        cancel: () => {},
        note: () => {},

        text: async (config) => {
            const responses = getResponses();
            const inputKeys = [
                "inputServerName",
                "inputNewName",
                "inputCommand",
                "inputEnv",
                "inputHeaders",
                "inputVal",
                "newServerName",
            ];
            checkErrors(inputKeys);

            for (const key of inputKeys) {
                if (responses[key] !== undefined) {
                    return responses[key] as string;
                }
            }

            return ((config as { initialValue?: string }).initialValue ?? "") as string;
        },
        confirm: async () => {
            checkErrors(["confirmed"]);
            return (getResponses().confirmed as boolean) ?? false;
        },
        typedConfirm: async () => {
            checkErrors(["typedConfirmed"]);
            return (getResponses().typedConfirmed as boolean) ?? true;
        },
        select: async () => {
            checkErrors(["selectedProvider", "choice", "inputType"]);
            const r = getResponses();
            return (r.selectedProvider ?? r.choice ?? r.inputType ?? "") as SelectValue;
        },
        multiselect: async () => {
            checkErrors(["selectedProviders"]);
            return ((getResponses().selectedProviders as SelectValue[]) ?? []) as SelectValue[];
        },
        password: async () => {
            checkErrors(["password"]);
            return (getResponses().password as string) ?? "";
        },

        // The p.X facade migration (PR #176 t20+t21+t22 follow-up) routes
        // production search/editor/number through p — same response keys
        // the prior inquirerBackend.search mock used so fixtures keep working.
        search: async () => {
            checkErrors(["selectedOldName", "selectedServerName", "inputServerName"]);
            const r = getResponses();
            if (r.selectedOldName !== undefined) {
                return r.selectedOldName as never;
            }

            if (r.selectedServerName !== undefined) {
                return r.selectedServerName as never;
            }

            if (r.inputServerName !== undefined) {
                return r.inputServerName as never;
            }

            return "" as never;
        },
        editor: async () => {
            checkErrors(["editorContent"]);
            return (getResponses().editorContent as string) ?? "";
        },
        number: async (config) => {
            checkErrors(["numberValue"]);
            return ((getResponses().numberValue as number) ??
                (config as { initialValue?: number }).initialValue ??
                0) as number;
        },

        spinner: () => ({
            start: () => {},
            stop: () => {},
            message: () => {},
        }),

        log: {
            info: () => {},
            success: () => {},
            warn: () => {},
            warning: () => {},
            error: () => {},
            step: () => {},
            message: () => {},
        },
    };
}

/**
 * Setup prompt mocks for mcp-manager tests. Call this at the top of test
 * files before importing command modules. Equivalent to the old name —
 * kept for back-compat with existing test files.
 */
export function setupInquirerMock(): void {
    (globalThis as Record<string, unknown>).__inquirerMockResponses = { selectedProviders: ["claude"] };
    installPromptMock(makeMcpManagerBackend());
}

/**
 * Set mock responses for prompt functions. Keys (named by mcp-manager
 * test convention):
 *  - selectedProviders: string[]      — multiselect (provider list)
 *  - selectedProvider: string         — select (single provider)
 *  - choice: string                   — select (conflict resolution)
 *  - inputServerName: string          — search/text (server name)
 *  - selectedOldName: string          — search (server to rename)
 *  - inputNewName: string             — text (new server name)
 *  - inputCommand: string             — text (command)
 *  - inputEnv: string                 — text (environment vars)
 *  - inputHeaders: string             — text (HTTP headers)
 *  - inputType: string                — select (transport type)
 *  - confirmed: boolean               — confirm
 *  - newServerName: string            — text (when creating new server)
 *  - editorContent: string            — editor
 *  - numberValue: number              — number
 */
export function setMockResponses(responses: Record<string, unknown>): void {
    (globalThis as Record<string, unknown>).__inquirerMockResponses = responses;
    // Reinstall to refresh the backend's response source — `getResponses()`
    // reads globalThis on every call anyway, so this is belt-and-braces.
    setPromptBackend(makeMcpManagerBackend());
}

export function getMockResponses(): Record<string, unknown> {
    return getResponses();
}
