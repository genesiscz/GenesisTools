# MCP Manager Commands Tests

Comprehensive test suite for all MCP Manager commands using Bun's test framework.

## Test Structure

- **test-utils.ts**: Shared test utilities including `MockMCPProvider` and helper functions
- **toggle-server.test.ts**: Tests for enable/disable functionality (via toggle-server)
- **sync.test.ts**: Tests for syncing servers to providers
- **sync-from-providers.test.ts**: Tests for syncing servers from providers
- **list.test.ts**: Tests for listing servers
- **show.test.ts**: Tests for showing server configurations
- **install.test.ts**: Tests for installing servers
- **rename.test.ts**: Tests for renaming servers
- **backup.test.ts**: Tests for backing up configurations
- **config.test.ts**: Tests for opening/configuring unified config

## Running Tests

```bash
# Run all tests
bun test src/mcp-manager/commands/__tests__/

# Run specific test file
bun test src/mcp-manager/commands/__tests__/toggle-server.test.ts

# Run with coverage
bun test --coverage src/mcp-manager/commands/__tests__/
```

## Mocking Strategy

- **MCPProvider**: Mocked via `MockMCPProvider` class that extends `MCPProvider`
- **Config Utils**: Mocked using `spyOn` for `readUnifiedConfig`, `writeUnifiedConfig`, etc.
- **Command Utils**: Mocked using `spyOn` for `getServerNames`, `promptForProviders`, etc.
- **Logger**: Mocked using `spyOn` for all logger methods
- **Enquirer**: Mocked at the module level using Bun's `mock.module` or by mocking the instance methods

## Test Coverage

Each command is tested for:
- ✅ Success cases
- ✅ Error handling
- ✅ Edge cases (empty configs, missing servers, etc.)
- ✅ Per-project enablement (for Claude)
- ✅ Multiple providers
- ✅ User cancellation

## Notes

- Tests use Bun's Jest-compatible API (`describe`, `it`, `expect`, `spyOn`)
- Mock providers track all method calls for verification
- Tests are isolated and don't require actual file system access
- All async operations are properly awaited




