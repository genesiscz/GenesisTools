import type { EntryFilter, HarSession, IndexedEntry } from "@app/har-analyzer/types.ts";
import { matchGlob } from "@app/utils/string";

export function parseEntryIndex(entry: string): number {
	const cleaned = entry.startsWith("e") ? entry.slice(1) : entry;
	const index = Number.parseInt(cleaned, 10);
	if (Number.isNaN(index)) {
		throw new Error(`Invalid entry reference: "${entry}". Use format like "e14" or "14".`);
	}
	return index;
}

export function matchStatus(status: number, pattern: string): boolean {
	const parts = pattern.split(",").map((p) => p.trim());

	for (const part of parts) {
		// Negation: "!200", "!4xx"
		if (part.startsWith("!")) {
			const inner = part.slice(1);
			// If any negation matches, the status is excluded
			if (matchesSingleStatus(status, inner)) {
				return false;
			}
			continue;
		}

		if (matchesSingleStatus(status, part)) {
			return true;
		}
	}

	// If all parts were negations and none matched, the status passes
	const hasPositive = parts.some((p) => !p.startsWith("!"));
	return !hasPositive;
}

function matchesSingleStatus(status: number, part: string): boolean {
	// Range pattern: "2xx", "4xx", "5xx"
	if (/^\d[xX]{2}$/.test(part)) {
		const rangeDigit = Number.parseInt(part[0], 10);
		return Math.floor(status / 100) === rangeDigit;
	}

	// Exact match: "200", "404"
	return status === Number.parseInt(part, 10);
}

export function filterEntries(entries: IndexedEntry[], filter: EntryFilter): IndexedEntry[] {
	let result = entries;

	if (filter.domain !== undefined) {
		result = result.filter((e) => matchGlob(e.domain, filter.domain!));
	}

	if (filter.url !== undefined) {
		result = result.filter((e) => matchGlob(e.url, filter.url!));
	}

	if (filter.status !== undefined) {
		result = result.filter((e) => matchStatus(e.status, filter.status!));
	}

	if (filter.method !== undefined) {
		const methods = filter.method.split(",").map((m) => m.trim().toUpperCase());
		result = result.filter((e) => methods.includes(e.method.toUpperCase()));
	}

	if (filter.type !== undefined) {
		result = result.filter((e) => matchGlob(e.mimeType, filter.type!));
	}

	if (filter.minTime !== undefined) {
		const minTime = filter.minTime;
		result = result.filter((e) => e.timeMs >= minTime);
	}

	if (filter.minSize !== undefined) {
		const minSize = filter.minSize;
		result = result.filter((e) => e.responseSize >= minSize);
	}

	if (filter.limit !== undefined) {
		result = result.slice(0, filter.limit);
	}

	return result;
}

export function getEntriesForDomain(session: HarSession, domain: string): IndexedEntry[] {
	const indices = session.domains[domain];
	if (!indices) return [];
	return indices.map((i) => session.entries[i]);
}

export function groupByDomain(entries: IndexedEntry[]): Map<string, IndexedEntry[]> {
	const groups = new Map<string, IndexedEntry[]>();

	for (const entry of entries) {
		const existing = groups.get(entry.domain);
		if (existing) {
			existing.push(entry);
		} else {
			groups.set(entry.domain, [entry]);
		}
	}

	return groups;
}
