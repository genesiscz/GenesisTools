import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

function resolveUnderVault(vaultRoot: string, ...segments: string[]): string {
    const root = resolve(vaultRoot);
    const target = resolve(root, ...segments);

    if (target !== root && !target.startsWith(`${root}${sep}`)) {
        throw new Error(`path escapes vault: ${segments.join("/")}`);
    }

    return target;
}

function assertSafeBaseName(baseName: string): void {
    if (baseName.includes("/") || baseName.includes("\\") || baseName.includes("..")) {
        throw new Error("baseName must not contain path separators");
    }
}

function resolveFileInDir(dir: string, fileName: string): string {
    const target = resolve(dir, fileName);

    if (target !== dir && !target.startsWith(`${dir}${sep}`)) {
        throw new Error(`file escapes directory: ${fileName}`);
    }

    return target;
}

async function readExistingMarkdown(path: string): Promise<string> {
    try {
        return await readFile(path, "utf8");
    } catch (err: unknown) {
        if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
            return "";
        }

        throw err;
    }
}

export async function saveToObsidianUnique(opts: {
    vaultRoot: string;
    relativeDir: string;
    baseName: string;
    content: string;
    mode: "create" | "append";
    createDir?: boolean;
}): Promise<{ path: string }> {
    assertSafeBaseName(opts.baseName);
    const dir = resolveUnderVault(opts.vaultRoot, opts.relativeDir);

    if (opts.createDir) {
        await mkdir(dir, { recursive: true });
    } else {
        const dirStat = await stat(dir).catch(() => null);

        if (!dirStat?.isDirectory()) {
            throw new Error(`directory does not exist: ${opts.relativeDir}`);
        }
    }

    if (opts.mode === "append") {
        const path = resolveFileInDir(dir, `${opts.baseName}.md`);
        const existing = await readExistingMarkdown(path);
        const sep = existing && !existing.endsWith("\n") ? "\n\n" : existing ? "\n" : "";

        await writeFile(path, existing + sep + opts.content);

        return { path };
    }

    for (let n = 1; n <= 999; n++) {
        const candidate = n === 1 ? `${opts.baseName}.md` : `${opts.baseName}-${n}.md`;
        const path = resolveFileInDir(dir, candidate);

        try {
            await writeFile(path, opts.content, { flag: "wx" });

            return { path };
        } catch (err: unknown) {
            if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") {
                continue;
            }

            throw err;
        }
    }

    throw new Error("too many duplicates");
}
