import { mock } from "bun:test";

/**
 * Setup @inquirer/prompts mock using globalThis for dynamic responses
 * Call this at the top of test files before importing command modules
 *
 * @inquirer/prompts exports individual async functions (not a class like Enquirer),
 * so we mock each function separately.
 */
export function setupInquirerMock(): void {
    // Use globalThis to store mock responses so the mock can access them
    (globalThis as any).__inquirerMockResponses = { selectedProviders: ["claude"] };

    mock.module("@inquirer/prompts", () => ({
        checkbox: async (_config: unknown) => {
            const responses = (globalThis as any).__inquirerMockResponses || {};
            // checkbox returns an array directly (not wrapped in an object)
            return responses.selectedProviders ?? [];
        },
        select: async (_config: unknown) => {
            const responses = (globalThis as any).__inquirerMockResponses || {};
            // select returns a single value directly
            // Support both 'selectedProvider' and 'choice' keys for different test scenarios
            return responses.selectedProvider ?? responses.choice ?? responses.inputType ?? "";
        },
        input: async (config: { message?: string; default?: string }) => {
            const responses = (globalThis as any).__inquirerMockResponses || {};
            // input returns a string directly
            // Support multiple input field keys based on what the test expects
            if (responses.inputServerName !== undefined) return responses.inputServerName;
            if (responses.inputNewName !== undefined) return responses.inputNewName;
            if (responses.inputCommand !== undefined) return responses.inputCommand;
            if (responses.inputEnv !== undefined) return responses.inputEnv;
            if (responses.inputHeaders !== undefined) return responses.inputHeaders;
            if (responses.inputVal !== undefined) return responses.inputVal;
            if (responses.newServerName !== undefined) return responses.newServerName;
            // Fall back to default if provided in config
            return config?.default ?? "";
        },
        confirm: async (_config: unknown) => {
            const responses = (globalThis as any).__inquirerMockResponses || {};
            // confirm returns a boolean directly
            return responses.confirmed ?? false;
        },
        search: async (_config: unknown) => {
            const responses = (globalThis as any).__inquirerMockResponses || {};
            // search returns a single value directly
            // Support both 'selectedOldName' and 'selectedServerName' keys
            if (responses.selectedOldName !== undefined) return responses.selectedOldName;
            if (responses.selectedServerName !== undefined) return responses.selectedServerName;
            if (responses.inputServerName !== undefined) return responses.inputServerName;
            return "";
        },
        password: async (_config: unknown) => {
            const responses = (globalThis as any).__inquirerMockResponses || {};
            // password returns a string directly
            return responses.password ?? "";
        },
    }));

    // Also mock @inquirer/core for ExitPromptError
    mock.module("@inquirer/core", () => ({
        ExitPromptError: class ExitPromptError extends Error {
            constructor(message = "User force closed the prompt") {
                super(message);
                this.name = "ExitPromptError";
            }
        },
    }));
}

/**
 * Set mock responses for @inquirer/prompts functions
 *
 * Keys:
 * - selectedProviders: string[] - for checkbox prompts selecting providers
 * - selectedProvider: string - for select prompts selecting a single provider
 * - choice: string - alternative for select prompts (e.g., conflict resolution)
 * - inputServerName: string - for search/input prompts for server name
 * - selectedOldName: string - for search prompts selecting server to rename
 * - inputNewName: string - for input prompts for new server name
 * - inputCommand: string - for input prompts for command
 * - inputEnv: string - for input prompts for environment variables
 * - inputHeaders: string - for input prompts for headers
 * - inputType: string - for select prompts for transport type
 * - confirmed: boolean - for confirm prompts
 * - newServerName: string - for input prompts when creating new server
 */
export function setMockResponses(responses: Record<string, unknown>): void {
    (globalThis as any).__inquirerMockResponses = responses;
}

/**
 * Get current mock responses
 */
export function getMockResponses(): Record<string, unknown> {
    return (globalThis as any).__inquirerMockResponses || {};
}
