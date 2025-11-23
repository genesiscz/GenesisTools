# MCP Configuration Analysis

This document provides a comprehensive analysis of MCP (Model Context Protocol) server configurations across different AI assistants and editors. The analysis includes recursive structure examination and production-ready TypeScript interfaces following the principles outlined in `README.json-to-ts.md`.

## Analysis Methodology

Following the JSON-to-TypeScript transformation guide, this analysis:

1. **Generated initial types** using `quicktype` for baseline understanding
2. **Analyzed structure recursively** using `jq 'paths | join(".")'` to understand all nested paths
3. **Identified patterns** for dynamic keys, optional fields, and polymorphic structures
4. **Created generic interfaces** that balance type safety with extensibility
5. **Added proper documentation** and type guards where appropriate

## 1. Claude Desktop Configuration (`~/.claude.json`)

### Overview

Claude Desktop stores MCP server configurations in a JSON file with both global and project-specific settings.

### Recursive Structure Analysis

**Top-level keys:**

```json
{
  "mcpServers": {...},
  "disabledMcpServers": [...],
  "projects": {
    "[project-path]": {
      "mcpServers": {...},
      "disabledMcpServers": [...],
      "disabledMcpjsonServers": [...]
    }
  }
}
```

**MCP Server structure patterns:**

-   `mcpServers.{server-name}.command` - Executable command
-   `mcpServers.{server-name}.args` - Command arguments array
-   `mcpServers.{server-name}.env.{VAR_NAME}` - Environment variables
-   `mcpServers.{server-name}.type` - Server type (stdio/sse/http)
-   `mcpServers.{server-name}.url` - URL for SSE/HTTP servers

### TypeScript Interfaces

```typescript
/**
 * Generic Claude configuration that handles dynamic structures.
 * Generated from ~/.claude.json and designed for forward compatibility.
 * Supports both global and project-specific MCP server configurations.
 */
export interface ClaudeGenericConfig {
    // MCP Server Configurations
    mcpServers?: Record<string, ClaudeMCPServerConfig>;
    disabledMcpServers?: string[];

    // Project-specific configurations - keys are absolute project paths
    projects?: Record<string, ClaudeProjectConfig>;

    // Basic user preferences and settings
    numStartups?: number;
    installMethod?: string;
    autoUpdates?: boolean;
    verbose?: boolean;

    // Feature usage tracking
    tipsHistory?: Record<string, number>;
    memoryUsageCount?: number;
    promptQueueUseCount?: number;

    // Authentication and identity
    anonymousId?: string;
    userID?: string;
    oauthAccount?: ClaudeOAuthAccount;

    // Subscription and billing
    hasAvailableSubscription?: boolean;
    hasCompletedOnboarding?: boolean;
    subscriptionNoticeCount?: number;

    // Caching and performance
    cachedStatsigGates?: Record<string, boolean>;
    cachedDynamicConfigs?: Record<string, unknown>;
    passesEligibilityCache?: Record<string, ClaudeEligibilityCacheEntry>;

    // UI and workflow preferences
    showExpandedTodos?: boolean;
    preferredNotifChannel?: string;
    autoConnectIde?: boolean;

    // Extensible for future additions
    [key: string]: unknown;
}

/**
 * MCP server configuration for Claude Desktop.
 * Supports multiple transport types: stdio, sse, and http.
 * Designed to be flexible for different server implementations.
 */
export interface ClaudeMCPServerConfig {
    // Transport type - determines which other fields are required
    type?: "stdio" | "sse" | "http";

    // STDIO transport fields
    command?: string;
    args?: unknown[];
    env?: Record<string, string>;

    // SSE/HTTP transport fields
    url?: string;

    // Extensible for server-specific configurations
    [key: string]: unknown;
}

/**
 * Project-specific configuration in Claude Desktop.
 * Each project can have its own MCP server setup and preferences.
 */
export interface ClaudeProjectConfig {
    // MCP server configurations for this project
    mcpServers?: Record<string, ClaudeMCPServerConfig>;
    disabledMcpServers?: string[];
    disabledMcpjsonServers?: string[];

    // Project trust and security
    hasTrustDialogAccepted?: boolean;
    trustLevel?: "trusted" | "untrusted";

    // Performance and usage metrics
    lastCost?: number;
    lastToolDuration?: number;
    allowedTools?: unknown[];

    // Context and navigation
    mcpContextUris?: string[];

    // Extensible for future project-specific settings
    [key: string]: unknown;
}

/**
 * OAuth account information for Claude authentication.
 */
export interface ClaudeOAuthAccount {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number | string | Date;

    // Extensible for additional auth fields
    [key: string]: unknown;
}

/**
 * Eligibility cache entry for Claude's access control.
 */
export interface ClaudeEligibilityCacheEntry {
    eligible?: boolean;
    expiresAt?: number | string | Date;
    reason?: string;

    // Extensible for additional eligibility data
    [key: string]: unknown;
}

// Type guards for runtime validation
export function isClaudeConfig(obj: unknown): obj is ClaudeGenericConfig {
    return typeof obj === "object" && obj !== null;
}

export function isClaudeMCPServerConfig(obj: unknown): obj is ClaudeMCPServerConfig {
    return typeof obj === "object" && obj !== null;
}

// Helper type aliases
export type ClaudeProjectPath = string;
export type ClaudeProjectPaths = Record<ClaudeProjectPath, ClaudeProjectConfig>;
export type ClaudeServerName = string;
export type ClaudeMCPServers = Record<ClaudeServerName, ClaudeMCPServerConfig>;
```

