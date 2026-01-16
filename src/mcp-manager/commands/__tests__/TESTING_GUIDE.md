# Testing Guide for MCP Manager Commands

## @inquirer/prompts Mocking Strategy

All tests that use commands with interactive prompts must:

1. **Call `setupInquirerMock()` at the top** before importing command modules
2. **Use dynamic imports** (`await import()`) for command modules
3. **Set mock responses** using `setMockResponses()` in each test

### Example:

```typescript
import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import { setupInquirerMock, setMockResponses } from "./inquirer-mock.js";

// Setup @inquirer/prompts mock BEFORE importing command modules
setupInquirerMock();

// Now import after mocking using dynamic import
const { syncServers } = await import("../sync.js");
import { MockMCPProvider, createMockUnifiedConfig } from "./test-utils.js";

describe("syncServers", () => {
    beforeEach(() => {
        // Set default mock responses
        setMockResponses({ selectedProviders: ["claude"] });
    });

    it("should sync servers", async () => {
        // Override responses for this specific test if needed
        setMockResponses({ selectedProviders: ["claude", "gemini"] });

        // ... rest of test
    });
});
```

## Why This Approach?

- `mock.module()` must be called before the module is imported
- Using `globalThis` allows dynamic response updates per test
- Dynamic imports ensure modules load after the mock is set up
- Individual prompt functions (`select`, `input`, `checkbox`, etc.) are mocked separately

## Available Mock Response Keys

Set these via `setMockResponses()`:

| Key | Used By | Description |
|-----|---------|-------------|
| `selectedProviders` | `checkbox` | Array of selected provider names |
| `selectedProvider` | `select` | Single selected provider |
| `choice` | `select` | Generic selection choice |
| `inputServerName` | `input` | Server name input |
| `inputNewName` | `input` | New name for rename |
| `inputCommand` | `input` | Command input |
| `inputType` | `input` | Type input (stdio/sse) |
| `inputEnv` | `input` | Environment variables input |
| `confirmed` | `confirm` | Boolean confirmation |
| `searchResult` | `search` | Search selection result |
| `password` | `password` | Password input |

## Running Tests

```bash
# Run all tests
bun test src/mcp-manager/commands/__tests__/

# Run specific test file
bun test src/mcp-manager/commands/__tests__/sync.test.ts

# Run with verbose output
bun test src/mcp-manager/commands/__tests__/ --verbose
```
