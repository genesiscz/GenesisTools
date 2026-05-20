import { mock } from "bun:test";
import * as cliUtils from "@app/utils/cli";

type MockResponses = Record<string, unknown>;

function getResponses(): MockResponses {
    return ((globalThis as Record<string, unknown>).__inquirerMockResponses as MockResponses) || {};
}

/**
 * Setup prompt mocks for mcp-manager tests.
 * Mocks @app/utils/prompts/p (p.select, p.multiselect, p.text, p.confirm) and
 * @app/utils/prompts/p/inquirer-backend (inquirerBackend.search).
 *
 * Call this at the top of test files before importing command modules.
 */
export function setupInquirerMock(): void {
    // Use globalThis to store mock responses so the mock can access them
    (globalThis as Record<string, unknown>).__inquirerMockResponses = { selectedProviders: ["claude"] };

    // Commands gate every interactive prompt behind isInteractive() (TTY check),
    // which is false under `bun test`. Without forcing it true, the commands
    // take their non-interactive `process.exit(1)` branch instead of the
    // mocked-prompt path these tests exercise. Re-export the real module so
    // suggestCommand/Executor/etc. keep working; only isInteractive is stubbed.
    mock.module("@app/utils/cli", () => ({
        ...cliUtils,
        isInteractive: () => true,
    }));

    // Mock p.* functions (text, select, multiselect, confirm)
    mock.module("@app/utils/prompts/p", () => ({
        setBackend: () => {},
        isCancel: () => false,
        select: async (_config: unknown) => {
            const responses = getResponses();
            const errorKeys = ["selectedProvider", "choice", "inputType"];
            for (const key of errorKeys) {
                if (responses[key] instanceof Error) {
                    throw responses[key];
                }
            }
            return responses.selectedProvider ?? responses.choice ?? responses.inputType ?? "";
        },
        multiselect: async (_config: unknown) => {
            const responses = getResponses();
            const value = responses.selectedProviders;
            if (value instanceof Error) {
                throw value;
            }
            return value ?? [];
        },
        text: async (config: { message?: string; initialValue?: string; default?: string }) => {
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
            for (const key of inputKeys) {
                if (responses[key] instanceof Error) {
                    throw responses[key];
                }
            }
            if (responses.inputServerName !== undefined) {
                return responses.inputServerName;
            }
            if (responses.inputNewName !== undefined) {
                return responses.inputNewName;
            }
            if (responses.inputCommand !== undefined) {
                return responses.inputCommand;
            }
            if (responses.inputEnv !== undefined) {
                return responses.inputEnv;
            }
            if (responses.inputHeaders !== undefined) {
                return responses.inputHeaders;
            }
            if (responses.inputVal !== undefined) {
                return responses.inputVal;
            }
            if (responses.newServerName !== undefined) {
                return responses.newServerName;
            }
            return config?.initialValue ?? config?.default ?? "";
        },
        confirm: async (_config: unknown) => {
            const responses = getResponses();
            const value = responses.confirmed;
            if (value instanceof Error) {
                throw value;
            }
            return value ?? false;
        },
        password: async (_config: unknown) => {
            const responses = getResponses();
            const value = responses.password;
            if (value instanceof Error) {
                throw value;
            }
            return value ?? "";
        },
    }));

    // Mock inquirerBackend.search (used for server/provider search prompts)
    mock.module("@app/utils/prompts/p/inquirer-backend", () => ({
        inquirerBackend: {
            search: async (_config: unknown) => {
                const responses = getResponses();
                const searchKeys = ["selectedOldName", "selectedServerName", "inputServerName"];
                for (const key of searchKeys) {
                    if (responses[key] instanceof Error) {
                        throw responses[key];
                    }
                }
                if (responses.selectedOldName !== undefined) {
                    return responses.selectedOldName;
                }
                if (responses.selectedServerName !== undefined) {
                    return responses.selectedServerName;
                }
                if (responses.inputServerName !== undefined) {
                    return responses.inputServerName;
                }
                return "";
            },
        },
        InquirerBackend: {},
        InquirerExtras: {},
    }));
}

/**
 * Set mock responses for prompt functions
 *
 * Keys:
 * - selectedProviders: string[] - for multiselect prompts selecting providers
 * - selectedProvider: string - for select prompts selecting a single provider
 * - choice: string - alternative for select prompts (e.g., conflict resolution)
 * - inputServerName: string - for search/text prompts for server name
 * - selectedOldName: string - for search prompts selecting server to rename
 * - inputNewName: string - for text prompts for new server name
 * - inputCommand: string - for text prompts for command
 * - inputEnv: string - for text prompts for environment variables
 * - inputHeaders: string - for text prompts for headers
 * - inputType: string - for select prompts for transport type
 * - confirmed: boolean - for confirm prompts
 * - newServerName: string - for text prompts when creating new server
 */
export function setMockResponses(responses: Record<string, unknown>): void {
    (globalThis as Record<string, unknown>).__inquirerMockResponses = responses;
}

/**
 * Get current mock responses
 */
export function getMockResponses(): Record<string, unknown> {
    return getResponses();
}