### Key Findings

-   **Dynamic Keys**: Project paths and server names are dynamic, requiring `Record<string, Type>` patterns
-   **Polymorphic Servers**: MCP servers support multiple transport types (stdio, sse, http) with different required fields
-   **Nested Collections**: Both projects and MCP servers within projects use dynamic key structures
-   **Optional Fields**: Many fields are optional and only present after certain actions or configurations
-   **Environment Variables**: Stored as string key-value pairs in `env` objects

## 2. Gemini Code Assist Configuration (`~/.gemini/settings.json`)

### Overview

Gemini Code Assist uses a more structured configuration with explicit enable/disable states for MCP servers.

### Recursive Structure Analysis

**Top-level keys:**

```json
{
  "mcp": {
    "excluded": [...]
  },
  "mcpServers": {
    "[server-name]": {
      "command": "...",
      "args": [...],
      "env": {...},
      "disabled": true|false,
      "httpUrl": "...",
      "headers": {...}
    }
  }
}
```

**MCP Server patterns:**

-   `mcpServers.{server-name}.command` - Executable command
-   `mcpServers.{server-name}.args` - Command arguments
-   `mcpServers.{server-name}.env.{VAR_NAME}` - Environment variables
-   `mcpServers.{server-name}.disabled` - Enable/disable state
-   `mcpServers.{server-name}.httpUrl` - HTTP endpoint URL
-   `mcpServers.{server-name}.headers` - HTTP headers

### TypeScript Interfaces

