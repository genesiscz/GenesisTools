# Watchman `--temporary` Flag Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `--temporary` / `-t` flag to the watchman tool that automatically calls `watch-del` on exit so the directory doesn't stay in Watchman's watch list after the tool stops.

**Architecture:** Before starting the watch, check `watch-list` to see if the directory was already watched. If `--temporary` is set AND the directory was NOT pre-existing, call `watch-del` on SIGINT/SIGTERM/exit. This avoids accidentally unwatching a directory the user had intentionally set up. The `watchWithRetry` function needs to expose its successful client so the cleanup handler can use it.

**Tech Stack:** TypeScript, fb-watchman, Commander

---

### Task 1: Add `--temporary` flag to Commander and help text

**Files:**
- Modify: `src/watchman/index.ts:34-37` (Commander options)
- Modify: `src/watchman/index.ts:42-64` (help text)

**Step 1: Add the flag to Commander and update help**

In the Commander chain (line 34-37), add the `-t, --temporary` option:

```typescript
const program = new Command()
    .option("-c, --current", "Use current working directory")
    .option("-t, --temporary", "Remove watch when tool exits (won't unwatch pre-existing watches)")
    .option("-?, --help-full", "Show detailed help message")
    .parse();

const options = program.opts<{ current?: boolean; temporary?: boolean; helpFull?: boolean }>();
```

In the help text block (line 42-64), add the new option and example:

```
Options:
  -c, --current      Use current working directory
  -t, --temporary    Remove watch when tool exits
  -?, --help-full    Show this detailed help message
```

And add example:
```
  tools watchman -t .                 # Watch CWD, unwatch on exit
```

**Step 2: Commit**

```bash
git add src/watchman/index.ts
git commit -m "feat(watchman): add --temporary flag to Commander options"
```

---

### Task 2: Check pre-existing watches before starting

**Files:**
- Modify: `src/watchman/index.ts` (main IIFE at bottom, ~line 269-273)

**Step 1: Add pre-existing watch check**

Before calling `watchWithRetry`, query `watch-list` to check if the directory is already watched. Add this helper and update the main IIFE:

```typescript
async function getWatchedRoots(client: watchman.Client): Promise<string[]> {
    return new Promise((resolve) => {
        // biome-ignore lint/suspicious/noExplicitAny: fb-watchman Client lacks command() in types
        (client as any).command(["watch-list"], (err: unknown, resp: WatchmanResponse) => {
            if (err || !resp?.roots) {
                return resolve([]);
            }
            resolve(resp.roots);
        });
    });
}
```

Update the main IIFE:

```typescript
(async () => {
    const dirOfInterest = await getDirOfInterest();
    logger.info(`Directory of interest: ${dirOfInterest}`);

    const preExistingRoots = await getWatchedRoots(client);
    const wasAlreadyWatched = preExistingRoots.some(
        (root) => dirOfInterest === root || dirOfInterest.startsWith(root + "/")
    );

    if (options.temporary && wasAlreadyWatched) {
        logger.info("Directory already watched by Watchman — will NOT unwatch on exit");
    }

    const activeClient = await watchWithRetry(dirOfInterest);

    if (options.temporary && !wasAlreadyWatched) {
        setupCleanup(activeClient, dirOfInterest);
    }
})();
```

**Step 2: Commit**

```bash
git add src/watchman/index.ts
git commit -m "feat(watchman): detect pre-existing watches before starting"
```

---

### Task 3: Return the active client from `watchWithRetry`

**Files:**
- Modify: `src/watchman/index.ts` — `watchWithRetry` function (~line 203-267)

**Step 1: Update `watchWithRetry` to return the client**

Currently the function creates a new `fb-watchman.Client` per retry attempt but returns nothing. Change the return type and capture the successful client:

