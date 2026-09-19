import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

const { log } = logger.scoped("jev-probably");

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export type StoredProgram = {
    name: string;
    source: string;
    path: string;
    updatedAt: string;
};

export type ProgramStore = {
    rootDir: string;
    list(): Array<Omit<StoredProgram, "source">>;
    get(name: string): StoredProgram;
    save(name: string, source: string): StoredProgram;
    remove(name: string): void;
};

function assertName(name: string): string {
    const trimmed = name.trim();

    if (!NAME_RE.test(trimmed)) {
        throw new Error("Program name must be 1–64 chars: letters, digits, _ or -, starting with a letter or digit.");
    }

    return trimmed;
}

function programsDir(storage: Storage): string {
    return join(storage.getBaseDir(), "probably", "programs");
}

export function createProgramStore(options?: { directory?: string }): ProgramStore {
    const storage = new Storage("jev");
    const rootDir = options?.directory ?? programsDir(storage);

    const ensure = () => {
        if (!existsSync(rootDir)) {
            mkdirSync(rootDir, { recursive: true });
            log.debug({ rootDir }, "created Probably program store");
        }
    };

    const pathFor = (name: string) => join(rootDir, `${name}.prob`);

    return {
        rootDir,
        list() {
            ensure();
            return readdirSync(rootDir)
                .filter((file) => file.endsWith(".prob"))
                .map((file) => {
                    const name = file.slice(0, -".prob".length);
                    const path = join(rootDir, file);
                    const updatedAt = new Date(statSync(path).mtimeMs).toISOString();
                    return { name, path, updatedAt };
                })
                .sort((a, b) => a.name.localeCompare(b.name));
        },
        get(name: string) {
            ensure();
            const id = assertName(name);
            const path = pathFor(id);

            if (!existsSync(path)) {
                throw new Error(`No stored Probably program named ${SafeJSON.stringify(id)}.`);
            }

            const source = readFileSync(path, "utf8");
            return {
                name: id,
                path,
                source,
                updatedAt: new Date(statSync(path).mtimeMs).toISOString(),
            };
        },
        save(name: string, source: string) {
            ensure();
            const id = assertName(name);

            if (source.length > 12000) {
                throw new Error("Program exceeds 12,000 characters.");
            }

            if (!source.trim()) {
                throw new Error("Program source is empty.");
            }

            const path = pathFor(id);
            const normalized = source.endsWith("\n") ? source : `${source}\n`;
            atomicWriteFileSync(path, normalized);
            log.info({ name: id, path, bytes: normalized.length }, "saved Probably program");
            return {
                name: id,
                path,
                source: normalized,
                updatedAt: new Date().toISOString(),
            };
        },
        remove(name: string) {
            ensure();
            const id = assertName(name);
            const path = pathFor(id);

            if (!existsSync(path)) {
                throw new Error(`No stored Probably program named ${SafeJSON.stringify(id)}.`);
            }

            unlinkSync(path);
            log.info({ name: id, path }, "removed Probably program");
        },
    };
}

export const defaultProgramStore = createProgramStore();
