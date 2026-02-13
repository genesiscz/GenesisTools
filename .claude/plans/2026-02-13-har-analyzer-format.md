# HAR Analyzer Structured `--format json` Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `--format json` emit properly structured JSON per command instead of wrapping markdown text in `{"output": "..."}`, so LLMs and scripts can parse fields directly.

**Architecture:** Each command gets a `toJSON()` function that returns a typed data object. A shared `outputResult()` helper in `formatter.ts` checks the format flag and either prints text (existing path) or calls `JSON.stringify` on the structured data. The `export` command already outputs JSON and needs no change.

**Tech Stack:** Bun, TypeScript, Commander CLI

---

### Task 1: Add `--format` flag and `outputResult()` helper

**Files:**
- Modify: `src/har-analyzer/index.ts` (add `--format` global option)
- Modify: `src/har-analyzer/types.ts` (add `OutputFormat` type, update `OutputOptions`)
- Modify: `src/har-analyzer/core/formatter.ts` (add `outputResult()` helper)

**Step 1: Add `OutputFormat` type and update `OutputOptions` in types**

In `src/har-analyzer/types.ts`, add the format type and update `OutputOptions`:

The existing `OutputFormat` type is `"md" | "json" | "toon"` (defined in `src/har-analyzer/types.ts`). The `outputResult()` helper should accept this same type and map `"md"` to the text output path:

```typescript
// Already defined in types.ts — no change needed:
export type OutputFormat = "md" | "json" | "toon";
```

Update the `OutputOptions` interface:

```typescript
export interface OutputOptions {
	full?: boolean;
	includeAll?: boolean;
	verbose?: boolean;
	format?: OutputFormat;
}
```

**Step 2: Add `--format` CLI option**

In `src/har-analyzer/index.ts`, add the format option to the program:

```typescript
program
	.name("har-analyzer")
	.description("Token-efficient HAR file analyzer with reference system")
	.option("--full", "Show full output without references (bypass ref system)")
	.option("--include-all", "Include bodies of static assets (CSS, JS, images, fonts)")
	.option("--format <format>", "Output format: text, json", "text")
	.option("-v, --verbose", "Verbose logging")
	.option("-i, --interactive", "Launch interactive mode");
```

**Step 3: Add `outputResult()` helper to formatter**

In `src/har-analyzer/core/formatter.ts`, add a generic output function:

```typescript
import type { OutputFormat } from "@app/har-analyzer/types.ts";

/**
 * Output a command result in the requested format.
 * - "text": prints the textOutput string
 * - "json": prints JSON.stringify of the structured data
 */
export function outputResult(format: OutputFormat | undefined, textOutput: string, structuredData: unknown): void {
	if (format === "json") {
		console.log(JSON.stringify(structuredData));
	} else {
		console.log(textOutput);
	}
}
```

**Step 4: Verify it compiles**

Run: `cd /Users/Martin/Tresors/Projects/GenesisTools && bunx tsgo --noEmit 2>&1 | rg "har-analyzer|formatter"`
Expected: No errors related to these files.

**Step 5: Commit**

```bash
git add src/har-analyzer/index.ts src/har-analyzer/types.ts src/har-analyzer/core/formatter.ts
git commit -m "feat(har-analyzer): add --format flag and outputResult helper"
```

---

### Task 2: Structured JSON for `list` and `errors` commands

These two commands share a similar pattern: filter entries, build a table, print it.

**Files:**
- Modify: `src/har-analyzer/commands/list.ts`
- Modify: `src/har-analyzer/commands/errors.ts`

**Step 1: Add structured output to `list` command**

In `src/har-analyzer/commands/list.ts`:

1. Import `outputResult` and `OutputOptions`:

```typescript
import { truncatePath, outputResult } from "@app/har-analyzer/core/formatter";
import type { EntryFilter, OutputOptions } from "@app/har-analyzer/types";
```

2. In the `.action()` handler, after building `entries`, get parent opts and branch:

```typescript
.action(async (options: ListOptions) => {
	const sm = new SessionManager();
	const session = await sm.requireSession();
	const parentOpts = program.opts<OutputOptions>();

	const filter: EntryFilter = {
		domain: options.domain,
		url: options.url,
		status: options.status,
		method: options.method,
		type: options.type,
		minTime: options.minTime ? Number(options.minTime) : undefined,
		minSize: options.minSize ? Number(options.minSize) : undefined,
		limit: Number(options.limit),
	};

	const entries = filterEntries(session.entries, filter);

	if (entries.length === 0) {
		if (parentOpts.format === "json") {
			console.log(JSON.stringify({ command: "list", entries: [], total: session.entries.length, filtered: 0 }));
		} else {
			console.log("No entries match the filter criteria.");
		}
		return;
	}

	// Structured data
	const structured = {
		command: "list",
		entries: entries.map((entry) => ({
			index: entry.index,
			method: entry.method,
			url: entry.url,
			path: entry.path,
			status: entry.status,
			mimeType: entry.mimeType,
			responseSize: entry.responseSize,
			timeMs: entry.timeMs,
		})),
		total: session.entries.length,
		filtered: entries.length,
	};

	// Text output (existing logic)
	const headers = ["#", "Method", "Path", "Status", "Size", "Time"];
	const rows = entries.map((entry) => [
		`e${entry.index}`,
		entry.method,
		truncatePath(entry.path, 40),
		String(entry.status),
		formatBytes(entry.responseSize),
		formatDuration(entry.timeMs, "ms", "tiered"),
	]);
	const textOutput = formatTable(rows, headers, { alignRight: [4, 5] }) + `\n\n${entries.length} entries shown`;

	outputResult(parentOpts.format, textOutput, structured);
});
```

**Step 2: Add structured output to `errors` command**

In `src/har-analyzer/commands/errors.ts`:

1. Import `outputResult` and `OutputOptions`:

```typescript
import { truncatePath, outputResult } from "@app/har-analyzer/core/formatter";
import type { HarEntry, IndexedEntry, OutputOptions } from "@app/har-analyzer/types";
```

2. In the `.action()` handler, get parent opts and add a JSON branch before text formatting. The key change: when format is JSON, build structured data directly from `errorEntries` without going through `formatErrorEntry`:

```typescript
.action(async () => {
	const sm = new SessionManager();
	const session = await sm.requireSession();
	const parentOpts = program.opts<OutputOptions>();

	const errorEntries = filterEntries(session.entries, {}).filter((e) => e.isError);

	if (errorEntries.length === 0) {
		if (parentOpts.format === "json") {
			console.log(JSON.stringify({ command: "errors", clientErrors: [], serverErrors: [], total: 0 }));
		} else {
			console.log("No error responses found.");
		}
		return;
	}

	const clientErrors: IndexedEntry[] = [];
	const serverErrors: IndexedEntry[] = [];

	for (const entry of errorEntries) {
		if (entry.status >= 400 && entry.status < 500) {
			clientErrors.push(entry);
		} else if (entry.status >= 500) {
			serverErrors.push(entry);
		}
	}

	if (parentOpts.format === "json") {
		const har = await loadHarFile(session.sourceFile);
		const toErrorObj = (entry: IndexedEntry) => {
			const rawEntry = har.log.entries[entry.index];
			const bodyText = rawEntry.response.content.text;
			return {
				index: entry.index,
				method: entry.method,
				status: entry.status,
				statusText: entry.statusText,
				url: entry.url,
				path: entry.path,
				timeMs: entry.timeMs,
				responseBody: bodyText?.slice(0, 500) ?? null,
			};
		};
		console.log(JSON.stringify({
			command: "errors",
			clientErrors: clientErrors.map(toErrorObj),
			serverErrors: serverErrors.map(toErrorObj),
			total: errorEntries.length,
		}));
		return;
	}

	// ... existing text formatting code unchanged ...
```

**Step 3: Verify compilation**