```typescript
/**
 * Generic Gemini Code Assist configuration.
 * Generated from ~/.gemini/settings.json with focus on MCP server management.
 * Includes explicit enable/disable states and multiple transport types.
 */
export interface GeminiGenericConfig {
    // MCP configuration section
    mcp?: GeminiMCPConfig;
    mcpServers?: Record<string, GeminiMCPServerConfig>;

    // Core Gemini settings
    model?: GeminiModelConfig;
    context?: Record<string, unknown>;
    experimental?: Record<string, unknown>;

    // UI and interaction preferences
    ui?: Record<string, unknown>;
    ide?: Record<string, unknown>;
    output?: Record<string, unknown>;

    // Security and telemetry
    security?: Record<string, unknown>;
    telemetry?: Record<string, unknown>;

    // Tool and feature configurations
    tools?: Record<string, unknown>;

    // Extensible for future additions
    [key: string]: unknown;
}

/**
 * MCP-specific configuration section for Gemini.
 * Primarily manages server exclusion lists.
 */
export interface GeminiMCPConfig {
    // List of excluded MCP servers
    excluded?: string[];

    // Extensible for future MCP configuration options
    [key: string]: unknown;
}

/**
 * MCP server configuration for Gemini Code Assist.
 * Supports both command-based (stdio) and HTTP-based servers.
 * Includes explicit enable/disable state management.
 */
export interface GeminiMCPServerConfig {
    // Enable/disable state - explicit boolean flag
    disabled?: boolean;

    // STDIO transport fields
    command?: string;
    args?: unknown[];
    env?: Record<string, string>;

    // HTTP transport fields
    httpUrl?: string;
    headers?: Record<string, string>;

    // Extensible for server-specific configurations
    [key: string]: unknown;
}

/**
 * Model configuration for Gemini Code Assist.
 */
export interface GeminiModelConfig {
    name?: string;
    temperature?: number;
    maxTokens?: number;

    // Extensible for model-specific settings
    [key: string]: unknown;
}

// Type guards for runtime validation
export function isGeminiConfig(obj: unknown): obj is GeminiGenericConfig {
    return typeof obj === "object" && obj !== null;
}

export function isGeminiMCPServerConfig(obj: unknown): obj is GeminiMCPServerConfig {
    return typeof obj === "object" && obj !== null && (obj.disabled === undefined || typeof obj.disabled === "boolean");
}

// Helper type aliases
export type GeminiServerName = string;
export type GeminiMCPServers = Record<GeminiServerName, GeminiMCPServerConfig>;
```

### Key Findings

-   **Explicit State Management**: Uses `disabled` boolean field instead of separate arrays
-   **HTTP Transport Support**: Includes `httpUrl` and `headers` for HTTP-based MCP servers
-   **Exclusion Lists**: Uses `mcp.excluded` array for global server management
-   **Consistent Structure**: All servers follow the same interface pattern regardless of transport type

## 3. Codex Configuration (`/Users/Martin/.codex/config.toml`)

### Overview

Codex uses TOML format with a simpler, more structured approach to MCP server configuration.

### Recursive Structure Analysis

**TOML structure:**

```toml
[model]
# Global model settings

[mcp_servers.{server-name}]
command = "..."
args = [...]
env = { VAR_NAME = "value" }

[projects.{project-path}]
trust_level = "trusted"
```

**MCP Server patterns:**

-   `mcp_servers.{server-name}.command` - Executable command
-   `mcp_servers.{server-name}.args` - Command arguments array
-   `mcp_servers.{server-name}.env.{VAR_NAME}` - Environment variables

### TypeScript Interfaces

```typescript
/**
 * Generic Codex configuration.
 * Generated from ~/.codex/config.toml with TOML-specific patterns.
 * Focuses on model settings and MCP server management.
 */
export interface CodexGenericConfig {
    // Model configuration
    model?: string;
    model_reasoning_effort?: "low" | "medium" | "high";
    show_raw_agent_reasoning?: boolean;

    // MCP server configurations - keys are server names
    mcp_servers?: Record<string, CodexMCPServerConfig>;

    // Project-specific configurations - keys are absolute project paths
    projects?: Record<string, CodexProjectConfig>;

    // Extensible for future additions
    [key: string]: unknown;
}

/**
 * MCP server configuration for Codex.
 * TOML-based configuration with straightforward command execution.
 */
export interface CodexMCPServerConfig {
    // Command to execute
    command?: string;

    // Command arguments
    args?: unknown[];

    // Environment variables
    env?: Record<string, string>;

    // Extensible for server-specific configurations
    [key: string]: unknown;
}

/**
 * Project-specific configuration in Codex.
 * Primarily manages trust levels for different projects.
 */
export interface CodexProjectConfig {
    // Trust level for the project
    trust_level?: "trusted" | "untrusted" | "unknown";

    // Extensible for future project-specific settings
    [key: string]: unknown;
}

// Type guards for runtime validation
export function isCodexConfig(obj: unknown): obj is CodexGenericConfig {
    return typeof obj === "object" && obj !== null;
}

export function isCodexMCPServerConfig(obj: unknown): obj is CodexMCPServerConfig {
    return typeof obj === "object" && obj !== null;
}

// Helper type aliases
export type CodexServerName = string;
export type CodexMCPServers = Record<CodexServerName, CodexMCPServerConfig>;
export type CodexProjectPath = string;
export type CodexProjects = Record<CodexProjectPath, CodexProjectConfig>;
```

