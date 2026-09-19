import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";

const live = new Set<TemporaryArtifacts>();
let exitRegistered = false;

/** Owns only files allocated under its private temporary directory. */
export class TemporaryArtifacts {
    private directory?: string;
    private readonly files = new Set<string>();
    constructor(private readonly options: { prefix: string; maxFiles: number; parentDirectory?: string }) {
        if (
            !/^[a-z][a-z0-9-]{0,60}$/.test(options.prefix) ||
            !Number.isInteger(options.maxFiles) ||
            options.maxFiles < 1 ||
            options.maxFiles > 1000
        ) {
            throw new Error("Temporary artifacts require a simple prefix and a 1–1000 file budget.");
        }
    }
    allocate(extension: string): string {
        if (!/^[a-z0-9]{1,10}$/.test(extension)) {
            throw new Error("Invalid temporary artifact extension.");
        }
        if (!this.directory) {
            this.directory = mkdtempSync(join(this.options.parentDirectory ?? tmpdir(), `${this.options.prefix}-`));
            live.add(this);
            if (!exitRegistered) {
                exitRegistered = true;
                process.once("exit", () => {
                    for (const owner of live) {
                        owner.dispose();
                    }
                });
            }
        }
        while (this.files.size >= this.options.maxFiles) {
            const oldest = this.files.values().next().value;
            if (oldest) {
                this.release(oldest);
            }
        }
        const file = join(this.directory, `${randomUUID()}.${extension}`);
        this.files.add(file);
        return file;
    }
    allocateDirectory(): string {
        const directory = this.allocate("dir");
        mkdirSync(directory, { mode: 0o700 });
        return directory;
    }
    owns(file: string): boolean {
        return this.files.has(file);
    }
    release(file: string): boolean {
        if (!this.files.delete(file)) {
            return false;
        }
        try {
            rmSync(file, { force: true, recursive: true });
        } catch (error) {
            logger.debug({ error, file }, "Could not remove owned temporary artifact");
        }
        return true;
    }
    dispose(): void {
        if (this.directory) {
            try {
                rmSync(this.directory, { recursive: true, force: true });
            } catch (error) {
                logger.debug({ error, directory: this.directory }, "Could not remove owned temporary directory");
            }
        }
        this.files.clear();
        this.directory = undefined;
        live.delete(this);
    }
}
