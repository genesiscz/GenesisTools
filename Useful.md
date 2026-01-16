# Useful CLI Tools & Libraries

This document provides an overview of useful command-line argument parsing and CLI framework libraries.

## yargs

**yargs** is a Node.js library that helps developers build interactive command-line tools. It's known as the modern, pirate-themed successor to optimist.

### Functionality

- **Command support**: Define commands with options (e.g., `my-program serve --port=5000`)
- **Automatic help generation**: Dynamically creates help documentation based on argument definitions
- **Shell completion**: Generates completion scripts for Bash and Zsh
- **Flexible configuration**: Supports commands, grouped options, and complex argument parsing
- **Cross-platform support**: Works with TypeScript, Deno, Browser, and Node.js

### Installation

```bash
npm install yargs
```

For the latest development version:
```bash
npm install yargs@next
```

For Bun (GenesisTools):
```bash
bun add yargs
```

### Basic Usage Example

**Simple argument parsing:**
```javascript
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .option('verbose', {
    alias: 'v',
    type: 'boolean',
    description: 'Run with verbose logging'
  })
  .option('port', {
    alias: 'p',
    type: 'number',
    default: 3000,
    description: 'Port to run on'
  })
  .parse();

console.log('Verbose:', argv.verbose);
console.log('Port:', argv.port);
```

**With commands and handlers:**
```javascript
yargs(hideBin(process.argv))
  .command({
    command: 'serve [port]',
    description: 'Start the server',
    builder: (yargs) => {
      return yargs.positional('port', {
        describe: 'Port number',
        default: 5000
      });
    },
    handler: (argv) => {
      console.log(`Server running on port ${argv.port}`);
    }
  })
  .command({
    command: 'build',
    description: 'Build the project',
    handler: (argv) => {
      console.log('Building...');
    }
  })
  .help()
  .alias('help', 'h')
  .parse();
```

### TypeScript Support

Type definitions are available via `@types/yargs`:
```bash
bun add -D @types/yargs
```

---

## @cliffy/command

**Cliffy** is a TypeScript-based CLI framework for Deno that simplifies building command-line tools. The `@cliffy/command` module is specifically designed for creating complex, type-safe command-line applications.

### Functionality

- **Type Safety**: Built with TypeScript for robust type checking
- **Input Validation**: Automatically validates command arguments and options
- **Auto-Generated Help**: Creates comprehensive help documentation without manual setup
- **Shell Completions**: Generates completion scripts for bash, zsh, and other shells
- **Subcommands**: Supports hierarchical command structures
- **Options & Arguments Parsing**: Integrated argument handling with the flags module

### Related Cliffy Modules

Cliffy provides complementary modules:
- **Flags**: Handles argument parsing
- **Prompt**: Enables interactive user input
- **ANSI**: Provides styled terminal output
- **Table**: Formats data display

### Basic Usage Example

**Creating a command:**
```typescript
import { Command } from "https://deno.land/x/cliffy/command/mod.ts";

await new Command()
  .name("myapp")
  .version("v1.0.0")
  .description("My awesome CLI application")
  .command("serve", "Start the server")
    .option("-p, --port <port:number>", "Port number", { default: 3000 })
    .action(({ port }) => {
      console.log(`Server running on port ${port}`);
    })
  .command("build", "Build the project")
    .action(() => {
      console.log("Building...");
    })
  .parse(Deno.args);
```

**With subcommands and complex options:**
```typescript
import { Command } from "https://deno.land/x/cliffy/command/mod.ts";

await new Command()
  .name("myapp")
  .description("Complex CLI application")
  .command("config", "Manage configuration")
    .command("set <key> <value>", "Set a configuration value")
      .action((options, key, value) => {
        console.log(`Set ${key} = ${value}`);
      })
    .command("get <key>", "Get a configuration value")
      .action((options, key) => {
        console.log(`Get ${key}`);
      })
    .command("list", "List all configuration")
      .action(() => {
        console.log("Configuration list...");
      })
  .command("build", "Build the project")
    .option("-o, --output <dir:string>", "Output directory")
    .option("-m, --minify", "Minify output")
    .option("-s, --sourcemap", "Generate sourcemap")
    .action(({ output, minify, sourcemap }) => {
      console.log(`Building to ${output}...`);
      if (minify) console.log("Minifying...");
      if (sourcemap) console.log("Generating sourcemap...");
    })
  .parse(Deno.args);
```

### Documentation

