import { readFileSync } from "node:fs";

export function readTokenFile(path: string): string | null {
    try {
        const raw = readFileSync(path, "utf-8").trim();
        return raw.length > 0 ? raw : null;
    } catch {
        return null;
    }
}
