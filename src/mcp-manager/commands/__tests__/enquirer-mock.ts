import { mock } from "bun:test";

/**
 * Setup Enquirer mock using globalThis for dynamic responses
 * Call this at the top of test files before importing command modules
 */
export function setupEnquirerMock(): void {
    // Use globalThis to store mock responses so the mock can access them
    (globalThis as any).__enquirerMockResponses = { selectedProviders: ["claude"] };

    mock.module("enquirer", () => {
        class MockEnquirer {
            async prompt(promptConfig: any): Promise<any> {
                // Access global mock responses
                const mockResponses = (globalThis as any).__enquirerMockResponses || {};
                const responseKey = promptConfig.name || "selectedProviders";
                
                // If we have a response for this key, return it wrapped in an object
                if (mockResponses[responseKey] !== undefined) {
                    return { [responseKey]: mockResponses[responseKey] };
                }
                
                // If mockResponses itself is an object with the key, return it
                if (mockResponses[responseKey] !== undefined) {
                    return mockResponses;
                }
                
                // Default fallback - return the entire mockResponses object or default
                return mockResponses && Object.keys(mockResponses).length > 0 
                    ? mockResponses 
                    : { selectedProviders: ["claude"] };
            }
        }
        return { default: MockEnquirer };
    });
}

/**
 * Set mock responses for Enquirer prompts
 */
export function setMockResponses(responses: Record<string, any>): void {
    (globalThis as any).__enquirerMockResponses = responses;
}

/**
 * Get current mock responses
 */
export function getMockResponses(): Record<string, any> {
    return (globalThis as any).__enquirerMockResponses || {};
}
