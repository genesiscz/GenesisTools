import { copyFile, mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { printLn } from "@app/utils/cli";
import type { Command } from "commander";
import { captureRoot, readSetConfig } from "../lib/config";
import { appendShot, readManifest, uniqueDestName, writeManifest } from "../lib/manifest";

export function registerAddCommand(program: Command): void {
    program
        .command("add <file>")
        .description("Copy a screenshot into the capture root and append it to the manifest")
        .option("--route <route>", "app route/screen this shot documents")
        .option("--label <label>", "short label")
        .option("--title <title>", "shot title")
        .option("--note <note>", "free-form note")
        .option("--action <action>", "user action that led to this shot")
        .option("--dir <path>", "capture root directory")
        .action(
            async (
                file: string,
                opts: { route?: string; label?: string; title?: string; note?: string; action?: string; dir?: string }
            ) => {
                const cwd = process.cwd();
                const root = captureRoot(cwd, opts.dir);
                const cfg = await readSetConfig(root);

                if (!cfg) {
                    process.stderr.write("no set config found — run `tools boards init` first\n");
                    process.exitCode = 1;
                    return;
                }

                await mkdir(root, { recursive: true });
                // When the source already lives in the capture root (the standard agent flow:
                // screenshot lands in .screenshots/, then `tools boards add .screenshots/shot.png`),
                // it is already placed — don't copy it onto a `-2` suffix and duplicate the bytes.
                const inPlace = resolve(file) === resolve(join(root, basename(file)));
                const destName = inPlace ? basename(file) : uniqueDestName(root, basename(file));
                if (!inPlace) {
                    await copyFile(file, join(root, destName));
                }

                const manifest = await readManifest(root);
                const next = appendShot(manifest, {
                    file: destName,
                    route: opts.route,
                    label: opts.label,
                    title: opts.title,
                    note: opts.note,
                    action: opts.action,
                    ts: new Date().toISOString(),
                });
                await writeManifest(root, next);

                await printLn(`(shot ${next.shots.length}) ${destName}`);
            }
        );
}
