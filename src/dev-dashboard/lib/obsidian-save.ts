import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function saveToObsidianUnique(opts: {
    vaultRoot: string;
    relativeDir: string;
    baseName: string;
    content: string;
    mode: "create" | "append";
    createDir?: boolean;
}): Promise<{ path: string }> {
    const dir = join(opts.vaultRoot, opts.relativeDir);

    if (opts.createDir) {
        await mkdir(dir, { recursive: true });
    } else {
        const dirStat = await stat(dir).catch(() => null);

        if (!dirStat?.isDirectory()) {
            throw new Error(`directory does not exist: ${opts.relativeDir}`);
        }
    }

    if (opts.mode === "append") {
        const path = join(dir, `${opts.baseName}.md`);
        const existing = await readFile(path, "utf8").catch(() => "");
        const sep = existing && !existing.endsWith("\n") ? "\n\n" : existing ? "\n" : "";

        await writeFile(path, existing + sep + opts.content);

        return { path };
    }

    let n = 1;

    while (true) {
        const candidate = n === 1 ? `${opts.baseName}.md` : `${opts.baseName}-${n}.md`;
        const path = join(dir, candidate);

        try {
            await stat(path);
            n++;

            if (n > 999) {
                throw new Error("too many duplicates");
            }
        } catch {
            await writeFile(path, opts.content);

            return { path };
        }
    }
}