Run: `cd /Users/Martin/Tresors/Projects/GenesisTools && bunx tsgo --noEmit 2>&1 | rg "har-analyzer"`
Expected: No errors.

**Step 4: Manual smoke test**

Run: `tools har-analyzer list --format json 2>/dev/null | head -c 200`
Expected: JSON output starting with `{"command":"list","entries":[{`

Run: `tools har-analyzer errors --format json 2>/dev/null | head -c 200`
Expected: JSON output starting with `{"command":"errors",`

**Step 5: Commit**

```bash
git add src/har-analyzer/commands/list.ts src/har-analyzer/commands/errors.ts
git commit -m "feat(har-analyzer): structured JSON for list and errors commands"
```

---

### Task 3: Structured JSON for `dashboard` and `domains` commands

**Files:**
- Modify: `src/har-analyzer/commands/dashboard.ts`
- Modify: `src/har-analyzer/commands/domains.ts`

**Step 1: Add structured output to `dashboard`**

In `src/har-analyzer/commands/dashboard.ts`:

```typescript
import type { Command } from "commander";
import { SessionManager } from "@app/har-analyzer/core/session-manager";
import { formatDashboard, outputResult } from "@app/har-analyzer/core/formatter";
import type { OutputOptions } from "@app/har-analyzer/types";

export function registerDashboardCommand(program: Command): void {
	program
		.command("dashboard")
		.description("Show overview dashboard for loaded HAR")
		.action(async () => {
			const sm = new SessionManager();
			const session = await sm.requireSession();
			const parentOpts = program.opts<OutputOptions>();

			const structured = {
				command: "dashboard",
				sourceFile: session.sourceFile,
				stats: {
					entryCount: session.stats.entryCount,
					totalSizeBytes: session.stats.totalSizeBytes,
					totalTimeMs: session.stats.totalTimeMs,
					errorCount: session.stats.errorCount,
					startTime: session.stats.startTime,
					endTime: session.stats.endTime,
					statusDistribution: session.stats.statusDistribution,
					domains: session.stats.domains,
					mimeTypeDistribution: session.stats.mimeTypeDistribution,
				},
			};

			outputResult(parentOpts.format, formatDashboard(session.stats, session.sourceFile), structured);
		});
}
```

**Step 2: Add structured output to `domains`**

In `src/har-analyzer/commands/domains.ts`, in the `registerDomainsCommand` action handler:

1. Import `outputResult`:

```typescript
import { truncatePath, outputResult } from "@app/har-analyzer/core/formatter";
```

2. After building `domainStats` array and sorting, branch on format:

```typescript
domainStats.sort((a, b) => b.count - a.count);

const parentOpts = program.opts<OutputOptions>();

const structured = {
	command: "domains",
	domains: domainStats,
};

const headers = ["Domain", "Count", "Total Size", "Avg Time"];
const rows = domainStats.map((d) => [
	d.domain,
	String(d.count),
	formatBytes(d.totalSize),
	formatDuration(d.avgTime),
]);
const textOutput = formatTable(rows, headers, { alignRight: [1, 2, 3] }) + `\n\n${domainStats.length} domains`;

outputResult(parentOpts.format, textOutput, structured);
```

Note: The `domain <name>` subcommand (registerDomainCommand) also needs structured output. Add similar logic there -- the structured data should include the domain name and the list of entries with body previews omitted (just entry metadata):

```typescript
// In registerDomainCommand action, after building rows:
if (parentOpts.format === "json") {
	const structured = {
		command: "domain",
		domain: name,
		entries: entries.map((entry) => ({
			index: entry.index,
			method: entry.method,
			path: entry.path,
			status: entry.status,
			mimeType: entry.mimeType,
			responseSize: entry.responseSize,
			timeMs: entry.timeMs,
		})),
		total: entries.length,
	};
	console.log(JSON.stringify(structured));
	return;
}
// ... existing text code ...
```

Place the JSON branch early in the action handler, before the `har` file is loaded and ref store is created (since JSON mode does not need bodies/refs).

**Step 3: Verify compilation**