Full documentation available at: [Cliffy Command Documentation](https://cliffy.io/docs/command/)

---

## @logtape/logtape

**LogTape** is a zero-dependency logging library designed for JavaScript and TypeScript across multiple runtimes. It supports Deno, Node.js, Bun, browsers, and edge functions with a unified API.

### Functionality

- **Zero dependencies**: No external packages required
- **Hierarchical categories**: Organized logging with nested namespaces
- **Structured logging**: Typed data logging for better context
- **Template literal support**: Flexible message formatting
- **Cross-runtime support**: Works on Deno, Node.js, Bun, browsers, and edge functions
- **Data redaction**: Pattern and field-based redaction for sensitive information
- **Framework integrations**: Built-in support for Express, Fastify, Hono, Koa, and Drizzle ORM
- **Custom sinks**: Dead simple sink system for custom log destinations

### Installation

For Bun (GenesisTools):
```bash
bun add @logtape/logtape
```

For npm:
```bash
npm install @logtape/logtape
```

For Deno:
```bash
deno add jsr:@logtape/logtape
```

### Basic Usage Example

**Simple logging with categories:**
```typescript
import { getLogger } from "@logtape/logtape";

const logger = getLogger("myapp");

// Basic logging
logger.debug("Debug message");
logger.info("Application started");
logger.warn("This is a warning");
logger.error("An error occurred");
```

**Hierarchical categories:**
```typescript
import { getLogger } from "@logtape/logtape";

// Parent logger
const appLogger = getLogger("myapp");

// Child loggers (hierarchical)
const httpLogger = getLogger("myapp.http");
const dbLogger = getLogger("myapp.database");
const syncLogger = getLogger("myapp.sync");

appLogger.info("App initialized");
httpLogger.debug("HTTP request received");
dbLogger.info("Database connected");
syncLogger.warn("Sync in progress");
```

**Structured logging with typed data:**
```typescript
import { getLogger } from "@logtape/logtape";

const logger = getLogger("myapp.api");

logger.info("User login attempt", {
  userId: 12345,
  timestamp: new Date().toISOString(),
  endpoint: "/api/login",
  metadata: {
    ip: "192.168.1.1",
    userAgent: "Mozilla/5.0..."
  }
});

logger.error("Database query failed", {
  query: "SELECT * FROM users",
  error: "Connection timeout",
  duration: 5000
});
```

**With configuration and sinks:**
```typescript
import { getLogger, configure } from "@logtape/logtape";

// Configure logging
configure({
  sinks: {
    console: {
      type: "console"
    },
    file: {
      type: "rotating-file",
      filename: "./logs/app.log",
      maxSize: 10485760, // 10MB
      maxFiles: 5
    }
  },
  loggers: [
    {
      category: "myapp",
      level: "debug",
      sinks: ["console", "file"]
    },
    {
      category: "myapp.http",
      level: "info",
      sinks: ["console"]
    }
  ]
});

const logger = getLogger("myapp");
logger.info("Configured logger ready");
```

**Example: GenesisTools Tool Logging**
```typescript
import { getLogger } from "@logtape/logtape";

async function main() {
  const logger = getLogger("genesis-tools.my-tool");

  try {
    logger.debug("Tool started with options", { verbose: true });

    // Do work
    logger.info("Processing file", { file: "input.txt" });

    const result = await processInput();
    logger.info("Processing complete", { status: "success", result });

  } catch (error) {
    logger.error("Tool failed", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    process.exit(1);
  }
}
```

### Documentation

Full documentation and API references available at:
- [LogTape Documentation](https://logtape.org)
- [JSR Package](https://jsr.io/@logtape/logtape)

---

## Comparison

### CLI Argument Parsing

| Feature | yargs | @cliffy/command |
|---------|-------|-----------------|
| Language | JavaScript/TypeScript | TypeScript |
| Runtime | Node.js, Deno, Browser | Deno |
| Type Safety | Via @types/yargs | Built-in |
| Learning Curve | Moderate | Gentle |
| Community | Large (11.4k stars) | Growing (1.1k stars) |
| Subcommands | Yes | Yes |
| Auto Help | Yes | Yes |
| Shell Completion | Yes | Yes |
| Input Validation | Manual/Plugin | Built-in |

### Logging

| Feature | @logtape/logtape | pino (GenesisTools current) |
|---------|------------------|---------------------------|
| Dependencies | Zero | Multiple |
| Runtime Support | Deno, Node.js, Bun, Browser | Node.js focused |
| Hierarchical Categories | Yes | No |
| Structured Logging | Yes | Yes |
| Cross-Runtime | Yes | No |
| Zero Config | Yes | Can be zero-config |

## Usage in GenesisTools

### Argument Parsing
GenesisTools uses **commander** for argument parsing. It provides:

- **Subcommands**: Define hierarchical command structures with `.command()`
- **Options**: Strongly typed options with `.option()` and automatic help generation
- **Action handlers**: Clean separation of command logic with `.action()`

For interactive prompts, GenesisTools uses **@inquirer/prompts** which provides:

- **Modern API**: Promise-based with individual prompt functions (`select`, `input`, `confirm`, etc.)
- **Type safety**: Built-in TypeScript support
- **Cancellation handling**: `ExitPromptError` from `@inquirer/core` for clean user cancellation

### Logging
GenesisTools currently uses **pino** for logging. **@logtape/logtape** offers advantages:

- **Zero dependencies**: Reduces package overhead
- **Hierarchical categories**: Better organization for tool-specific logging (e.g., `genesis-tools.sync`, `genesis-tools.watch`)
- **Cross-runtime**: Works seamlessly on Deno, Node.js, Bun, and browsers
- **Simpler integration**: No complex configuration required for basic use

For GenesisTools' Bun-based environment with multi-runtime support, **@logtape/logtape** could be a compelling alternative for improved logging organization and reduced dependencies.
