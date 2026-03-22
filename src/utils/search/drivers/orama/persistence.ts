import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AnyOrama } from "@orama/orama";

export async function persistToFile(db: AnyOrama, path: string): Promise<void> {
    const mod = await import("@orama/plugin-data-persistence");
    const data = await mod.persist(db as Parameters<typeof mod.persist>[0], "json");

    const dir = dirname(path);

    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    writeFileSync(path, data as string);
}

export async function restoreFromFile<T extends AnyOrama>(path: string): Promise<T | null> {
    if (!existsSync(path)) {
        return null;
    }

    const { restore } = await import("@orama/plugin-data-persistence");
    const data = readFileSync(path, "utf-8");
    return restore("json", data) as Promise<T>;
}