Run: `cd /Users/Martin/Tresors/Projects/GenesisTools && bunx tsgo --noEmit 2>&1 | rg "har-analyzer"`
Expected: No errors.

**Step 4: Commit**

```bash
git add src/har-analyzer/commands/dashboard.ts src/har-analyzer/commands/domains.ts
git commit -m "feat(har-analyzer): structured JSON for dashboard and domains commands"
```

---

### Task 4: Structured JSON for `search` and `show` commands

**Files:**
- Modify: `src/har-analyzer/commands/search.ts`
- Modify: `src/har-analyzer/commands/show.ts`

**Step 1: Add structured output to `search`**

In `src/har-analyzer/commands/search.ts`:

1. Import `outputResult` and `OutputOptions`:

```typescript
import { truncatePath, outputResult } from "@app/har-analyzer/core/formatter";
import type { HarFile, IndexedEntry, EntryFilter, OutputOptions } from "@app/har-analyzer/types";
```

2. After building `matches` array, branch on format:

```typescript
if (matches.length === 0) {
	if (parentOpts.format === "json") {
		console.log(JSON.stringify({ command: "search", query, scope, matches: [], total: 0 }));
	} else {
		console.log(`No matches found for "${query}" in scope "${scope}".`);
	}
	return;
}

const structured = {
	command: "search",
	query,
	scope,
	matches: matches.map((m) => ({
		index: m.entry.index,
		method: m.entry.method,
		url: m.entry.url,
		path: m.entry.path,
		status: m.entry.status,
		matchScope: m.scope,
		context: m.context,
	})),
	total: matches.length,
};

const textLines = matches.map((match) => {
	const e = match.entry;
	const path = truncatePath(e.path, 40);
	return `[e${e.index}] ${e.method} ${path} ${e.status} -> ${match.context}`;
});
const textOutput = textLines.join("\n") + `\n\n${matches.length} matches found`;

outputResult(parentOpts.format, textOutput, structured);
```

Add `const parentOpts = program.opts<OutputOptions>();` at the top of the action handler.

**Step 2: Add structured output to `show`**

The `show` command is more complex because it has two modes (detail and raw). In `src/har-analyzer/commands/show.ts`:

1. Import `outputResult`:

```typescript
import { outputResult } from "@app/har-analyzer/core/formatter";
```

2. In the action handler, when `parentOpts.format === "json"`, build a structured object from the HAR entry data directly. This should be done before the text-formatting branches:

```typescript
.action(async (entry: string, options: ShowOptions) => {
	const index = parseEntryIndex(entry);
	const sm = new SessionManager();
	const session = await sm.requireSession();

	const indexedEntry = session.entries[index];
	if (!indexedEntry) {
		console.error(`Entry e${index} not found. Session has ${session.entries.length} entries (0-${session.entries.length - 1}).`);
		process.exit(1);
	}

	const harFile = await loadHarFile(session.sourceFile);
	const harEntry = harFile.log.entries[index];
	const parentOpts = program.opts<OutputOptions>();

	if (parentOpts.format === "json") {
		const structured = {
			command: "show",
			entry: {
				index,
				method: harEntry.request.method,
				url: indexedEntry.url,
				status: harEntry.response.status,
				statusText: harEntry.response.statusText,
				request: {
					headers: harEntry.request.headers,
					queryString: harEntry.request.queryString,
					body: harEntry.request.postData?.text ?? null,
					bodySize: harEntry.request.bodySize,
					bodyMimeType: harEntry.request.postData?.mimeType ?? null,
				},
				response: {
					headers: harEntry.response.headers,
					body: harEntry.response.content.encoding === "base64"
						? null
						: (harEntry.response.content.text ?? null),
					bodySize: harEntry.response.content.size,
					contentType: harEntry.response.content.mimeType,
					isBinary: harEntry.response.content.encoding === "base64",
				},
				timing: {
					blocked: harEntry.timings.blocked,
					dns: harEntry.timings.dns,
					connect: harEntry.timings.connect,
					ssl: harEntry.timings.ssl,
					send: harEntry.timings.send,
					wait: harEntry.timings.wait,
					receive: harEntry.timings.receive,
					total: harEntry.time,
				},
			},
		};
		console.log(JSON.stringify(structured));
		return;
	}

	// ... existing text path unchanged ...
```

