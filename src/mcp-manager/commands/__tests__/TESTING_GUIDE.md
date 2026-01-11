# Testing Guide for MCP Manager Commands

## Enquirer Mocking Strategy

All tests that use commands with Enquirer prompts must:

1. **Call `setupEnquirerMock()` at the top** before importing command modules
2. **Use dynamic imports** (`await import()`) for command modules
3. **Set mock responses** using `setMockResponses()` in each test

### Example:

```typescript
import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import { setupEnquirerMock, setMockResponses } from "./enquirer-mock.js";

// Setup Enquirer mock BEFORE importing command modules
setupEnquirerMock();

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

- Enquirer instances are created at module load time (`const prompter = new Enquirer()`)
- `mock.module()` must be called before the module is imported
- Using `globalThis` allows dynamic response updates per test
- Dynamic imports ensure modules load after the mock is set up

## Test Files Status

✅ **Working:**
- `sync.test.ts` - All tests passing
- `sync-from-providers.test.ts` - All tests passing  
- `toggle-server.test.ts` - Most tests passing (uses command.utils mocks)
- `list.test.ts` - All tests passing (no Enquirer)
- `show.test.ts` - All tests passing (no Enquirer)

⚠️ **Needs Updates:**
- `install.test.ts` - Needs Enquirer mocking
- `rename.test.ts` - Needs Enquirer mocking
- `backup.test.ts` - Needs fs mocking (different approach)
- `config.test.ts` - Needs fs/process mocking

## Running Tests

```bash
# Run all tests
bun test src/mcp-manager/commands/__tests__/

# Run specific test file
bun test src/mcp-manager/commands/__tests__/sync.test.ts

# Run with verbose output
bun test src/mcp-manager/commands/__tests__/ --verbose
```




