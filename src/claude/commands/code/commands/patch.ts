import { chmod, copyFile, link, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { atomicWriteFileStreamed } from "@genesiscz/utils/storage/atomic-file";
import type { Command } from "commander";
import { claudeCodePatches } from "../../../lib/patches";
import { applyPatches, inspectPatch } from "../../../lib/patches/apply";
import type { ClaudeCodePatch } from "../../../lib/patches/define-patch";
import { claudeBinaryCandidates } from "../../../lib/teammate-wrapper";
import { replaceBunModule } from "../lib/bun-binary";
import {
    applyManagedPlan,
    backupManagedTarget,
    embeddedClaudeVersion,
    listManagedPatches,
    planManagedPatches,
    readClaudeModules,
    readManagedTarget,
} from "../lib/managed-patches";
import { renderPatchPreview, renderRecoveryPreview } from "../lib/patch-preview";

interface Options {
    binary?: string;
    module?: string;
    patch: string[];
}

async function readTarget(options: Options) {
    const path = await resolvePatchBinary(options.binary);

    const binary = Buffer.from(await Bun.file(path).arrayBuffer());
    const modules = readClaudeModules(binary, path);
    const matches = modules.filter((module) => (options.module ? module.name === options.module : module.isEntrypoint));
    const [module] = matches;

    if (!module || matches.length !== 1 || module.loader !== 1) {
        throw new Error("Expected one JavaScript module. Use an exact embedded name with --module.");
    }

    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(module.contents);
    const version = embeddedClaudeVersion(modules);
    return { binary, module, source, version };
}

function describePatch(source: string, patch: ClaudeCodePatch, version?: string): string {
    const result = inspectPatch(source, patch, version);
    return result.state === "incompatible" ? `${result.state} (${result.reason})` : result.state;
}

function selectPatches(ids: string[]) {
    return [...new Set(ids)].map((id) => {
        const patch = claudeCodePatches.find((candidate) => candidate.id === id);

        if (!patch) {
            throw new Error(`Unknown patch ${id}. Available: ${claudeCodePatches.map((entry) => entry.id).join(", ")}`);
        }

        return patch;
    });
}

function withTarget(command: Command): Command {
    return command
        .option("--binary <file>", "Native Claude executable (default: Claude on PATH)")
        .option("--module <name>", "Exact embedded module name (default: entrypoint)");
}

function withPatches(command: Command): Command {
    return withTarget(command).requiredOption("--patch <ids...>", "Patch IDs to apply");
}

export function registerPatchCommands(code: Command): void {
    withPatches(code.command("check").description("Check selected patches without writing files")).action(
        async (options: Options) => {
            const patches = selectPatches(options.patch);
            const { source, version } = await readTarget(options);

            for (const patch of patches) {
                out.println(`${patch.id}: ${describePatch(source, patch, version)}`);
            }

            applyPatches(source, patches, version);
        }
    );

    withTarget(code.command("status").description("Show patch status in a native Claude executable")).action(
        async (options: Options) => {
            const { module, source, version } = await readTarget(options);
            out.println(`Claude Code ${version ?? "version unknown"} · ${module.name}`);

            for (const patch of claudeCodePatches) {
                out.println(`${patch.id}: ${describePatch(source, patch, version)} — ${patch.description}`);
            }
        }
    );

    const patch = withTarget(code.command("patch").description("Preview, apply, or revert patches"))
        .argument("[output]", "Write a patched JavaScript module")
        .option("--patch <ids...>", "Patch IDs for JavaScript output")
        .option("--backup", "Save the pristine executable without applying patches")
        .option("--diff-preview", "Pick patches and print the diff without writing")
        .option("--diff-apply", "Pick patches, review the diff, and confirm the update")
        .action(async (output: string | undefined, options: Options & PickerOptions) => {
            const managed = [options.backup, options.diffPreview, options.diffApply].filter(Boolean).length;

            if (!output) {
                if (managed > 1 || options.module || options.patch) {
                    throw new Error(
                        "Choose one of --backup, --diff-preview, or --diff-apply. The picker discovers modules automatically."
                    );
                }

                await managePatches(options);
                return;
            }

            if (managed || !options.patch?.length) {
                throw new Error(
                    "JavaScript output requires --patch <ids...>. Use the diff flags without an output path."
                );
            }

            const patches = selectPatches(options.patch);
            const { source, version } = await readTarget(options);
            const patched = applyPatches(source, patches, version);
            await atomicWriteFileStreamed(output, (write) => write(Buffer.from(patched)), { exclusive: true });
            out.println(resolve(output));
        });

    patch
        .command("restore")
        .description("Restore the pristine executable from its backup")
        .option("--binary <file>", "Native Claude executable (default: Claude on PATH)")
        .action(async (_options: Pick<Options, "binary">, command: Command) => {
            const path = await resolvePatchBinary(command.optsWithGlobals<Pick<Options, "binary">>().binary);
            const target = await readManagedTarget(path, { requireBackup: true });

            if (target.currentHash === target.originalHash) {
                out.println(`Already pristine: ${target.path}`);
                return;
            }

            await applyManagedPlan(target, new Map());
            out.println(`Restored ${target.path} from ${target.backup}`);
        });

    withPatches(code.command("repack").description("Write an executable containing the selected patches"))
        .argument("<output>")
        .action(async (output: string, options: Options) => {
            const patches = selectPatches(options.patch);
            const { binary, module, source, version } = await readTarget(options);

            if (process.platform !== "darwin" || binary.readUInt32LE(0) !== 0xfeedfacf) {
                throw new Error("Repack supports thin Mach-O executables on macOS");
            }

            const patched = applyPatches(source, patches, version);
            replaceBunModule(binary, module.name, Buffer.from(patched));

            await publishExecutable(output, async (temporary) => {
                await Bun.write(temporary, binary);
                const sign = Bun.spawnSync(["/usr/bin/codesign", "--force", "--sign", "-", temporary]);

                if (sign.exitCode !== 0) {
                    throw new Error(`codesign failed: ${sign.stderr.toString().trim()}`);
                }
            });
        });

    code.command("install")
        .description("Install a repacked executable at an unused path")
        .argument("<artifact>")
        .argument("<destination>")
        .action(async (artifact: string, destination: string) => {
            await publishExecutable(destination, async (temporary) => {
                await copyFile(artifact, temporary);
                await readTarget({ binary: temporary, patch: [] });
                const verify = Bun.spawnSync(["/usr/bin/codesign", "--verify", temporary]);

                if (verify.exitCode !== 0) {
                    throw new Error(`Invalid executable signature: ${verify.stderr.toString().trim()}`);
                }
            });
        });
}

interface PickerOptions {
    binary?: string;
    backup?: boolean;
    diffPreview?: boolean;
    diffApply?: boolean;
}

async function managePatches(options: PickerOptions): Promise<void> {
    const path = await resolvePatchBinary(options.binary);

    if (!options.backup && (!process.stdin.isTTY || !process.stdout.isTTY)) {
        throw new Error("The patch picker requires an interactive terminal.");
    }

    const target = await readManagedTarget(path);
    const { edits, problems } = listManagedPatches(target);

    if (options.backup) {
        const result = await backupManagedTarget(target);
        out.println(
            result === "created"
                ? `Saved pristine backup: ${target.backup}`
                : `Pristine backup already exists: ${target.backup}`
        );
        return;
    }

    out.println(`Claude Code ${target.version ?? "(version unknown)"} · ${target.path}`);

    for (const problem of problems) {
        out.println(problem);
    }

    const applied = edits.filter((edit) => edit.applied).map(({ patch }) => patch.id);
    out.println(`Installed patches recognized by this picker: ${applied.join(", ") || "none"}`);
    const current = planManagedPatches(edits, new Set(applied), target.version).modules;
    const mismatches: string[] = [];

    for (const module of target.currentModules) {
        const expected =
            current.get(module.name) ?? target.originalModules.find(({ name }) => name === module.name)?.contents;
        if (
            !expected ||
            !Buffer.from(module.contents.buffer, module.contents.byteOffset, module.contents.byteLength).equals(
                expected
            )
        ) {
            mismatches.push(module.name);
        }
    }

    const recovering = mismatches.length > 0;

    if (recovering) {
        out.println(`Installed edits differ from the current patch definitions in ${mismatches.join(", ")}.`);
        const recover = await p.confirm({
            message: "Rebuild from the pristine backup and choose which patches to reapply?",
            initialValue: false,
            cancel: "back",
        });

        if (recover !== true) {
            return;
        }
    } else if (!edits.length) {
        throw new Error("No compatible patches found.");
    }

    let selected: string[] = [];

    if (edits.length) {
        const answer = await p.multiselect({
            cancel: "back",
            message: "Select the patches this executable should have",
            options: edits.map(({ patch, applied }) => ({
                value: patch.id,
                label: patch.id,
                hint: `${applied ? "Installed" : "Not installed"} · ${patch.description}`,
            })),
            initialValues: applied,
            required: false,
        });

        if (p.isCancel(answer)) {
            return;
        }

        selected = answer;
    }

    let plan: ReturnType<typeof planManagedPatches>;

    try {
        plan = planManagedPatches(edits, new Set(selected), target.version);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
            `No changes written. Could not prepare selected patches (${selected.join(", ") || "none"}). ${detail}`,
            {
                cause: error,
            }
        );
    }

    const { modules, preview } = plan;
    const diffs = recovering
        ? target.currentModules.flatMap((module) => {
              const after =
                  modules.get(module.name) ?? target.originalModules.find(({ name }) => name === module.name)?.contents;

              if (!after) {
                  throw new Error(`Cannot preview recovery for ${module.name}: module missing from backup.`);
              }

              const before = Buffer.from(
                  module.contents.buffer,
                  module.contents.byteOffset,
                  module.contents.byteLength
              );
              return before.equals(after) ? [] : [renderRecoveryPreview(module.name, before, after)];
          })
        : preview.map(renderPatchPreview);

    if (recovering) {
        const rebuilt = target.originalModules.flatMap((module) => {
            const after = modules.get(module.name);

            if (!after) {
                return [];
            }

            const before = Buffer.from(module.contents.buffer, module.contents.byteOffset, module.contents.byteLength);
            return before.equals(after) ? [] : [renderRecoveryPreview(module.name, before, after)];
        });
        out.println(
            `Rebuild from ${target.backup}\nPatches to reapply: ${selected.join(", ") || "none"}\n\nPristine backup → rebuilt executable\n${rebuilt.join("\n\n") || "No source changes from the backup."}\n\nInstalled executable → rebuilt executable`
        );
    }

    if (!diffs.length) {
        out.println("The selected patches are already in effect.");
        return;
    }

    out.println(diffs.join("\n\n"));

    if (options.diffPreview) {
        out.println("Preview only. No patches were written.");
        return;
    }

    const approved = await p.confirm({
        message: `Apply this diff to ${target.path}?`,
        initialValue: false,
        cancel: "back",
    });

    if (approved !== true) {
        return;
    }

    await applyManagedPlan(target, modules);
    out.println(
        `Updated ${target.path}\nInstalled patches: ${selected.join(", ") || "none"}\nPristine backup: ${target.backup}`
    );
}