```typescript
async function watchWithRetry(dirOfInterest: string, maxRetries = 15): Promise<watchman.Client> {
    let attempt = 0;
    let lastError: unknown = null;
    let succeededClient: watchman.Client | null = null;
    while (attempt < maxRetries) {
        const client = new (require("fb-watchman").Client)();
        await new Promise<void>((resolve) => {
            client.capabilityCheck(
                { optional: [], required: ["relative_root"] },
                (capabilityError: unknown, _capabilityResp: unknown) => {
                    if (capabilityError) {
                        logger.error(
                            `Capability check failed (attempt ${attempt + 1}/${maxRetries}): ${capabilityError}`
                        );
                        lastError = capabilityError;
                        attempt++;
                        client.end();
                        setTimeout(resolve, 1000);
                        return;
                    }
                    // biome-ignore lint/suspicious/noExplicitAny: fb-watchman Client lacks command() in types
                    (client as any).command(
                        ["watch-project", dirOfInterest],
                        (watchError: unknown, watchResp: WatchmanResponse) => {
                            if (watchError) {
                                logger.error(
                                    `Error initiating watch (attempt ${attempt + 1}/${maxRetries}): ${watchError}`
                                );
                                lastError = watchError;
                                attempt++;
                                client.end();
                                setTimeout(resolve, 1000);
                                return;
                            }
                            if ("warning" in watchResp && watchResp.warning) {
                                logger.warn(`Warning: ${watchResp.warning}`);
                            }

                            if (!watchResp.watch) {
                                logger.error("watch-project response missing watch root");
                                lastError = new Error("watch-project response missing watch root");
                                attempt++;
                                client.end();
                                setTimeout(resolve, 1000);
                                return;
                            }

                            logger.info(
                                `Watch established on ${watchResp.watch} relative_path: ${watchResp.relative_path}`
                            );
                            makeSubscription(client, watchResp.watch, watchResp.relative_path);
                            succeededClient = client;
                            resolve();
                        }
                    );
                }
            );
        });

        if (succeededClient) {
            return succeededClient;
        }
    }

    logger.error(`Failed to establish watch after ${maxRetries} attempts. Exiting. ${lastError}`);
    process.exit(1);
}
```

**Step 2: Commit**

```bash
git add src/watchman/index.ts
git commit -m "feat(watchman): return active client from watchWithRetry"
```

---

### Task 4: Add cleanup handler for `--temporary`

**Files:**
- Modify: `src/watchman/index.ts` — add `setupCleanup` function

**Step 1: Add the cleanup function**

Place this before the main IIFE:

```typescript
function setupCleanup(activeClient: watchman.Client, dirOfInterest: string): void {
    let cleaned = false;

    const cleanup = () => {
        if (cleaned) {
            return;
        }
        cleaned = true;

        logger.info(`Temporary mode: removing watch for ${dirOfInterest}...`);
        // biome-ignore lint/suspicious/noExplicitAny: fb-watchman Client lacks command() in types
        (activeClient as any).command(
            ["watch-del", dirOfInterest],
            (err: unknown) => {
                if (err) {
                    logger.error(`Failed to remove watch: ${err}`);
                } else {
                    logger.info(`Watch removed for ${dirOfInterest}`);
                }
                activeClient.end();
                process.exit(0);
            }
        );
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
}
```

**Step 2: Commit**

```bash
git add src/watchman/index.ts
git commit -m "feat(watchman): add cleanup handler to unwatch on exit with --temporary"
```

---

### Task 5: Update README

**Files:**
- Modify: `src/watchman/README.md`

**Step 1: Add `--temporary` to options table and examples**

Add to the options table:

```markdown
| `--temporary` | `-t` | Remove watch when tool exits | `false` |
```

Add a usage section:

```markdown
### Temporary Watch (auto-cleanup)
\`\`\`bash
# Watch a directory temporarily — unwatch on Ctrl+C
tools watchman -t /path/to/project

# Combine with current directory shorthand
tools watchman -t -c
\`\`\`
```

**Step 2: Commit**

```bash
git add src/watchman/README.md
git commit -m "docs(watchman): document --temporary flag"
```