### Key Findings

-   **TOML Structure**: Uses TOML's table syntax for nested configurations
-   **Simple Transport**: Only supports command-based (stdio) execution
-   **Trust Management**: Project-level trust configuration
-   **Flat Structure**: Less nested than JSON configurations

## 4. Cursor MCP Configuration (Global)

### Overview

Cursor stores MCP configuration in workspace-specific storage with extension-managed server configurations.

### Recursive Structure Analysis

**Cursor MCP structure (from workspace storage):**

```json
{
    "mcpServers": {
        "claude-code-chat-permissions": {
            "command": "node",
            "args": ["path/to/extension-script.js"],
            "env": {
                "CLAUDE_PERMISSIONS_PATH": "path/to/permissions"
            }
        }
    }
}
```

**Workspace-specific patterns:**

-   Extension-managed servers in workspace storage
-   Permission-based access control
-   Node.js script execution model

### TypeScript Interfaces

```typescript
/**
 * Generic Cursor MCP configuration.
 * Generated from Cursor workspace storage analysis.
 * Focuses on extension-managed MCP servers with permission systems.
 */
export interface CursorGenericConfig {
    // MCP server configurations - typically extension-managed
    mcpServers?: Record<string, CursorMCPServerConfig>;

    // Extensible for future Cursor-specific settings
    [key: string]: unknown;
}

/**
 * MCP server configuration for Cursor.
 * Primarily extension-managed with Node.js execution and permission handling.
 */
export interface CursorMCPServerConfig {
    // Command to execute (typically Node.js)
    command?: string;

    // Command arguments
    args?: unknown[];

    // Environment variables
    env?: Record<string, string>;

    // Extensible for server-specific configurations
    [key: string]: unknown;
}

// Type guards for runtime validation
export function isCursorConfig(obj: unknown): obj is CursorGenericConfig {
    return typeof obj === "object" && obj !== null;
}

export function isCursorMCPServerConfig(obj: unknown): obj is CursorMCPServerConfig {
    return typeof obj === "object" && obj !== null;
}

// Helper type aliases
export type CursorServerName = string;
export type CursorMCPServers = Record<CursorServerName, CursorMCPServerConfig>;
```

### Key Findings

-   **Extension-Managed**: MCP servers are managed by Cursor extensions
-   **Workspace-Specific**: Configuration stored in workspace storage, not global settings
-   **Permission System**: Includes permission path management
-   **Node.js Focus**: Primarily uses Node.js for server execution

## Cross-Platform MCP Server Configuration Patterns

### Common MCP Server Interface