async function resolvePatchBinary(explicit?: string): Promise<string> {
    const onPath = explicit ?? Bun.which("claude", { PATH: process.env.PATH ?? "" });

    if (!onPath) {
        throw new Error("Claude Code was not found on PATH. Pass --binary <path-to-native-claude>.");
    }

    const resolved = await realpath(onPath);
    const header = Buffer.from(await Bun.file(resolved).slice(0, 2).arrayBuffer());

    if (header.toString("ascii") !== "#!") {
        return resolved;
    }

    if (explicit) {
        throw new Error(`${resolved} is a launcher script. Pass --binary <path-to-native-claude>.`);
    }

    const native = new Set<string>();

    for (const candidate of claudeBinaryCandidates()) {
        if (!(await Bun.file(candidate).exists())) {
            continue;
        }

        const file = await realpath(candidate);
        const bytes = Buffer.from(await Bun.file(file).slice(0, 4).arrayBuffer());

        if (bytes.length === 4 && bytes.readUInt32LE(0) === 0xfeedfacf) {
            native.add(file);
        }
    }

    const [candidate] = native;

    if (candidate && native.size === 1) {
        out.println(`Claude on PATH is a launcher at ${resolved}. Using native executable ${candidate}.`);
        return candidate;
    }

    const found = native.size ? ` Candidates: ${[...native].join(", ")}.` : "";
    throw new Error(`Claude on PATH is a launcher at ${resolved}. Pass --binary <path-to-native-claude>.${found}`);
}

async function publishExecutable(output: string, populate: (temporary: string) => Promise<void>): Promise<void> {
    const destination = resolve(output);
    const directory = await mkdtemp(join(dirname(destination), ".claude-code-"));

    try {
        const temporary = join(directory, "claude");
        await populate(temporary);
        await chmod(temporary, 0o755);
        await link(temporary, destination);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }

    out.println(destination);
}
