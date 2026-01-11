# Testing Guide for MCP Manager Commands

This guide explains how to write and run tests for MCP Manager commands, particularly those that use Enquirer for interactive prompts.

## Overview

The MCP Manager commands use Bun's Jest-compatible test framework. Tests are located in `src/mcp-manager/commands/__tests__/`.

## Enquirer Mocking Strategy

**Critical**: Commands that use Enquirer prompts require special mocking because Enquirer instances are created at module load time.

### The Problem

Commands create Enquirer instances at module load:
```typescript
// In command file (e.g., sync.ts)
import Enquirer from "enquirer";
const prompter = new Enquirer(); // Created at module load time
```

If we try to mock Enquirer after importing, the instance is already created with the real Enquirer.

### The Solution

1. **Mock Enquirer BEFORE importing command modules** using `mock.module()`
2. **Use dynamic imports** (`await import()`) for command modules
3. **Store mock responses in `globalThis`** so they can be updated per test

### Example Test File

```typescript
import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import { setupEnquirerMock, setMockResponses } from "./enquirer-mock.js";

// ⚠️ CRITICAL: Setup Enquirer mock BEFORE importing command modules
setupEnquirerMock();

// Use dynamic import for command modules (loads after mock is set up)
const { syncServers } = await import("../sync.js");
import { MockMCPProvider, createMockUnifiedConfig } from "./test-utils.js";
import * as configUtils from "../../utils/config.utils.js";
import logger from "@app/logger";

describe("syncServers", () => {
    let mockProvider: MockMCPProvider;
    let mockProviders: MockMCPProvider[];

    beforeEach(() => {
        mockProvider = new MockMCPProvider("claude", "/mock/claude.json");
        mockProviders = [mockProvider];
        
        // Set default mock responses for each test
        setMockResponses({ selectedProviders: ["claude"] });
    });

    it("should sync servers to selected providers", async () => {
        const mockConfig = createMockUnifiedConfig();
        
        // Override responses for this specific test if needed
        setMockResponses({ selectedProviders: ["claude", "gemini"] });
        
        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(mockConfig);
        spyOn(configUtils, "stripMeta").mockImplementation((config) => {
            const { _meta, ...rest } = config;
            return rest;
        });
        spyOn(logger, "info");
        spyOn(logger, "warn");
        spyOn(logger, "error");

        await syncServers(mockProviders);

        expect(mockProvider.syncServersCalls.length).toBe(1);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Synced to claude"));
    });
});
```

## Helper Functions

### `enquirer-mock.ts`

Located in `src/mcp-manager/commands/__tests__/enquirer-mock.ts`:

- **`setupEnquirerMock()`** - Sets up the Enquirer mock module. Call this at the top of test files before any imports.
- **`setMockResponses(responses)`** - Updates mock responses. Use in `beforeEach` or individual tests.
- **`getMockResponses()`** - Gets current mock responses (rarely needed).

### `test-utils.ts`

Located in `src/mcp-manager/commands/__tests__/test-utils.ts`:

- **`MockMCPProvider`** - Mock provider class for testing
- **`createMockUnifiedConfig()`** - Creates a mock unified config
- **`createMockServerConfig()`** - Creates a mock server config

## Mock Response Format

Mock responses should match the structure that Enquirer returns:

```typescript
// For a prompt with name "selectedProviders"
setMockResponses({
    selectedProviders: ["claude", "gemini"]
});

// For multiple prompts in sequence
setMockResponses({
    selectedProviders: ["claude"],
    choice: "current",  // Second prompt
    inputNewName: "renamed-server"  // Third prompt
});
```

The mock automatically wraps responses in an object with the prompt name as the key.

## Commands That Need Enquirer Mocking

These commands use Enquirer and require the mocking pattern:

- ✅ `sync.ts` - Provider selection
- ✅ `sync-from-providers.ts` - Provider selection, conflict resolution
- ✅ `install.ts` - Server name, command, env prompts
- ✅ `rename.ts` - Old name, new name, provider selection
- ⚠️ `toggle-server.ts` - Uses `command.utils.ts` functions (already mocked)

## Commands That Don't Need Enquirer Mocking

These commands don't use Enquirer directly:

- ✅ `list.ts` - No prompts
- ✅ `show.ts` - No prompts
- ✅ `toggle-server.ts` - Uses mocked `command.utils.ts` functions

## Running Tests

```bash
# Run all command tests
bun test src/mcp-manager/commands/__tests__/

# Run specific test file
bun test src/mcp-manager/commands/__tests__/sync.test.ts

# Run with verbose output
bun test src/mcp-manager/commands/__tests__/ --verbose

# Run with coverage
bun test --coverage src/mcp-manager/commands/__tests__/
```

## Common Patterns

### Testing Multiple Prompts

```typescript
it("should handle multiple prompts", async () => {
    setMockResponses({
        selectedProviders: ["claude"],
        choice: "incoming",  // Second prompt
    });
    
    // ... test code
});
```

### Testing Empty Selections

```typescript
it("should handle empty selection", async () => {
    setMockResponses({
        selectedProviders: [],  // Empty array
    });
    
    // ... test code
    expect(logger.info).toHaveBeenCalledWith("No providers selected.");
});
```

### Testing Error Cases

```typescript
it("should handle errors", async () => {
    mockProvider.errors.set("syncServers", new Error("Sync failed"));
    setMockResponses({ selectedProviders: ["claude"] });
    
    // ... test code
    expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to sync")
    );
});
```

## Troubleshooting

### Tests Timeout Waiting for Input

**Problem**: Test hangs waiting for Enquirer prompt input.

**Solution**: Ensure `setupEnquirerMock()` is called before importing command modules, and use dynamic imports.

### Mock Responses Not Working

**Problem**: Mock returns undefined or wrong values.

**Solution**: 
1. Check that `setMockResponses()` is called before the command runs
2. Verify the response key matches the prompt name
3. Ensure responses are set in `globalThis` (the mock accesses them there)

### Module Already Loaded Error

**Problem**: `mock.module()` doesn't work because module is already imported.

**Solution**: Use dynamic imports (`await import()`) for command modules after calling `setupEnquirerMock()`.

## Best Practices

1. **Always mock Enquirer first** - Call `setupEnquirerMock()` at the very top
2. **Use dynamic imports** - For command modules that use Enquirer
3. **Reset in beforeEach** - Set default mock responses in `beforeEach`
4. **Override per test** - Update responses in individual tests when needed
5. **Mock dependencies** - Mock `configUtils`, `logger`, etc. using `spyOn`
6. **Test edge cases** - Empty selections, errors, multiple providers, etc.

## Example: Complete Test File

See `src/mcp-manager/commands/__tests__/sync.test.ts` for a complete working example.

## Additional Resources

- [Bun Test Documentation](https://bun.sh/docs/test)
- [Bun Mocks Documentation](https://bun.sh/docs/test/mocks)
- Test files in `src/mcp-manager/commands/__tests__/`