Note: In JSON mode we always return the full entry data (equivalent to `--raw`). The `--raw`/`--section` flags are text-formatting concerns and are ignored in JSON mode.

**Step 3: Verify compilation**

Run: `cd /Users/Martin/Tresors/Projects/GenesisTools && bunx tsgo --noEmit 2>&1 | rg "har-analyzer"`
Expected: No errors.

**Step 4: Commit**

```bash
git add src/har-analyzer/commands/search.ts src/har-analyzer/commands/show.ts
git commit -m "feat(har-analyzer): structured JSON for search and show commands"
```

---

### Task 5: Structured JSON for `headers` and `security` commands

**Files:**
- Modify: `src/har-analyzer/commands/headers.ts`
- Modify: `src/har-analyzer/commands/security.ts`

**Step 1: Add structured output to `headers`**

In `src/har-analyzer/commands/headers.ts`:

1. Import `outputResult` and `OutputOptions`:

```typescript
import { outputResult } from "@app/har-analyzer/core/formatter";
import type { HarFile, HarHeader, HarSession, OutputOptions } from "@app/har-analyzer/types";
```

2. After building `common` and `uncommon` arrays, branch on format. The structured data should convert `Set<string>` values to arrays:

```typescript
const parentOpts = program.opts<OutputOptions>();

const toHeaderObj = (info: HeaderInfo) => ({
	name: info.name,
	values: [...info.values],
	uniqueEntryCount: new Set(info.entryIndices).size,
	entryIndices: [...new Set(info.entryIndices)],
});

const structured = {
	command: "headers",
	scope: options.scope,
	totalEntries: totalEntries,
	common: common.map(toHeaderObj),
	uncommon: uncommon.map(toHeaderObj),
	totalUniqueHeaders: headerMap.size,
};

// Text output (existing logic)
const lines: string[] = [];
// ... existing text formatting ...

outputResult(parentOpts.format, lines.join("\n"), structured);
```

Restructure so the text lines are built into a string variable, then pass both to `outputResult`.

**Step 2: Add structured output to `security`**

In `src/har-analyzer/commands/security.ts`, the `SecurityFinding` interface is already well-structured. Import and use it:

1. Import `outputResult` and `OutputOptions`:

```typescript
import { truncatePath, outputResult } from "@app/har-analyzer/core/formatter";
import type { HarEntry, HarHeader, OutputOptions } from "@app/har-analyzer/types";
```

2. After building `findings`, branch on format:

```typescript
const parentOpts = program.opts<OutputOptions>();

if (findings.length === 0) {
	if (parentOpts.format === "json") {
		console.log(JSON.stringify({ command: "security", findings: [], total: 0 }));
	} else {
		console.log("No security issues detected.");
	}
	return;
}

const structured = {
	command: "security",
	findings: findings.map((f) => ({
		severity: f.severity,
		category: f.category,
		entryIndex: f.entryIndex,
		method: f.method,
		path: f.path,
		detail: f.detail,
	})),
	total: findings.length,
	bySeverity: {
		HIGH: findings.filter((f) => f.severity === "HIGH").length,
		MEDIUM: findings.filter((f) => f.severity === "MEDIUM").length,
		LOW: findings.filter((f) => f.severity === "LOW").length,
	},
};

// Text output (existing logic)
// ...

outputResult(parentOpts.format, lines.join("\n"), structured);
```

**Step 3: Verify compilation**

Run: `cd /Users/Martin/Tresors/Projects/GenesisTools && bunx tsgo --noEmit 2>&1 | rg "har-analyzer"`
Expected: No errors.

**Step 4: Commit**

