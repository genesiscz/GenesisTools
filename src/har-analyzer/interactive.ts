import * as p from "@clack/prompts";
import pc from "picocolors";
import { SessionManager } from "@app/har-analyzer/core/session-manager";
import { loadHarFile } from "@app/har-analyzer/core/parser";
import { RefStoreManager } from "@app/har-analyzer/core/ref-store";
import { formatDashboard, formatEntryLine, truncatePath } from "@app/har-analyzer/core/formatter";
import { formatBytes, formatDuration } from "@app/utils/format";
import { formatTable } from "@app/utils/table";
import { isInterestingMimeType } from "@app/har-analyzer/types";
import type { HarSession, HarFile, OutputOptions, IndexedEntry } from "@app/har-analyzer/types";

export async function runInteractive(parentOpts: OutputOptions): Promise<void> {
	p.intro(pc.bgCyan(pc.black(" har-analyzer ")));

	const sm = new SessionManager();
	let session: HarSession | null = null;
	let harFile: HarFile | null = null;
	let refStore: RefStoreManager | null = null;

	// Try loading last session
	session = await sm.loadSession();

	if (!session) {
		const filePath = await p.text({
			message: "Path to .har file:",
			placeholder: "/path/to/capture.har",
		});

		if (p.isCancel(filePath)) {
			p.cancel("Cancelled");
			process.exit(0);
		}

		const spinner = p.spinner();
		spinner.start("Loading HAR file...");
		session = await sm.createSession(filePath);
		spinner.stop(`Loaded ${session.stats.entryCount} entries`);
	} else {
		p.log.info(`Resuming session: ${session.sourceFile} (${session.stats.entryCount} entries)`);
	}

	harFile = await loadHarFile(session.sourceFile);
	refStore = new RefStoreManager(session.sourceHash);

	// Show dashboard
	console.log("");
	console.log(formatDashboard(session.stats, session.sourceFile));
	console.log("");

	// Main loop
	while (true) {
		const action = await p.select({
			message: "What would you like to do?",
			options: [
				{ value: "list", label: "List entries", hint: "compact table of all requests" },
				{ value: "show", label: "Show entry detail", hint: "inspect a specific request" },
				{ value: "domain", label: "Domain drill-down", hint: "explore by domain" },
				{ value: "search", label: "Search", hint: "grep across bodies/headers" },
				{ value: "errors", label: "Error focus", hint: "4xx/5xx entries" },
				{ value: "waterfall", label: "Waterfall", hint: "timing visualization" },
				{ value: "security", label: "Security audit", hint: "find sensitive data" },
				{ value: "size", label: "Size breakdown", hint: "bandwidth analysis" },
				{ value: "more", label: "More...", hint: "redirects, cookies, diff, export, headers" },
				{ value: "load", label: "Load different HAR", hint: "switch to another file" },
				{ value: "quit", label: "Quit" },
			],
		});

		if (p.isCancel(action) || action === "quit") {
			p.outro(pc.green("Done!"));
			process.exit(0);
		}

		switch (action) {
			case "list": {
				for (const entry of session.entries) {
					console.log(formatEntryLine(entry));
				}
				break;
			}

			case "show": {
				const entryNum = await p.text({
					message: "Entry number (e.g. 0 or e0):",
					placeholder: "0",
				});
				if (p.isCancel(entryNum)) break;

				const idx = Number.parseInt(entryNum.replace(/^e/, ""), 10);
				if (Number.isNaN(idx) || idx < 0 || idx >= session.entries.length) {
					p.log.error(`Invalid entry. Range: 0-${session.entries.length - 1}`);
					break;
				}

				const rawEntry = harFile.log.entries[idx];
				const ie = session.entries[idx];

				console.log(`\n${rawEntry.request.method} ${ie.url}`);
				console.log(`Status: ${rawEntry.response.status} ${rawEntry.response.statusText}`);
				console.log(`Time: ${formatDuration(rawEntry.time)}`);
				console.log(`Size: ${formatBytes(ie.responseSize)}`);

				const showBody = await p.confirm({
					message: "Show response body?",
					initialValue: false,
				});

				if (!p.isCancel(showBody) && showBody) {
					const content = rawEntry.response.content;
					if (content.encoding === "base64") {
						console.log(`[binary: ${content.mimeType}, ${formatBytes(content.size)}]`);
					} else if (content.text && (isInterestingMimeType(content.mimeType) || parentOpts.includeAll)) {
						const formatted = await refStore.formatValue(content.text, `e${idx}.rs.body`, { full: parentOpts.full });
						console.log(formatted);
					} else if (content.text) {
						console.log(`[skipped: ${content.mimeType}, ${formatBytes(content.size)}]`);
					} else {
						console.log("(empty)");
					}
				}
				break;
			}

			case "domain": {
				const domainEntries = Object.entries(session.domains)
					.sort(([, a], [, b]) => b.length - a.length);

				if (domainEntries.length === 0) {
					p.log.warn("No domains found.");
					break;
				}

				const domain = await p.select({
					message: "Select domain:",
					options: domainEntries.map(([d, indices]) => ({
						value: d,
						label: `${d} (${indices.length} reqs)`,
					})),
				});

				if (p.isCancel(domain)) break;

				const domainIndexes = session.domains[domain] ?? [];
				for (const idx of domainIndexes) {
					console.log(formatEntryLine(session.entries[idx]));
				}
				break;
			}

			case "search": {
				const query = await p.text({
					message: "Search query:",
					placeholder: "error",
				});
				if (p.isCancel(query)) break;

				const scope = await p.select({
					message: "Search scope:",
					options: [
						{ value: "all", label: "All (URL, body, headers)" },
						{ value: "url", label: "URL only" },
						{ value: "body", label: "Body only" },
						{ value: "header", label: "Headers only" },
					],
				});
				if (p.isCancel(scope)) break;

				const lower = query.toLowerCase();
				const results: Array<{ entry: IndexedEntry; context: string }> = [];

				for (const entry of session.entries) {
					if (scope === "url" || scope === "all") {
						if (entry.url.toLowerCase().includes(lower)) {
							results.push({ entry, context: `URL: ${truncatePath(entry.url, 60)}` });
							continue;
						}
					}

					const raw = harFile.log.entries[entry.index];

					if (scope === "header" || scope === "all") {
						const allHeaders = [...raw.request.headers, ...raw.response.headers];
						const match = allHeaders.find((h) =>
							h.name.toLowerCase().includes(lower) || h.value.toLowerCase().includes(lower),
						);
						if (match) {
							results.push({ entry, context: `Header: ${match.name}: ${match.value.slice(0, 50)}` });
							continue;
						}
					}

					if (scope === "body" || scope === "all") {
						const bodyText = raw.response.content.text ?? "";
						const reqBody = raw.request.postData?.text ?? "";
						if (bodyText.toLowerCase().includes(lower) || reqBody.toLowerCase().includes(lower)) {
							const matchIn = bodyText.toLowerCase().includes(lower) ? bodyText : reqBody;
							const pos = matchIn.toLowerCase().indexOf(lower);
							const start = Math.max(0, pos - 20);
							const end = Math.min(matchIn.length, pos + lower.length + 20);
							results.push({ entry, context: `Body: ...${matchIn.slice(start, end)}...` });
						}
					}
				}

				if (results.length === 0) {
					p.log.warn(`No matches for "${query}" in ${scope}.`);
				} else {
					p.log.info(`${results.length} match${results.length === 1 ? "" : "es"}:`);
					for (const r of results) {
						console.log(`  [e${r.entry.index}] ${r.entry.method} ${truncatePath(r.entry.path, 30)} ${r.entry.status} → ${r.context}`);
					}
				}
				break;
			}

			case "errors": {
				const errorEntries = session.entries.filter((e) => e.isError);
				if (errorEntries.length === 0) {
					p.log.info("No error responses found.");
					break;
				}

				for (const e of errorEntries) {
					const raw = harFile.log.entries[e.index];
					const body = raw.response.content.text?.slice(0, 80) ?? "";
					console.log(`  e${e.index}  ${e.status}  ${e.method}  ${truncatePath(e.path, 40)}  ${formatDuration(e.timeMs)}`);
					if (body) console.log(`       ${body}`);
				}
				break;
			}

			case "waterfall": {
				const entries = session.entries;
				if (entries.length === 0) break;

				const firstStart = new Date(entries[0].startedDateTime).getTime();
				const lastEnd = entries.reduce((max, e) => {
					const end = new Date(e.startedDateTime).getTime() + e.timeMs;
					return end > max ? end : max;
				}, 0);
				const span = lastEnd - firstStart;
				const barW = 30;

				for (const entry of entries) {
					const offset = new Date(entry.startedDateTime).getTime() - firstStart;
					const startPos = span > 0 ? Math.round((offset / span) * barW) : 0;
					const len = span > 0 ? Math.max(1, Math.round((entry.timeMs / span) * barW)) : 1;
					const bar = " ".repeat(startPos) + "\u2588".repeat(Math.min(len, barW - startPos));
					console.log(`  e${entry.index}  ${entry.method.padEnd(6)}  ${truncatePath(entry.path, 20).padEnd(20)}  |${bar.padEnd(barW)}|  ${formatDuration(entry.timeMs)}`);
				}
				break;
			}

			case "security": {
				// Simplified inline check
				const findings: string[] = [];
				for (const entry of session.entries) {
					const raw = harFile.log.entries[entry.index];
					for (const h of raw.request.headers) {
						if (h.name.toLowerCase() === "authorization" && h.value.startsWith("Bearer ey")) {
							findings.push(`  [e${entry.index}] JWT in Authorization header`);
						}
					}
					for (const q of raw.request.queryString) {
						if (/^(api_?key|token|secret|key)$/i.test(q.name)) {
							findings.push(`  [e${entry.index}] ${q.name} in query string: ${q.value.slice(0, 10)}...`);
						}
					}
				}
				if (findings.length === 0) {
					p.log.info("No security findings.");
				} else {
					p.log.warn(`${findings.length} finding(s):`);
					for (const f of findings) console.log(f);
				}
				break;
			}

			case "size": {
				const headers = ["Type", "Count", "Size"];
				const mimeMap = new Map<string, { count: number; size: number }>();
				for (const e of session.entries) {
					const m = mimeMap.get(e.mimeType) ?? { count: 0, size: 0 };
					m.count++;
					m.size += e.responseSize;
					mimeMap.set(e.mimeType, m);
				}
				const rows = [...mimeMap.entries()]
					.sort(([, a], [, b]) => b.size - a.size)
					.map(([mime, d]) => [mime, String(d.count), formatBytes(d.size)]);
				console.log(formatTable(rows, headers, { alignRight: [1, 2] }));
				break;
			}

			case "more": {
				const moreAction = await p.select({
					message: "Choose analysis:",
					options: [
						{ value: "redirects", label: "Redirect chains" },
						{ value: "cookies", label: "Cookie flow" },
						{ value: "diff", label: "Diff two entries" },
						{ value: "export", label: "Export filtered HAR" },
						{ value: "headers", label: "Header deduplication" },
						{ value: "dashboard", label: "Dashboard (refresh)" },
						{ value: "back", label: "\u2190 Back" },
					],
				});

				if (p.isCancel(moreAction) || moreAction === "back") break;

				if (moreAction === "dashboard") {
					console.log(formatDashboard(session.stats, session.sourceFile));
				} else if (moreAction === "diff") {
					const e1 = await p.text({ message: "First entry (e.g. 0):", placeholder: "0" });
					if (p.isCancel(e1)) break;
					const e2 = await p.text({ message: "Second entry:", placeholder: "1" });
					if (p.isCancel(e2)) break;
					p.log.info(`Use CLI: tools har-analyzer diff e${e1.replace(/^e/, "")} e${e2.replace(/^e/, "")}`);
				} else {
					p.log.info(`Use CLI: tools har-analyzer ${moreAction}`);
				}
				break;
			}

			case "load": {
				const filePath = await p.text({
					message: "Path to .har file:",
					placeholder: "/path/to/capture.har",
				});
				if (p.isCancel(filePath)) break;

				const spinner = p.spinner();
				spinner.start("Loading HAR file...");
				session = await sm.createSession(filePath);
				harFile = await loadHarFile(session.sourceFile);
				refStore = new RefStoreManager(session.sourceHash);
				spinner.stop(`Loaded ${session.stats.entryCount} entries`);
				console.log(formatDashboard(session.stats, session.sourceFile));
				break;
			}
		}

		console.log("");
	}
}
