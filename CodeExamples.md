# CLI Libraries - Code Examples

This document contains practical code examples for yargs, @cliffy/command, and @logtape/logtape.

---

## yargs - Complete Example

**File: `src/examples/yargs-example.ts`**

```typescript
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

interface Options {
  port?: number;
  host?: string;
  verbose?: boolean;
  config?: string;
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .command(
      'serve [port]',
      'Start development server',
      (yargs) => {
        return yargs
          .positional('port', {
            describe: 'Port number to listen on',
            default: 3000,
            type: 'number'
          })
          .option('host', {
            alias: 'h',
            describe: 'Host to bind to',
            default: 'localhost',
            type: 'string'
          })
          .option('verbose', {
            alias: 'v',
            describe: 'Enable verbose logging',
            type: 'boolean',
            default: false
          });
      },
      (argv) => {
        console.log(`Starting server on ${argv.host}:${argv.port}`);
        if (argv.verbose) {
          console.log('Verbose mode enabled');
        }
      }
    )
    .command(
      'build',
      'Build the project for production',
      (yargs) => {
        return yargs
          .option('minify', {
            describe: 'Minify output',
            type: 'boolean',
            default: true
          })
          .option('sourcemap', {
            alias: 's',
            describe: 'Generate source maps',
            type: 'boolean',
            default: false
          });
      },
      (argv) => {
        console.log('Building project...');
        if (argv.minify) console.log('  - Minifying');
        if (argv.sourcemap) console.log('  - Generating source maps');
      }
    )
    .command(
      'watch <path>',
      'Watch files for changes',
      (yargs) => {
        return yargs
          .positional('path', {
            describe: 'Path to watch',
            type: 'string'
          })
          .option('extensions', {
            alias: 'e',
            describe: 'File extensions to watch',
            type: 'array',
            default: ['.ts', '.js']
          });
      },
      (argv) => {
        console.log(`Watching ${argv.path} for changes...`);
        console.log(`Watching extensions: ${(argv.extensions as string[]).join(', ')}`);
      }
    )
    .option('config', {
      alias: 'c',
      describe: 'Path to config file',
      type: 'string'
    })
    .alias('help', 'h')
    .alias('version', 'v')
    .version('1.0.0')
    .strict()
    .parse();
}

main().catch(console.error);
```

### Usage Examples

```bash
# Start server with custom port and verbose logging
bun run src/examples/yargs-example.ts serve 8080 --host 0.0.0.0 --verbose

# Build for production with minification and sourcemaps
bun run src/examples/yargs-example.ts build --minify --sourcemap

# Watch TypeScript and TSX files
bun run src/examples/yargs-example.ts watch src -e .ts -e .tsx

# Show help
bun run src/examples/yargs-example.ts --help
bun run src/examples/yargs-example.ts serve --help
```

---

## @cliffy/command - Complete Example

**File: `examples/cliffy-example.ts`**

```typescript
import { Command } from "https://deno.land/x/cliffy/command/mod.ts";
import { Table } from "https://deno.land/x/cliffy/table/mod.ts";

interface Config {
  debug?: boolean;
  verbose?: boolean;
}

await new Command()
  .name("mytool")
  .version("1.0.0")
  .description("A powerful CLI tool built with Cliffy")
  .globalOption("-d, --debug", "Enable debug mode")
  .globalOption("-v, --verbose", "Enable verbose logging")

  // Serve command
  .command("serve [port]", "Start development server")
    .option("-h, --host <host:string>", "Host to bind to", { default: "localhost" })
    .option("-w, --watch", "Watch for file changes")
    .action(({ port = 3000, host, watch, debug, verbose }) => {
      console.log(`Starting server on ${host}:${port}`);
      if (watch) console.log("File watching enabled");
      if (verbose) console.log("Verbose mode enabled");
      if (debug) console.log("Debug mode enabled");
    })

  // Build command with subcommands
  .command("build", "Build the project")
    .command("dev", "Build for development")
      .option("-s, --sourcemap", "Generate source maps")
      .action(({ sourcemap, debug }) => {
        console.log("Building for development...");
        if (sourcemap) console.log("  - Generating source maps");
        if (debug) console.log("  - Debug info included");
      })
    .command("prod", "Build for production")
      .option("-m, --minify", "Minify output", { default: true })
      .option("--strip-comments", "Strip comments")
      .action(({ minify, stripComments }) => {
        console.log("Building for production...");
        if (minify) console.log("  - Minifying");
        if (stripComments) console.log("  - Stripping comments");
      })

  // Config command with subcommands
  .command("config", "Manage configuration")
    .command("set <key> <value>", "Set a configuration value")
      .action(({ key, value }) => {
        console.log(`Set config: ${key} = ${value}`);
      })
    .command("get <key>", "Get a configuration value")
      .action(({ key }) => {
        console.log(`Get config: ${key}`);
      })
    .command("list", "List all configuration")
      .action(() => {
        const data = [
          ["Key", "Value"],
          ["debug", "false"],
          ["theme", "dark"],
          ["port", "3000"],
        ];
        new Table().header(data[0]).body(data.slice(1)).render();
      })

  // Watch command
  .command("watch <pattern>", "Watch files for changes")
    .option("-e, --extensions <exts...:string>", "File extensions to watch", {
      default: [".ts", ".js"]
    })
    .option("--run <cmd:string>", "Command to run on change")
    .action(({ pattern, extensions, run, verbose }) => {
      console.log(`Watching ${pattern}...`);
      console.log(`Extensions: ${extensions.join(", ")}`);
      if (run) console.log(`Running on change: ${run}`);
      if (verbose) console.log("Verbose output enabled");
    })

  .parse(Deno.args);
```