```bash
git add src/har-analyzer/commands/headers.ts src/har-analyzer/commands/security.ts
git commit -m "feat(har-analyzer): structured JSON for headers and security commands"
```

---

### Task 6: Structured JSON for `cookies` and `waterfall` commands

**Files:**
- Modify: `src/har-analyzer/commands/cookies.ts`
- Modify: `src/har-analyzer/commands/waterfall.ts`

**Step 1: Add structured output to `cookies`**

In `src/har-analyzer/commands/cookies.ts`:

1. Import `outputResult` and `OutputOptions`:

```typescript
import { truncatePath, outputResult } from "@app/har-analyzer/core/formatter";
import type { HarEntry, OutputOptions } from "@app/har-analyzer/types";
```

2. After `analyzeCookies()` returns, branch on format:

```typescript
const parentOpts = program.opts<OutputOptions>();

if (cookies.length === 0) {
	if (parentOpts.format === "json") {
		console.log(JSON.stringify({ command: "cookies", cookies: [], total: 0 }));
	} else {
		console.log("No cookies found in HAR file.");
	}
	return;
}

const structured = {
	command: "cookies",
	cookies: cookies.map((c) => ({
		name: c.name,
		setByEntry: c.setByEntry,
		setByUrl: c.setByUrl,
		flags: c.flags,
		sentInEntries: c.sentInEntries,
		sentCount: c.sentInEntries.length,
	})),
	total: cookies.length,
};

// Text output (existing logic)
const lines: string[] = [];
// ... existing text building ...

outputResult(parentOpts.format, lines.join("\n"), structured);
```

**Step 2: Add structured output to `waterfall`**

In `src/har-analyzer/commands/waterfall.ts`:

1. Import `outputResult` and `OutputOptions`:

```typescript
import { truncatePath, outputResult } from "@app/har-analyzer/core/formatter";
import type { EntryFilter, IndexedEntry, OutputOptions } from "@app/har-analyzer/types";
```

2. After filtering entries, branch on format. The structured waterfall data includes absolute start offsets:

```typescript
const parentOpts = program.opts<OutputOptions>();

const firstStart = getStartMs(entries[0]);
const lastEnd = entries.reduce((max, e) => {
	const end = getStartMs(e) + e.timeMs;
	return end > max ? end : max;
}, 0);
const totalSpan = lastEnd - firstStart;

if (parentOpts.format === "json") {
	const structured = {
		command: "waterfall",
		entries: entries.map((entry) => ({
			index: entry.index,
			method: entry.method,
			url: entry.url,
			path: entry.path,
			status: entry.status,
			startOffsetMs: getStartMs(entry) - firstStart,
			durationMs: entry.timeMs,
		})),
		totalSpanMs: totalSpan,
		entryCount: entries.length,
	};
	console.log(JSON.stringify(structured));
	return;
}

// ... existing text/bar rendering ...
```

**Step 3: Verify compilation**

Run: `cd /Users/Martin/Tresors/Projects/GenesisTools && bunx tsgo --noEmit 2>&1 | rg "har-analyzer"`
Expected: No errors.

**Step 4: Commit**

```bash
git add src/har-analyzer/commands/cookies.ts src/har-analyzer/commands/waterfall.ts
git commit -m "feat(har-analyzer): structured JSON for cookies and waterfall commands"
```

---

### Task 7: Structured JSON for `redirects`, `diff`, and `size` commands

**Files:**
- Modify: `src/har-analyzer/commands/redirects.ts`
- Modify: `src/har-analyzer/commands/diff.ts`
- Modify: `src/har-analyzer/commands/size.ts`

**Step 1: Add structured output to `redirects`**

In `src/har-analyzer/commands/redirects.ts`:

1. Import `outputResult` and `OutputOptions`:

```typescript
import { truncatePath, outputResult } from "@app/har-analyzer/core/formatter";
import type { IndexedEntry, OutputOptions } from "@app/har-analyzer/types";
```

2. After building chains, branch on format:

```typescript
const parentOpts = program.opts<OutputOptions>();

if (chains.length === 0) {
	if (parentOpts.format === "json") {
		console.log(JSON.stringify({ command: "redirects", chains: [], total: 0 }));
	} else {
		console.log("No redirect chains found.");
	}
	return;
}

const structured = {
	command: "redirects",
	chains: chains.map((chain, i) => ({
		chainIndex: i + 1,
		hops: chain.entries.length - 1,
		finalStatus: chain.finalStatus,
		steps: chain.entries.map((entry) => ({
			index: entry.index,
			method: entry.method,
			url: entry.url,
			path: entry.path,
			status: entry.status,
			isRedirect: entry.isRedirect,
			redirectURL: entry.redirectURL || null,
		})),
	})),
	total: chains.length,
};

const textOutput = chains.map((chain, i) => formatChain(chain, i + 1)).join("\n\n")
	+ `\n\n${chains.length} redirect chain${chains.length !== 1 ? "s" : ""} found`;

outputResult(parentOpts.format, textOutput, structured);
```

**Step 2: Add structured output to `diff`**

In `src/har-analyzer/commands/diff.ts`:

1. Import `outputResult` and `OutputOptions`:

```typescript
import { outputResult } from "@app/har-analyzer/core/formatter";
import type { HarEntry, HarHeader, OutputOptions } from "@app/har-analyzer/types";
```

2. In the action handler, after loading both entries, add a JSON branch before the text formatting:

```typescript
const parentOpts = program.opts<OutputOptions>();

if (parentOpts.format === "json") {
	const diffHeaders = diffHeaderSets(e1, e2);
	const structured = {
		command: "diff",
		entry1: {
			index: idx1,
			method: e1.request.method,
			url: ie1.url,
			status: e1.response.status,
			statusText: e1.response.statusText,
			timeMs: e1.time,
			requestSize: ie1.requestSize,
			responseSize: ie1.responseSize,
			mimeType: ie1.mimeType,
		},
		entry2: {
			index: idx2,
			method: e2.request.method,
			url: ie2.url,
			status: e2.response.status,
			statusText: e2.response.statusText,
			timeMs: e2.time,
			requestSize: ie2.requestSize,
			responseSize: ie2.responseSize,
			mimeType: ie2.mimeType,
		},
		headerDiffs: diffHeaders.map((dh) => ({
			scope: dh.scope,
			name: dh.name,
			entry1Value: dh.val1,
			entry2Value: dh.val2,
		})),
		bodyDiff: {
			entry1: {
				contentType: e1.response.content.mimeType,
				size: e1.response.content.size,
				isBinary: e1.response.content.encoding === "base64",
			},
			entry2: {
				contentType: e2.response.content.mimeType,
				size: e2.response.content.size,
				isBinary: e2.response.content.encoding === "base64",
			},
		},
	};
	console.log(JSON.stringify(structured));
	return;
}

// ... existing text formatting ...
```

**Step 3: Add structured output to `size`**

In `src/har-analyzer/commands/size.ts`:

1. Import `outputResult` and `OutputOptions`:

```typescript
import { outputResult } from "@app/har-analyzer/core/formatter";
import type { IndexedEntry, OutputOptions } from "@app/har-analyzer/types";
```

2. After building buckets, branch on format:

```typescript
const parentOpts = program.opts<OutputOptions>();

const structured = {
	command: "size",
	totalSize: totalSize,
	entryCount: entries.length,
	byContentType: buckets.map((b) => ({
		mimeType: b.mime,
		count: b.count,
		totalSize: b.totalSize,
		percentage: totalSize > 0 ? Math.round((b.totalSize / totalSize) * 1000) / 10 : 0,
	})),
	largestEntries: sorted.slice(0, 10).map((e) => ({
		index: e.index,
		path: e.path,
		responseSize: e.responseSize,
		mimeType: e.mimeType,
	})),
};

// Text output (existing logic)
const lines: string[] = [];
// ... existing text building ...

outputResult(parentOpts.format, lines.join("\n"), structured);
```

**Step 4: Verify compilation**

