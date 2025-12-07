# MCP-Manager Enhancement Plan

## Executive Summary

The mcp-manager tool is a cross-platform MCP (Model Context Protocol) server configuration manager that provides a unified interface for managing MCP servers across Claude Desktop, Gemini Code Assist, Codex, and Cursor. This document outlines potential enhancements to improve functionality, user experience, and workflow efficiency.

## Current Capabilities (Baseline)

### Core Features
- **Multi-Provider Support**: Manages MCP servers for Claude, Gemini, Codex, and Cursor
- **Unified Configuration**: Single config file (`~/.genesis-tools/mcp-manager/config.json`) to manage all servers
- **Bidirectional Sync**: Sync FROM unified config TO providers, or FROM providers TO unified config
- **Automatic Backups**: Creates timestamped backups before any changes with automatic restore on rejection
- **Visual Diffs**: Shows exactly what changed before applying updates (using system `diff` command)
- **Interactive Confirmation**: Review changes and approve or revert
- **Safe Operations**: All changes are reversible with automatic backup restoration
- **Conflict Resolution**: Interactive conflict resolution during sync-from-providers

### Commands
- `config`: Open/edit unified configuration file
- `sync`: Sync MCP servers from unified config to providers
- `sync-from-providers`: Sync servers FROM providers TO unified config
- `list`: List all MCP servers across all providers
- `enable`: Enable an MCP server in a provider
- `disable`: Disable an MCP server in a provider
- `disable-all`: Disable an MCP server for all projects (Claude-specific)
- `install`: Install/add an MCP server to a provider
- `show`: Show full configuration of an MCP server
- `backup-all`: Backup all configs for all providers

### Architecture Strengths
- **Provider Pattern**: Abstract base class with provider-specific implementations
- **Type Safety**: TypeScript interfaces for all config formats
- **Storage Abstraction**: Centralized storage management via `Storage` class
- **Conflict Detection**: DiffUtil for detecting conflicts in args, env, and other critical fields
- **_meta Tracking**: Internal metadata tracking for per-provider enabled state (not synced to providers)

## In-Progress Enhancements (Being Implemented by Other Agents)

### Agent 1: Autocomplete for Enable/Disable + Global Claude Enable
- Adding autocomplete prompts for server selection when enabling/disabling
- Adding "Enable for all projects (Claude)" functionality
- Improves UX by showing available servers instead of requiring manual typing

### Agent 2: Enhanced Install Command
- Support for `install <name> "<command>"` format
- Interactive ENV variable prompts during installation
- Simplifies onboarding of new MCP servers

## Proposed Enhancements (Prioritized by Impact)

### Priority 1: Critical Workflow Improvements

#### 1.1 Project-Specific Server Management for Claude
**Problem**: Claude supports project-specific MCP server configurations (in the `projects` object), but the tool currently only manages global servers.

**Impact**: HIGH - Claude users work with multiple projects and need per-project server configurations

**How it works in Claude**:
```json
{
  "mcpServers": { /* global servers */ },
  "disabledMcpServers": [ /* globally disabled */ ],
  "projects": {
    "/absolute/path/to/project": {
      "mcpServers": { /* project-specific servers */ },
      "disabledMcpServers": [ /* disabled for this project */ ]
    }
  }
}
```

**Enhancement Details**:
- Add `enable-for-project <server> <project-path>` command
- Add `disable-for-project <server> <project-path>` command
- Add `list-projects` command to show all configured projects
- Add `list --project <path>` to list servers for a specific project
- Extend unified config to support project-specific metadata:
  ```typescript
  interface UnifiedMCPServerConfig {
    _meta?: {
      enabled: Partial<EnabledState>;
      projects?: {
        [projectPath: string]: {
          enabled: Partial<EnabledState>;
          // Other project-specific metadata
        };
      };
    };
  }
  ```
- Interactive project selector when enabling/disabling (autocomplete with recent projects)
- Option to "copy global server to project" workflow

