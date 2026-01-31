# Testing Guide for MCP Manager Commands

This guide explains how to write and run tests for MCP Manager commands, particularly those that use `@inquirer/prompts` for interactive prompts.

## Overview

The MCP Manager commands use Bun's Jest-compatible test framework. Tests are located in `src/mcp-manager/commands/__tests__/`.

## @inquirer/prompts Mocking Strategy

**Critical**: Commands that use `@inquirer/prompts` require special mocking because prompt functions are imported at module load time.

### The Problem

Commands import prompt functions directly:
```typescript
// In command file (e.g., sync.ts)
import { select, checkbox, confirm } from "@inquirer/prompts";
```

If we try to mock after importing, the functions are already bound to the real implementation.

### The Solution

1. **Mock @inquirer/prompts BEFORE importing command modules** using `mock.module()`
2. **Use dynamic imports** (`await import()`) for command modules
3. **Store mock responses in `globalThis`** so they can be updated per test

### Example Test File

```typescript
import { describe, it, expect, beforeEach, spyOn, mock } from "bun:test";
import { setupInquirerMock, setMockResponses } from "./inquirer-mock.js";

// ⚠️ CRITICAL: Setup @inquirer/prompts mock BEFORE importing command modules
setupInquirerMock();

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

### `inquirer-mock.ts`

Located in `src/mcp-manager/commands/__tests__/inquirer-mock.ts`:

- **`setupInquirerMock()`** - Sets up the @inquirer/prompts mock module. Call this at the top of test files before any imports.
- **`setMockResponses(responses)`** - Updates mock responses. Use in `beforeEach` or individual tests.
- **`getMockResponses()`** - Gets current mock responses (rarely needed).

### `test-utils.ts`

Located in `src/mcp-manager/commands/__tests__/test-utils.ts`:

- **`MockMCPProvider`** - Mock provider class for testing
- **`createMockUnifiedConfig()`** - Creates a mock unified config
- **`createMockServerConfig()`** - Creates a mock server config

## Mock Response Format

Mock responses should match what you'd return from the prompt:

```typescript
// For select prompts
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

## Commands That Need @inquirer/prompts Mocking

These commands use @inquirer/prompts and require the mocking pattern:

- ✅ `sync.ts` - Provider selection (checkbox)
- ✅ `sync-from-providers.ts` - Provider selection, conflict resolution
- ✅ `install.ts` - Server name, command, env prompts (input, search, select)
- ✅ `rename.ts` - Old name, new name, provider selection (search, input, checkbox)
- ⚠️ `toggle-server.ts` - Uses `command.utils.ts` functions (already mocked)

## Commands That Don't Need @inquirer/prompts Mocking

These commands don't use interactive prompts directly:

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

### Testing User Cancellation

```typescript
import { ExitPromptError } from "@inquirer/core";

it("should handle user cancellation", async () => {
    // Mock throws ExitPromptError when user presses Ctrl+C
    setMockResponses({
        selectedProviders: new ExitPromptError()
    });

    // ... test code expects graceful exit
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

**Problem**: Test hangs waiting for prompt input.

**Solution**: Ensure `setupInquirerMock()` is called before importing command modules, and use dynamic imports.

### Mock Responses Not Working

**Problem**: Mock returns undefined or wrong values.

**Solution**:
1. Check that `setMockResponses()` is called before the command runs
2. Verify the response key matches what the test expects
3. Ensure responses are set in `globalThis` (the mock accesses them there)

### Module Already Loaded Error

**Problem**: `mock.module()` doesn't work because module is already imported.

**Solution**: Use dynamic imports (`await import()`) for command modules after calling `setupInquirerMock()`.

## Best Practices

1. **Always mock @inquirer/prompts first** - Call `setupInquirerMock()` at the very top
2. **Use dynamic imports** - For command modules that use prompts
3. **Reset in beforeEach** - Set default mock responses in `beforeEach`
4. **Override per test** - Update responses in individual tests when needed
5. **Mock dependencies** - Mock `configUtils`, `logger`, etc. using `spyOn`
6. **Test edge cases** - Empty selections, errors, multiple providers, user cancellation
7. **Handle ExitPromptError** - Test graceful handling of Ctrl+C cancellation

## Example: Complete Test File

See `src/mcp-manager/commands/__tests__/sync.test.ts` for a complete working example.

## Testing @clack/prompts

For tools using `@clack/prompts` (our preferred library for new tools), the mocking pattern is different.

### Key Differences from @inquirer/prompts

| Aspect | @inquirer/prompts | @clack/prompts |
|--------|-------------------|----------------|
| Cancel detection | `ExitPromptError` exception | `p.isCancel(result)` returns `true` |
| Cancel value | Throws error | Returns `symbol` |
| Spinner | External (ora) | Built-in `p.spinner()` |
| Logging | External (console/logger) | Built-in `p.log.*` |

### Mocking Pattern for @clack/prompts

```typescript
import { describe, it, expect, beforeEach, mock } from "bun:test";