### Usage Examples

```bash
# Start server with file watching
deno run examples/cliffy-example.ts serve 8080 --host 0.0.0.0 --watch

# Build for development with sourcemaps
deno run examples/cliffy-example.ts build dev --sourcemap

# Build for production with minification
deno run examples/cliffy-example.ts build prod --minify

# List configuration
deno run examples/cliffy-example.ts config list

# Set configuration
deno run examples/cliffy-example.ts config set theme dark

# Watch TypeScript files
deno run examples/cliffy-example.ts watch "src/**/*.ts" -e .ts -e .tsx --run "build"

# Show help
deno run examples/cliffy-example.ts --help
deno run examples/cliffy-example.ts serve --help
```

---

## @logtape/logtape - Complete Example

**File: `src/examples/logtape-example.ts`**

```typescript
import { configure, getLogger } from "@logtape/logtape";

// Configure logtape with different sinks and log levels
configure({
  sinks: {
    console: {
      type: "console",
      format: "json"  // or "compact"
    }
  },
  loggers: [
    {
      category: "genesis",
      level: "debug"
    },
    {
      category: "genesis.sync",
      level: "info"
    },
    {
      category: "genesis.watch",
      level: "debug"
    },
    {
      category: "genesis.build",
      level: "info"
    }
  ]
});

// Main application logger
const mainLogger = getLogger("genesis");

// Tool-specific loggers (hierarchical)
const syncLogger = getLogger("genesis.sync");
const watchLogger = getLogger("genesis.watch");
const buildLogger = getLogger("genesis.build");

async function exampleSync() {
  syncLogger.info("Starting sync operation");

  try {
    syncLogger.debug("Connecting to remote", {
      host: "api.example.com",
      port: 443
    });

    // Simulate work
    await new Promise(resolve => setTimeout(resolve, 100));

    syncLogger.info("Data synced successfully", {
      itemsCount: 42,
      duration: 100,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    syncLogger.error("Sync failed", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      retryable: true
    });
  }
}

async function exampleWatch() {
  watchLogger.info("Starting file watcher", {
    pattern: "src/**/*.ts",
    extensions: [".ts", ".tsx"]
  });

  watchLogger.debug("Watcher initialized", {
    ignorePaths: ["node_modules", ".git", "dist"]
  });

  // Simulate file change
  watchLogger.info("File changed detected", {
    file: "src/index.ts",
    type: "modified",
    timestamp: new Date().toISOString()
  });
}

async function exampleBuild() {
  buildLogger.info("Build started");

  try {
    buildLogger.debug("Resolving dependencies", {
      count: 156
    });

    buildLogger.info("Compiling TypeScript", {
      files: 42,
      errors: 0,
      warnings: 2
    });

    buildLogger.info("Bundling assets", {
      bundles: 3,
      totalSize: "2.4MB"
    });

    buildLogger.info("Build completed successfully", {
      duration: 2500,
      output: "dist/",
      version: "1.0.0"
    });

  } catch (error) {
    buildLogger.error("Build failed", {
      phase: "bundling",
      error: error instanceof Error ? error.message : String(error),
      exitCode: 1
    });
    throw error;
  }
}

async function exampleWithContext() {
  // Logging with rich context for debugging
  mainLogger.info("Application initialized", {
    version: "1.0.0",
    environment: "development",
    bun_version: Bun.version,
    platform: process.platform,
    timestamp: new Date().toISOString()
  });

  const userId = "user-123";
  const requestId = "req-456";

  mainLogger.debug("Processing user action", {
    userId,
    requestId,
    action: "data-import",
    metadata: {
      source: "csv",
      rows: 1000,
      columns: 15
    }
  });
}

// Run examples
async function main() {
  mainLogger.info("Running logtape examples");

  await exampleSync();
  console.log("---");

  await exampleWatch();
  console.log("---");

  await exampleBuild();
  console.log("---");

  await exampleWithContext();

  mainLogger.info("All examples completed");
}

main().catch((error) => {
  mainLogger.error("Fatal error", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  });
  process.exit(1);
});
```

### Usage Examples

```bash
# Run all examples
bun run src/examples/logtape-example.ts

# Use in your own code
import { getLogger } from "@logtape/logtape";

const logger = getLogger("my-tool");
logger.info("Tool started");
logger.debug("Debug info", { key: "value" });
logger.error("An error occurred", { reason: "connection failed" });
```

### Output Format

LogTape outputs structured JSON by default:

```json
{"level":"info","category":"genesis.sync","message":"Starting sync operation","timestamp":"2025-01-13T10:30:00Z"}
{"level":"debug","category":"genesis.sync","message":"Connecting to remote","host":"api.example.com","port":443}
{"level":"info","category":"genesis.sync","message":"Data synced successfully","itemsCount":42,"duration":100}
```

---

## Quick Reference

### yargs - Best for:
- Complex Node.js/Bun CLI tools
- Multiple commands and subcommands
- Automatic help generation
- Shell completions

### @cliffy/command - Best for:
- Deno CLI applications
- Type-safe argument parsing
- Built-in validation
- Structured subcommand hierarchies

### @logtape/logtape - Best for:
- Hierarchical logging with categories
- Structured logging with rich context
- Cross-runtime applications (Deno, Node.js, Bun, Browser)
- Minimal dependencies
