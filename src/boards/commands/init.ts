import { relative } from "node:path";
import { printLn } from "@app/utils/cli";
import type { Command } from "commander";
import {
    type BoardsSetConfig,
    captureRoot,
    currentBranch,
    defaultProject,
    ensureGitExclude,
    mintKey,
    readSetConfig,
    writeSetConfig,
} from "../lib/config";

export function registerInitCommand(program: Command): void {
    program
        .command("init")
        .description("Create (or print) the sticky set config for this capture directory")
        .option("--project <name>", "project name (defaults to the git repo's basename)")
        .option("--branch <name>", "branch name (defaults to the current git branch)")
        .option("--key <key>", "set key (defaults to a fresh s-YYYYMMDD-HHMM stamp)")
        .option("--kind <kind>", "set kind", "screenshots")
        .option("--dir <path>", "capture root directory")
        .action(async (opts: { project?: string; branch?: string; key?: string; kind: string; dir?: string }) => {
            const cwd = process.cwd();
            const root = captureRoot(cwd, opts.dir);

            const existing = await readSetConfig(root);
            if (existing) {
                await printLn(`set ${existing.project}/${existing.branch}/${existing.key} (already initialized)`);
                return;
            }

            const cfg: BoardsSetConfig = {
                project: opts.project ?? defaultProject(cwd),
                branch: opts.branch ?? currentBranch(cwd),
                key: opts.key ?? mintKey(),
                kind: opts.kind,
            };

            await writeSetConfig(root, cfg);
            await ensureGitExclude(cwd, relative(cwd, root));
            await printLn(`set ${cfg.project}/${cfg.branch}/${cfg.key}`);
        });
}