// Store mock responses
let mockResponses: Record<string, unknown> = {};

function setMockResponses(responses: Record<string, unknown>) {
    mockResponses = { ...mockResponses, ...responses };
}

// Mock before imports
mock.module("@clack/prompts", () => ({
    intro: () => {},
    outro: () => {},
    cancel: () => {},
    spinner: () => ({
        start: () => {},
        stop: () => {},
        message: () => {},
    }),
    isCancel: (value: unknown) => value === Symbol.for("cancel"),
    select: async () => mockResponses.select,
    confirm: async () => mockResponses.confirm,
    text: async () => mockResponses.text,
    password: async () => mockResponses.password,
    multiselect: async () => mockResponses.multiselect,
    log: {
        info: () => {},
        error: () => {},
        warn: () => {},
        success: () => {},
        message: () => {},
        step: () => {},
    },
    note: () => {},
}));

// Dynamic import AFTER mock setup
const { myCommand } = await import("../my-command.js");

describe("myCommand", () => {
    beforeEach(() => {
        // Reset mock responses
        mockResponses = {};
    });

    it("should handle normal flow", async () => {
        setMockResponses({
            select: "option1",
            confirm: true,
        });

        await myCommand();
        // assertions...
    });

    it("should handle user cancellation", async () => {
        // Return cancel symbol to simulate Ctrl+C / Escape
        setMockResponses({
            select: Symbol.for("cancel"),
        });

        // The command should exit gracefully
        // (test process.exit or early return)
    });
});
```

### Testing Cancel Behavior

Unlike `@inquirer/prompts` where you throw `ExitPromptError`, with `@clack/prompts` you return a cancel symbol:

```typescript
it("should handle cancel at select prompt", async () => {
    setMockResponses({
        select: Symbol.for("cancel"),
    });

    // Your command should check p.isCancel() and handle gracefully
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called");
    });

    await expect(myCommand()).rejects.toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(0);
});
```

### Spinner Testing

```typescript
it("should show spinner during async work", async () => {
    const spinnerCalls: string[] = [];

    mock.module("@clack/prompts", () => ({
        // ... other mocks
        spinner: () => ({
            start: (msg: string) => spinnerCalls.push(`start:${msg}`),
            stop: (msg: string) => spinnerCalls.push(`stop:${msg}`),
        }),
    }));

    await myCommand();

    expect(spinnerCalls).toContain("start:Loading...");
    expect(spinnerCalls).toContain("stop:Done!");
});
```

## Additional Resources

- [Bun Test Documentation](https://bun.sh/docs/test)
- [Bun Mocks Documentation](https://bun.sh/docs/test/mocks)
- [@inquirer/prompts Documentation](https://www.npmjs.com/package/@inquirer/prompts)
- [@clack/prompts Documentation](https://www.npmjs.com/package/@clack/prompts)
- [Prompts & Colors Guide](./prompts-and-colors.md)
- Test files in `src/mcp-manager/commands/__tests__/`