```typescript
/**
 * Unified MCP server configuration interface across all platforms.
 * Combines patterns from Claude, Gemini, Codex, and Cursor configurations.
 */
export interface UnifiedMCPServerConfig {
    // Transport identification
    type?: "stdio" | "sse" | "http";

    // STDIO transport (most common)
    command?: string;
    args?: unknown[];
    env?: Record<string, string>;

    // HTTP/SSE transport
    url?: string;
    httpUrl?: string;
    headers?: Record<string, string>;

    // State management
    disabled?: boolean;

    // Platform-specific extensions
    [key: string]: unknown;
}

/**
 * Unified MCP configuration across platforms.
 * Provides a common interface for managing MCP servers regardless of platform.
 */
export interface UnifiedMCPConfig {
    // Server configurations by name
    servers?: Record<string, UnifiedMCPServerConfig>;

    // Exclusion/disabled lists
    excluded?: string[];
    disabled?: string[];

    // Platform-specific settings
    platform?: "claude" | "gemini" | "codex" | "cursor";

    // Extensible for platform-specific features
    [key: string]: unknown;
}
```

## Validation and Type Guards

```typescript
// Comprehensive type guard for MCP server configs
export function isValidMCPServerConfig(obj: unknown): obj is UnifiedMCPServerConfig {
    if (typeof obj !== "object" || obj === null) return false;

    const config = obj as Record<string, unknown>;

    // Validate known fields have correct types
    if (config.type !== undefined && typeof config.type !== "string") return false;
    if (config.command !== undefined && typeof config.command !== "string") return false;
    if (config.args !== undefined && !Array.isArray(config.args)) return false;
    if (config.env !== undefined && typeof config.env !== "object") return false;
    if (config.disabled !== undefined && typeof config.disabled !== "boolean") return false;

    return true;
}

// Platform detection utility
export function detectMCPPlatform(config: unknown): "claude" | "gemini" | "codex" | "cursor" | "unknown" {
    if (!isValidMCPServerConfig(config)) return "unknown";

    const serverConfig = config as UnifiedMCPServerConfig;

    // Platform-specific detection logic
    if (serverConfig.httpUrl && serverConfig.headers) return "gemini";
    if (serverConfig.url && serverConfig.type === "sse") return "claude";
    if (typeof serverConfig.command === "string" && serverConfig.command.includes("node")) return "cursor";

    return "unknown";
}
```

## Migration and Compatibility

### Converting Between Platforms

```typescript
/**
 * Convert Claude MCP server config to unified format
 */
export function claudeToUnified(claudeConfig: ClaudeMCPServerConfig): UnifiedMCPServerConfig {
    return {
        type: claudeConfig.type || "stdio",
        command: claudeConfig.command,
        args: claudeConfig.args,
        env: claudeConfig.env,
        url: claudeConfig.url,
    };
}

/**
 * Convert Gemini MCP server config to unified format
 */
export function geminiToUnified(geminiConfig: GeminiMCPServerConfig): UnifiedMCPServerConfig {
    return {
        type: geminiConfig.httpUrl ? "http" : "stdio",
        command: geminiConfig.command,
        args: geminiConfig.args,
        env: geminiConfig.env,
        httpUrl: geminiConfig.httpUrl,
        headers: geminiConfig.headers,
        disabled: geminiConfig.disabled,
    };
}
```

## Summary of Key Patterns

1. **Dynamic Keys**: All platforms use dynamic keys for server names and project paths
2. **Multiple Transports**: STDIO (command-based), SSE, and HTTP transports supported
3. **Environment Variables**: Consistent `env` object pattern across platforms
4. **State Management**: Various approaches to enable/disable servers
5. **Extensibility**: All interfaces include index signatures for future additions
6. **Optional Fields**: Most fields are optional due to varying server requirements

## Usage Recommendations

1. **Use Unified Interfaces**: For cross-platform MCP management
2. **Validate at Runtime**: Use type guards before processing configurations
3. **Handle Migration**: Plan for configuration format changes between versions
4. **Document Extensions**: Clearly document any custom fields added to configurations
5. **Test with Real Data**: Validate interfaces against actual configuration files

This analysis provides a solid foundation for building MCP management tools that work across multiple AI assistant platforms while maintaining type safety and extensibility.
