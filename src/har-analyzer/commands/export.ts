import type { Command } from "commander";
import { resolve } from "node:path";
import { SessionManager } from "@app/har-analyzer/core/session-manager";
import { loadHarFile } from "@app/har-analyzer/core/parser";
import { filterEntries } from "@app/har-analyzer/core/query-engine";
import type { HarEntry, HarFile, EntryFilter, OutputOptions } from "@app/har-analyzer/types";

const SENSITIVE_HEADER_NAMES = new Set([
	"authorization",
	"cookie",
	"set-cookie",
	"x-api-key",
	"x-auth-token",
	"proxy-authorization",
]);

const SENSITIVE_QS_NAMES = new Set([
	"api_key",
	"apikey",
	"key",
	"token",
	"secret",
	"password",
	"access_token",
]);

function sanitizeEntry(entry: HarEntry): HarEntry {
	const clone = JSON.parse(JSON.stringify(entry)) as HarEntry;

	// Sanitize request headers
	for (const h of clone.request.headers) {
		if (SENSITIVE_HEADER_NAMES.has(h.name.toLowerCase())) {
			h.value = "[REDACTED]";
		}
	}

	// Sanitize response headers
	for (const h of clone.response.headers) {
		if (SENSITIVE_HEADER_NAMES.has(h.name.toLowerCase())) {
			h.value = "[REDACTED]";
		}
	}

	// Sanitize query string params
	for (const q of clone.request.queryString) {
		if (SENSITIVE_QS_NAMES.has(q.name.toLowerCase())) {
			q.value = "[REDACTED]";
		}
	}

	// Sanitize cookies
	for (const c of clone.request.cookies) {
		c.value = "[REDACTED]";
	}
	for (const c of clone.response.cookies) {
		c.value = "[REDACTED]";
	}

	return clone;
}

function stripBodies(entry: HarEntry): HarEntry {
	const clone = JSON.parse(JSON.stringify(entry)) as HarEntry;

	if (clone.request.postData) {
		clone.request.postData.text = undefined;
		clone.request.postData.params = undefined;
	}

	clone.response.content.text = undefined;

	return clone;
}

export function registerExportCommand(program: Command): void {
	program
		.command("export")
		.description("Export filtered/sanitized HAR subset")
		.option("--domain <domain>", "Filter by domain")
		.option("--status <status>", "Filter by status (e.g. 4xx, 200)")
		.option("--method <method>", "Filter by HTTP method")
		.option("--sanitize", "Redact sensitive headers, cookies, API keys")
		.option("--strip-bodies", "Remove request/response body content")
		.option("-o, --output <file>", "Output file path (default: stdout)")
		.action(async (options: {
			domain?: string;
			status?: string;
			method?: string;
			sanitize?: boolean;
			stripBodies?: boolean;
			output?: string;
		}) => {
			const parentOpts = program.opts<OutputOptions>();
			const sm = new SessionManager();
			const session = await sm.requireSession(parentOpts.session);

			const harFile = await loadHarFile(session.sourceFile);

			// Apply filters
			const filter: EntryFilter = {
				domain: options.domain,
				status: options.status,
				method: options.method,
			};

			const filtered = filterEntries(session.entries, filter);
			const filteredIndices = new Set(filtered.map((e) => e.index));

			// Build filtered HAR
			let entries = harFile.log.entries.filter((_, i) => filteredIndices.has(i));

			// Apply transformations
			if (options.sanitize) {
				entries = entries.map(sanitizeEntry);
			}
			if (options.stripBodies) {
				entries = entries.map(stripBodies);
			}

			const exportedHar: HarFile = {
				log: {
					version: harFile.log.version,
					creator: harFile.log.creator,
					entries,
				},
			};

			const json = JSON.stringify(exportedHar, null, 2);

			if (options.output) {
				const outPath = resolve(options.output);
				await Bun.write(outPath, json);
				console.log(`Exported ${entries.length} entries to ${outPath}`);
			} else {
				console.log(json);
			}
		});
}