Run: `cd /Users/Martin/Tresors/Projects/GenesisTools && bunx tsgo --noEmit 2>&1 | rg "har-analyzer"`
Expected: No errors.

**Step 5: Commit**

```bash
git add src/har-analyzer/commands/redirects.ts src/har-analyzer/commands/diff.ts src/har-analyzer/commands/size.ts
git commit -m "feat(har-analyzer): structured JSON for redirects, diff, and size commands"
```

---

### Task 8: MCP server alignment

The MCP server in `src/har-analyzer/mcp/server.ts` currently builds its own text responses inline. Once structured JSON functions exist per command, we can optionally refactor MCP tool handlers to reuse the same data-building logic. This is a future improvement and not required for the initial `--format json` feature.

**No code changes needed for this task.** This is a note for future work.

---

### Task 9: End-to-end smoke test

**Step 1: Load a HAR file and test each command with `--format json`**

You need a HAR file to test. If one is available from a previous session, use it. Otherwise, export one from a browser.

```bash
# Load a HAR file first
tools har-analyzer load /path/to/test.har

# Test each command
tools har-analyzer dashboard --format json 2>/dev/null | bun -e "const d=JSON.parse(await Bun.stdin.text()); console.log('dashboard:', d.command, 'entries:', d.stats.entryCount)"
tools har-analyzer list --format json 2>/dev/null | bun -e "const d=JSON.parse(await Bun.stdin.text()); console.log('list:', d.command, 'filtered:', d.filtered)"
tools har-analyzer errors --format json 2>/dev/null | bun -e "const d=JSON.parse(await Bun.stdin.text()); console.log('errors:', d.command, 'total:', d.total)"
tools har-analyzer domains --format json 2>/dev/null | bun -e "const d=JSON.parse(await Bun.stdin.text()); console.log('domains:', d.command, 'count:', d.domains.length)"
tools har-analyzer search "api" --format json 2>/dev/null | bun -e "const d=JSON.parse(await Bun.stdin.text()); console.log('search:', d.command, 'total:', d.total)"
tools har-analyzer show e0 --format json 2>/dev/null | bun -e "const d=JSON.parse(await Bun.stdin.text()); console.log('show:', d.command, 'method:', d.entry.method)"
tools har-analyzer headers --format json 2>/dev/null | bun -e "const d=JSON.parse(await Bun.stdin.text()); console.log('headers:', d.command, 'total:', d.totalUniqueHeaders)"
tools har-analyzer security --format json 2>/dev/null | bun -e "const d=JSON.parse(await Bun.stdin.text()); console.log('security:', d.command, 'total:', d.total)"
tools har-analyzer cookies --format json 2>/dev/null | bun -e "const d=JSON.parse(await Bun.stdin.text()); console.log('cookies:', d.command, 'total:', d.total)"
tools har-analyzer waterfall --format json 2>/dev/null | bun -e "const d=JSON.parse(await Bun.stdin.text()); console.log('waterfall:', d.command, 'count:', d.entryCount)"
tools har-analyzer redirects --format json 2>/dev/null | bun -e "const d=JSON.parse(await Bun.stdin.text()); console.log('redirects:', d.command, 'total:', d.total)"
tools har-analyzer size --format json 2>/dev/null | bun -e "const d=JSON.parse(await Bun.stdin.text()); console.log('size:', d.command, 'totalSize:', d.totalSize)"
tools har-analyzer diff e0 e1 --format json 2>/dev/null | bun -e "const d=JSON.parse(await Bun.stdin.text()); console.log('diff:', d.command, 'e1:', d.entry1.index, 'e2:', d.entry2.index)"
```

Expected: Each line should parse successfully and print the command name with its key metric.

**Step 2: Verify text mode is unchanged**

```bash
tools har-analyzer list 2>/dev/null | head -5
tools har-analyzer dashboard 2>/dev/null | head -5
```

Expected: Same text output as before (no regressions).

**Step 3: Commit**

No code changes -- this is verification only.
