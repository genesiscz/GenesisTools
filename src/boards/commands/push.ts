import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { paths } from "@app/dev-dashboard/contract/endpoints";
import { tarGz } from "@app/dev-dashboard/lib/boards/tar";
import { logger } from "@app/logger";
import { concurrentMap } from "@app/utils/async";
import { printLn } from "@app/utils/cli";
import type { Command } from "commander";
import { putRaw, resolveBaseUrl } from "../lib/client";
import { CONFIG_FILE, captureRoot, gitProvenance, readSetConfig, slugifyBranch, writeSetConfig } from "../lib/config";
import { resolveActor } from "../lib/operator";

interface PushResult {
    url: string;
    project: string;
    branch: string;
    version: number;
    key: string;
    kind: string;
    files: number;
    bytes: number;
    created: boolean;
}

/** Names that must never land in a pushed set: the sticky config, macOS Finder droppings
 *  (`.DS_Store`, AppleDouble `._*`), and the capture lock file. */
function isJunkName(name: string): boolean {
    return name === CONFIG_FILE || name === ".DS_Store" || name.startsWith("._") || name === ".active";
}

/** Every file under `root` (recursive), forward-slash relative paths, junk excluded.
 *  `manifest.json` (if present) is deliberately included — the server parses it for per-shot
 *  metadata but skips creating a row for it. */
export async function collectFiles(root: string): Promise<string[]> {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
        if (!entry.isFile() || isJunkName(entry.name)) {
            continue;
        }

        const rel = relative(root, join(entry.parentPath, entry.name)).split(sep).join("/");
        files.push(rel);
    }

    return files;
}

export function registerPushCommand(program: Command): void {
    program
        .command("push")
        .description("Tar+push the capture root as a new set version")
        .option("--dir <path>", "capture root directory")
        .option("--title <title>", "set title (persisted back into the sticky config)")
        .option("--source <source>", "source ref (persisted back into the sticky config)")
        .option("--base <url>", "dev-dashboard base URL")
        .option("--actor <name>", "operator identity to attribute this write to")
        .action(async (opts: { dir?: string; title?: string; source?: string; base?: string; actor?: string }) => {
            const cwd = process.cwd();
            const root = captureRoot(cwd, opts.dir);
            const cfg = await readSetConfig(root);
            if (!cfg) {
                process.stderr.write("no set config found — run `tools boards init` first\n");
                process.exitCode = 1;
                return;
            }

            if (!existsSync(root)) {
                process.stderr.write(`capture root does not exist: ${root}\n`);
                process.exitCode = 1;
                return;
            }

            const title = opts.title ?? cfg.title;
            const source = opts.source ?? cfg.source;

            const relFiles = await collectFiles(root);
            const fileByRel = await concurrentMap({
                items: relFiles,
                fn: async (rel) => ({
                    path: rel,
                    data: new Uint8Array(await readFile(join(root, ...rel.split("/")))),
                }),
                concurrency: 12,
                onError: (rel, error) => {
                    throw error instanceof Error ? error : new Error(`failed to read ${rel}: ${String(error)}`);
                },
            });
            const entries = relFiles.map((rel) => fileByRel.get(rel)!);
            const packed = await tarGz(entries);

            const base = resolveBaseUrl(opts.base);
            const branchSlug = slugifyBranch(cfg.branch);
            const provenance = gitProvenance(root); // best-effort; omitted outside a git repo
            const targetPath = paths.boardsSetContent(cfg.project, branchSlug, cfg.key, {
                kind: cfg.kind,
                title,
                branch: cfg.branch,
                source,
                commit: provenance.commit,
                repo: provenance.repo,
            });
            logger.debug(
                {
                    url: `${base}${targetPath}`,
                    project: cfg.project,
                    branch: branchSlug,
                    key: cfg.key,
                    bytes: packed.length,
                    files: entries.length,
                },
                "boards push: uploading set content"
            );

            const actor = await resolveActor(opts.actor);
            let result: PushResult;
            try {
                result = await putRaw<PushResult>(
                    base,
                    targetPath,
                    packed,
                    "application/gzip",
                    AbortSignal.timeout(120_000),
                    actor
                );
            } catch (err) {
                logger.error({ err, url: `${base}${targetPath}` }, "boards push: upload failed");
                throw err;
            }
            logger.debug(
                { files: result.files, version: result.version, bytes: result.bytes },
                "boards push: upload complete"
            );

            if (opts.title || opts.source) {
                await writeSetConfig(root, { ...cfg, title, source });
            }

            await printLn(
                `pushed ${result.project}/${result.branch}/${result.key} v${result.version} ` +
                    `(${result.files} files, ${result.bytes} B) → ${base}${result.url}`
            );
        });
}
