import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";

export interface ManifestShot {
    file: string;
    route?: string;
    label?: string;
    title?: string;
    note?: string;
    action?: string;
    ts?: string;
}

export interface Manifest {
    journey?: Record<string, unknown>;
    shots: ManifestShot[];
}

export const MANIFEST_FILE = "manifest.json";

export async function readManifest(root: string): Promise<Manifest> {
    const path = join(root, MANIFEST_FILE);
    if (!existsSync(path)) {
        return { shots: [] }; // legit first-run path
    }

    const raw = await readFile(path, "utf8");
    try {
        const parsed = SafeJSON.parse(raw) as Partial<Manifest>;
        return { ...parsed, shots: parsed.shots ?? [] };
    } catch {
        // Refuse to silently reset history — the next add/push would overwrite it with an empty one.
        throw new Error(`manifest.json is corrupt at ${path} — refusing to overwrite; fix or delete it`);
    }
}

export async function writeManifest(root: string, m: Manifest): Promise<void> {
    await writeFile(join(root, MANIFEST_FILE), SafeJSON.stringify(m, null, 2));
}

/** Appends `shot`, replacing any existing entry for the same file. */
export function appendShot(m: Manifest, shot: ManifestShot): Manifest {
    return { ...m, shots: [...m.shots.filter((s) => s.file !== shot.file), shot] };
}
