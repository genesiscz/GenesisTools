# macOS ESLogger Monitor

A powerful command-line tool for real-time monitoring of macOS Endpoint Security events using the ESLogger utility.

## Overview

This tool provides an easy-to-use interface for monitoring macOS system events through the Endpoint Security Framework. It wraps the `eslogger` command-line tool with enhanced filtering, formatting, and output options.

## Features

- **Real-time Event Monitoring**: Monitor system events as they happen
- **Event Filtering**: Filter events using JSON path expressions
- **Multiple Output Formats**: Console output, file logging, or clipboard
- **Event Categories**: Pre-defined groups of related events
- **Interactive Mode**: Easy setup for beginners
- **Debug Mode**: Raw JSON output for troubleshooting

## Requirements

- **macOS**: 10.15+ (Catalina or later)
- **Permissions**: Requires sudo privileges to run `eslogger`
- **Full Disk Access**: The tool needs Full Disk Access in System Preferences > Security & Privacy > Privacy > Full Disk Access

## Installation

This tool is part of the GenesisTools collection. See the main README for installation instructions.

## Usage

### Basic Usage

```bash
# Interactive mode (recommended for beginners)
tools macos-eslogger

# Monitor specific events
tools macos-eslogger -e exec,fork,exit

# Monitor event categories
tools macos-eslogger -c process

# Monitor with filtering
tools macos-eslogger -e exec --filter-event '.event.target.path =~ ".*bash.*"'
```

### Command Line Options

```
USAGE:
  tools macos-eslogger [options]

ARGUMENTS:
  -e, --events <list>     Comma-separated list of event types to monitor
  -c, --category <cat>    Monitor all events in a category
  -o, --output <file>     Write output to file instead of stdout
  -v, --verbose           Enable verbose logging
  -s, --silent            Suppress non-error messages
  -d, --dry-run           Show what would be monitored without running eslogger
  --debug                 Show raw JSON for each event (useful for debugging)
  --include-fork          Automatically include 'fork' events when monitoring 'exec'
  --filter-event <expr>   Filter events using JSON path expression
  -h, --help              Show this help message
```

### Event Categories

- **process**: exec, fork, exit
- **file**: open, close, create, write, unlink, rename
- **network**: uipc_bind, uipc_connect
- **security**: authentication, sudo, su, setuid, setgid, xp_malware_detected
- **session**: Various login/logout events
- **auth**: Authorization events

### Popular Events

- **exec**: Process execution events
- **fork**: Process fork events
- **exit**: Process termination events
- **open**: File open events
- **write**: File write events
- **authentication**: Authentication events
- **sudo**: Sudo command usage

## Filter Syntax

Filter events using JSON path expressions with dot notation:

```bash
# Regex matching (recommended for patterns)
.event.target.path =~ ".*bash.*"        # Paths containing "bash"
.event.target.path =~ "^/usr/.*"        # Paths starting with "/usr/"

# Exact string matching
.event.target.path == "/bin/bash"       # Exact path match

# Numeric comparisons
.process.audit_token.pid == "1234"      # Specific PID

# Regex exclusion
.event.target.path !~ ".*tmp.*"         # Exclude tmp paths
```

### Examples

```bash
# Monitor all process events
tools macos-eslogger -c process

# Monitor exec events for bash processes only
tools macos-eslogger -e exec --filter-event '.event.target.path =~ ".*bash.*"'

# Monitor file operations but exclude temporary files
tools macos-eslogger -e open,write --filter-event '.event.file.path !~ ".*tmp.*"'

# Save authentication events to file
tools macos-eslogger -e authentication -o auth.log

# Debug mode to see raw event structure
tools macos-eslogger -e exec --debug --dry-run
```

## Understanding Events

### Process Events

- **exec**: A process executes another program
  - `event.target.path`: The executable being run
  - `event.args`: Command line arguments
  - `process.executable.path`: The process doing the executing

- **fork**: A process creates a child process
  - `event.child.executable.path`: The child process executable
  - `process.executable.path`: The parent process

### File Events

- **open**: A file is opened
  - `event.file.path`: The file path
  - `event.fflag`: Open flags (read/write/etc.)

- **write**: Data is written to a file
  - `event.target.path`: The file being written to

### Security Events

- **authentication**: Authentication attempts
  - `event.success`: Whether authentication succeeded
  - `event.type`: Authentication type

- **sudo**: Sudo command usage
  - `event.success`: Whether sudo succeeded
  - `event.command`: The command being run with sudo

## Troubleshooting

### Shell Builtins Don't Trigger Events

Shell builtins like `which`, `cd`, `echo` in zsh/bash don't trigger exec events because they run within the shell process. Use external executables:

```bash
# Instead of: which playwright
/usr/bin/which playwright
```

### Process Group Suppression

`eslogger` suppresses events from its own process group to avoid feedback loops. Run commands in separate terminal windows/sessions.

### Permission Issues

If you get permission errors:
1. Run with `sudo`
2. Ensure Full Disk Access is granted in System Preferences
3. Check that TCC permissions are set correctly

### Filter Not Working

- Use `--debug` to see raw event structure
- Check JSON path syntax with `--dry-run`
- Verify event types with `eslogger --list-events`

## Technical Details

### Event Structure

Events follow the Endpoint Security Framework JSON format:

```json
{
  "version": 10,
  "seq_num": 123,
  "event_type": "ES_EVENT_TYPE_NOTIFY_EXEC",
  "process": {
    "audit_token": {
      "pid": 1234,
      "euid": 501,
      "ppid": 1
    },
    "executable": {
      "path": "/bin/bash"
    }
  },
  "event": {
    "target": {
      "path": "/usr/bin/which"
    },
    "args": ["playwright"],
    "cwd": {
      "path": "/Users/username"
    }
  }
}
```

### Limitations

- Only supports "notify" events (not "auth" events)
- Requires sudo privileges
- macOS-only due to Endpoint Security Framework
- Events may be filtered by system policies

## Contributing

See the main GenesisTools README for contribution guidelines.
