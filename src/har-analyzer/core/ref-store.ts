import type { RefEntry, RefStore } from "@app/har-analyzer/types";
import { Storage } from "@app/utils/storage/storage";

const REF_THRESHOLD = 200; // chars - below this, no ref is created
const PREVIEW_LENGTH = 80; // chars - preview length for truncated refs

const REFS_TTL = "1 day";

export class RefStoreManager {
	sessionHash: string;
	private storage: Storage;
	private refsPath: string;

	constructor(sessionHash: string) {
		this.sessionHash = sessionHash;
		this.storage = new Storage("har-analyzer");
		this.refsPath = `sessions/${sessionHash}.refs.json`;
	}

	/**
	 * Format a value for output, using the ref system for large values.
	 *
	 * - If `options.full` is true, always return the full content (bypass ref system).
	 * - If value is shorter than REF_THRESHOLD, return as-is (no ref created).
	 * - If the ref was already shown, return a compact reference with preview.
	 * - If the ref is new or not yet shown, store it and return the full value with ref tag.
	 */
	async formatValue(value: string, refId: string, options?: { full?: boolean }): Promise<string> {
		if (options?.full) {
			return value;
		}

		if (value.length < REF_THRESHOLD) {
			return value;
		}

		const store = await this.loadRefs();
		const existing = store.refs[refId];

		if (existing?.shown) {
			// Already shown once - return compact reference
			const preview = this.generatePreview(value);
			return `[ref:${refId}] ${preview} (${value.length} chars)`;
		}

		// First time showing or ref not yet marked as shown - show full content
		store.refs[refId] = {
			preview: this.generatePreview(value),
			size: value.length,
			shown: true,
		};
		await this.saveRefs(store);

		return `[ref:${refId}] ${value}`;
	}

	/**
	 * Get a ref entry by ID.
	 */
	async getRef(refId: string): Promise<RefEntry | null> {
		const store = await this.loadRefs();
		return store.refs[refId] ?? null;
	}

	/**
	 * Expand a ref - returns metadata so the caller knows what to re-read from HAR.
	 * The ref store does NOT store full data, only metadata.
	 */
	async expand(refId: string): Promise<{ found: boolean; refId: string; preview: string; size: number } | null> {
		const entry = await this.getRef(refId);
		if (!entry) {
			return null;
		}

		return {
			found: true,
			refId,
			preview: entry.preview,
			size: entry.size,
		};
	}

	/**
	 * Generate a preview string from a value.
	 * Returns the first PREVIEW_LENGTH chars, trimmed at the last natural break
	 * (space, comma, or bracket) before the limit if possible.
	 */
	generatePreview(value: string): string {
		if (value.length <= PREVIEW_LENGTH) {
			return value;
		}

		let cutoff = PREVIEW_LENGTH;

		// Try to find a natural break point (space, comma, bracket) before the limit
		const breakChars = [" ", ",", "]", "}", ")"];
		let lastBreak = -1;
		for (let i = cutoff - 1; i >= Math.floor(cutoff * 0.5); i--) {
			if (breakChars.includes(value[i])) {
				lastBreak = i + 1; // include the break character
				break;
			}
		}

		if (lastBreak > 0) {
			cutoff = lastBreak;
		}

		return `${value.slice(0, cutoff)}...`;
	}

	/**
	 * Load the refs store from cache.
	 * Returns an empty store if no file is found or the cache has expired.
	 */
	async loadRefs(): Promise<RefStore> {
		const cached = await this.storage.getCacheFile<RefStore>(this.refsPath, REFS_TTL);
		if (cached) {
			return cached;
		}
		return { refs: {} };
	}

	/**
	 * Save the refs store to cache.
	 */
	async saveRefs(store: RefStore): Promise<void> {
		await this.storage.putCacheFile(this.refsPath, store, REFS_TTL);
	}
}
