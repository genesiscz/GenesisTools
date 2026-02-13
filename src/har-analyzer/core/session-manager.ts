import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseHarFile } from "@app/har-analyzer/core/parser";
import type { HarSession } from "@app/har-analyzer/types";
import { Storage } from "@app/utils/storage/storage";

const SESSION_TTL = "1 day";

export class SessionManager {
	private storage: Storage;

	constructor() {
		this.storage = new Storage("har-analyzer");
	}

	async createSession(harFilePath: string): Promise<HarSession> {
		await this.storage.ensureDirs();

		const { session, sourceHash } = await parseHarFile(harFilePath);

		await this.storage.putCacheFile(`sessions/${sourceHash}.json`, session, SESSION_TTL);
		await Bun.write(
			join(this.storage.getCacheDir(), "last-session.txt"),
			sourceHash,
		);

		return session;
	}

	async loadSession(hashOrPath?: string): Promise<HarSession | null> {
		let hash: string | null;

		if (!hashOrPath) {
			hash = await this.getLastSessionHash();
		} else if (!hashOrPath.includes("/") && !hashOrPath.includes(".")) {
			hash = hashOrPath;
		} else {
			const file = Bun.file(resolve(hashOrPath));
			if (!(await file.exists())) {
				return null;
			}
			const fileContent = await file.text();
			hash = Bun.hash(fileContent).toString(16);
		}

		if (!hash) {
			return null;
		}

		const session = await this.storage.getCacheFile<HarSession>(
			`sessions/${hash}.json`,
			SESSION_TTL,
		);

		if (!session) {
			return null;
		}

		session.lastAccessedAt = Date.now();
		await this.storage.putCacheFile(`sessions/${hash}.json`, session, SESSION_TTL);

		return session;
	}

	async getLastSessionHash(): Promise<string | null> {
		const lastSessionPath = join(this.storage.getCacheDir(), "last-session.txt");

		if (!existsSync(lastSessionPath)) {
			return null;
		}

		const hash = await Bun.file(lastSessionPath).text();
		return hash.trim() || null;
	}

	async listSessions(): Promise<
		Array<{ hash: string; sourceFile: string; createdAt: number; entryCount: number }>
	> {
		const files = await this.storage.listCacheFiles(false);
		const sessionFiles = files.filter(
			(f) => f.startsWith("sessions/") && f.endsWith(".json") && !f.endsWith(".refs.json"),
		);

		const sessions: Array<{
			hash: string;
			sourceFile: string;
			createdAt: number;
			entryCount: number;
		}> = [];

		for (const file of sessionFiles) {
			const session = await this.storage.getCacheFile<HarSession>(file, SESSION_TTL);
			if (session) {
				sessions.push({
					hash: session.sourceHash,
					sourceFile: session.sourceFile,
					createdAt: session.createdAt,
					entryCount: session.stats.entryCount,
				});
			}
		}

		return sessions;
	}

	async cleanExpiredSessions(maxAgeMs: number = 86_400_000): Promise<number> {
		const files = await this.storage.listCacheFiles(false);
		const sessionFiles = files.filter(
			(f) => f.startsWith("sessions/") && f.endsWith(".json") && !f.endsWith(".refs.json"),
		);

		const now = Date.now();
		let deletedCount = 0;

		for (const file of sessionFiles) {
			// Read without TTL enforcement - use a very long TTL to read regardless
			const session = await this.storage.getCacheFile<HarSession>(file, "52 weeks");
			if (!session) {
				continue;
			}

			const age = now - session.lastAccessedAt;
			if (age > maxAgeMs) {
				await this.storage.deleteCacheFile(file);

				// Also delete the corresponding refs file
				const refsFile = file.replace(/\.json$/, ".refs.json");
				await this.storage.deleteCacheFile(refsFile);

				deletedCount++;
			}
		}

		return deletedCount;
	}

	async requireSession(hash?: string): Promise<HarSession> {
		const session = await this.loadSession(hash);
		if (!session) {
			console.error("No session loaded. Use `load <file>` first.");
			process.exit(1);
		}
		return session;
	}

	getSourceHash(session: HarSession): string {
		return session.sourceHash;
	}
}