**Implementation Considerations**:
- Need to track current working directory vs absolute project paths
- Should provide "current directory" as default option in prompts
- Consider adding project aliases (e.g., "~/my-app" → "my-app")

#### 1.2 Bulk Operations
**Problem**: Users often need to enable/disable/sync multiple servers at once

**Impact**: HIGH - Saves time for users managing many servers

**Enhancement Details**:
- Add `enable-multiple` command with multiselect prompt
- Add `disable-multiple` command with multiselect prompt
- Add `--all` flag for bulk operations (e.g., `enable --all` to enable all servers)
- Add `--provider <name>` flag to scope operations to a specific provider
- Add `sync --dry-run` to preview changes without applying them
- Add `apply-template <template-name>` to bulk-install a predefined set of servers

**Example Usage**:
```bash
# Enable multiple servers at once
tools mcp-manager enable-multiple

# Preview sync changes without applying
tools mcp-manager sync --dry-run

# Enable all servers for a specific provider
tools mcp-manager enable --all --provider claude
```

#### 1.3 Server Discovery & Registry
**Problem**: Users don't know what MCP servers are available

**Impact**: MEDIUM-HIGH - Helps users discover and install useful MCP servers

**Enhancement Details**:
- Add `discover` command to search/browse available MCP servers
- Integrate with MCP server registry (https://github.com/modelcontextprotocol/servers or similar)
- Show server descriptions, authors, required ENV variables, and installation instructions
- Add `install-from-registry <server-name>` command
- Cache registry data locally (refresh daily or on-demand)
- Support filtering by category, language, or functionality
- Integration with npm/pip packages that provide MCP servers

**Data Source Options**:
1. Official MCP registry (if/when available)
2. Curated awesome-mcp list
3. npm packages with `mcp-server` keyword
4. User-contributed server definitions in unified config

**Example Registry Entry**:
```json
{
  "name": "filesystem",
  "description": "MCP server for file system operations",
  "author": "@modelcontextprotocol",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "<ALLOWED_PATH>"],
  "env": {},
  "category": "files",
  "npmPackage": "@modelcontextprotocol/server-filesystem",
  "requiredEnv": ["ALLOWED_PATH"],
  "optionalEnv": []
}
```

### Priority 2: Quality of Life Improvements

#### 2.1 Template/Preset System
**Problem**: Setting up common server configurations is repetitive

**Impact**: MEDIUM - Streamlines onboarding and sharing configurations

**Enhancement Details**:
- Add `templates` directory in `~/.genesis-tools/mcp-manager/`
- Add `template save <name>` to save current config as template
- Add `template load <name>` to apply a template
- Add `template list` to show available templates
- Add `template export <name>` to export as shareable JSON/YAML
- Add `template import <file>` to import from file
- Ship with common presets (e.g., "typescript-dev", "python-dev", "full-stack")

**Example Templates**:
- `typescript-dev`: mcp-tsc, filesystem, github
- `python-dev`: filesystem, python-lsp, pytest
- `ai-assistant`: web-reader, filesystem, github, ripgrep

#### 2.2 Health Check & Diagnostics
**Problem**: Servers might fail to start, but users don't know why

**Impact**: MEDIUM - Reduces troubleshooting time

**Enhancement Details**:
- Add `health-check` command to test all configured servers
- Verify executables exist and are in PATH
- Verify required ENV variables are set
- Test server startup (spawn and check for errors)
- Show diagnostics report with:
  - ✓ Server name (HEALTHY)
  - ✗ Server name (FAILED: command not found)
  - ⚠ Server name (WARNING: ENV variable missing)
- Add `doctor` command for comprehensive system check
- Suggest fixes for common issues

**Example Output**:
```
Health Check Results:

✓ filesystem - HEALTHY
✗ github - FAILED: GITHUB_TOKEN environment variable not set
✓ ripgrep - HEALTHY
⚠ typescript - WARNING: npx not found in PATH

2 healthy, 1 failed, 1 warning
```

#### 2.3 Version Management
**Problem**: MCP servers get updated, but users don't track versions

**Impact**: MEDIUM - Helps with debugging and reproducibility

**Enhancement Details**:
- Add `version` field to unified server config
- Add `update-check` command to check for server updates
- Show installed vs available versions
- Add `upgrade <server>` command to update a server
- Track version history in _meta
- Support pinning to specific versions

#### 2.4 Export/Import Functionality
**Problem**: Sharing configurations between machines is manual

**Impact**: MEDIUM - Simplifies multi-machine setups

**Enhancement Details**:
- Add `export <file>` to export entire unified config
- Add `export <server> <file>` to export single server
- Add `import <file>` to import config (with merge strategy)
- Support formats: JSON, YAML, TOML
- Add `--redact-secrets` flag to remove ENV variables from export
- Add `--template` flag to export as template with placeholders

### Priority 3: Advanced Features

#### 3.1 Environment Variable Management
**Problem**: Managing ENV variables across servers is cumbersome

**Impact**: MEDIUM - Centralizes secret management

**Enhancement Details**:
- Add `env` sub-commands for managing ENV variables
- Add `env set <server> <VAR_NAME> <value>` command
- Add `env get <server> <VAR_NAME>` command
- Add `env list <server>` to show all ENV vars for a server
- Support .env file integration (read from project .env)
- Add `--from-env-file <path>` flag to import ENV from file
- Warn about missing required ENV variables during install
- Option to use system keychain for sensitive values (macOS Keychain, Windows Credential Manager)

**Security Considerations**:
- Never log ENV variable values
- Support masked values in `show` command
- Add `--show-secrets` flag for debugging
- Warn users about committing secrets

#### 3.2 Logging & Debugging
**Problem**: MCP server logs are scattered and hard to access

**Impact**: LOW-MEDIUM - Helps with troubleshooting

**Enhancement Details**:
- Add `logs <server>` command to tail server logs
- Centralize logs in `~/.genesis-tools/mcp-manager/logs/`
- Add `--follow` flag for real-time log streaming
- Add `--since <time>` flag to show recent logs
- Integrate with system logs (if providers log to syslog/journald)
- Add `--verbose` flag to show debug-level logs

#### 3.3 Provider-Specific Extensions

##### 3.3.1 Claude-Specific Features
- Support for `allowedTools` configuration (project-level)
- Support for `trustLevel` management (project trust dialog)
- Support for `mcpContextUris` (context management)
- Better handling of `disabledMcpjsonServers` (JSON-based servers)

##### 3.3.2 Gemini-Specific Features
- Better HTTP server support (httpUrl, headers)
- Support for `mcp.excluded` array management
- Integration with Gemini model settings

##### 3.3.3 Codex-Specific Features
- TOML-specific features (better formatting)
- Project trust level management
- Model reasoning effort configuration

##### 3.3.4 Cursor-Specific Features
- Extension-managed server detection
- Workspace-specific configuration
- Permission path management

#### 3.4 Migration Assistant
**Problem**: Switching between providers is manual

**Impact**: LOW - Helps users who switch AI assistants

**Enhancement Details**:
- Add `migrate <from> <to>` command to migrate configs
- Handle provider-specific differences gracefully
- Warn about unsupported features
- Generate migration report
- Support rollback if migration fails

### Priority 4: Nice-to-Have Features

#### 4.1 GUI/TUI Interface
**Problem**: CLI can be intimidating for some users

**Impact**: LOW - Improves accessibility

**Enhancement Details**:
- Add `--tui` flag for terminal UI (using `blessed` or similar)
- Interactive dashboard showing all servers and their states
- Keyboard shortcuts for common operations
- Visual config editor

#### 4.2 Hooks & Automation
**Problem**: Users want to run scripts before/after sync

**Impact**: LOW - Enables custom workflows

**Enhancement Details**:
- Add `hooks` configuration section
- Support `pre-sync`, `post-sync`, `pre-install`, `post-install` hooks
- Run shell scripts or commands at hook points
- Pass context to hooks (server name, provider, etc.)

#### 4.3 Cloud Sync
**Problem**: Keeping configs in sync across machines

**Impact**: LOW - Convenience feature

**Enhancement Details**:
- Add `cloud-sync enable` to enable cloud sync
- Support backends: GitHub Gist, Dropbox, Google Drive, iCloud
- Encrypt before uploading
- Auto-sync on changes (with conflict resolution)

#### 4.4 Analytics & Insights
**Problem**: Users don't know which servers they use most

**Impact**: LOW - Informational

**Enhancement Details**:
- Track server usage (enable/disable frequency)
- Track sync operations
- Add `stats` command to show usage statistics
- Show most-used servers, least-used servers
- Suggest cleanup of unused servers

## Implementation Roadmap

### Phase 1: Foundation (Current + In-Progress)
- [x] Multi-provider support
- [x] Unified config
- [x] Bidirectional sync
- [x] Backups and diffs
- [x] Conflict resolution
- [ ] Autocomplete for enable/disable (Agent 1 - In Progress)
- [ ] Enhanced install command (Agent 2 - In Progress)

### Phase 2: Core Workflow (Priority 1)
- [ ] Project-specific server management (Claude)
- [ ] Bulk operations (enable-multiple, disable-multiple)
- [ ] Server discovery & registry integration
- [ ] Sync dry-run mode

### Phase 3: UX Improvements (Priority 2)
- [ ] Template/preset system
- [ ] Health check & diagnostics
- [ ] Version management
- [ ] Export/import functionality

### Phase 4: Advanced Features (Priority 3)
- [ ] Environment variable management
- [ ] Logging & debugging
- [ ] Provider-specific extensions
- [ ] Migration assistant

### Phase 5: Polish (Priority 4)
- [ ] TUI interface
- [ ] Hooks & automation
- [ ] Cloud sync
- [ ] Analytics & insights

## Technical Considerations

### Breaking Changes to Avoid
- Maintain backward compatibility with existing unified config format
- Version the config schema (add `version` field)
- Support migration from old to new formats

### Performance
- Cache provider configs to avoid repeated file reads
- Lazy-load providers (only initialize when needed)
- Stream large diffs instead of loading entire files

### Testing
- Add integration tests with fixture configs
- Mock file system operations for unit tests
- Test cross-platform compatibility (macOS, Linux, Windows)

### Documentation
- Update README with new commands
- Add examples for each new feature
- Create video tutorials for complex workflows
- Add troubleshooting guide

## Feedback & Iteration

After implementing each phase:
1. Gather user feedback
2. Measure adoption of new features
3. Identify pain points
4. Iterate on design
5. Prioritize next phase based on feedback

## Research Questions

### Claude Project Management
- How does Claude detect the current project? (Based on working directory?)
- Are project paths always absolute, or can they be relative?
- How does Claude handle nested projects?
- Can servers be enabled globally AND disabled for specific projects?
- What happens if a server is defined both globally and per-project?

**Recommendation**: Analyze real Claude config files from active users to understand project patterns.

### MCP Server Discovery
- Is there an official MCP server registry?
- How do users currently discover new servers? (GitHub, npm, word of mouth?)
- Should we build our own curated list or integrate with existing sources?

**Recommendation**: Research the MCP ecosystem and community resources.

### Multi-Provider Workflows
- Do users typically use multiple AI assistants simultaneously?
- What's the most common migration path? (Claude → Cursor? Cursor → Claude?)
- Should unified config be the single source of truth, or should it sync both ways?

**Recommendation**: Survey users about their multi-provider usage patterns.

## Conclusion

The mcp-manager tool has a solid foundation with comprehensive provider support, safe operations, and interactive workflows. The proposed enhancements focus on:

1. **Project-specific management** (critical for Claude users)
2. **Bulk operations** (time-saving for power users)
3. **Server discovery** (onboarding new users)
4. **Templates** (sharing and reuse)
5. **Health checks** (reducing support burden)

These enhancements will make mcp-manager the go-to tool for managing MCP servers across all AI assistants, while maintaining the safety and user-friendliness that define the current implementation.
