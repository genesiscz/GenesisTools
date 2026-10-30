import { join } from "node:path";
import { isInteractive } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { env } from "@genesiscz/utils/env";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { createBoxTable, formatDotStatus } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import {
    detectProviders,
    type FoundProvider,
    generateCompletions,
    readVersion,
    versionChanged,
} from "../lib/completions/generate";
import { COMPLETION_PROVIDERS, type CompletionProvider, getCompletionProvider } from "../lib/completions/providers";
import {
    type CompletionPlan,
    completionFilePath,
    type FoundHandBlock,
    findHandBlocks,
    findOwnBlock,
    isReplaceable,
    planCompletions,
    type ReplacedHandBlock,
    rcDiff,
    replacedRecord,
    restoreHandBlocks,
    stripOwnBlock,
} from "../lib/completions/rc-block";
import {
    type CompletionsState,
    completionsDir,
    completionsStatePath,
    readStateForUpdate,
    readStateReadOnly,
    writeState,
} from "../lib/completions/state";
import { readRc, replaceRc } from "../lib/shell-rc";

interface InstallOptions {
    yes?: boolean;
    list?: boolean;
    dryRun?: boolean;
    replaceHand?: boolean;
    rc?: string;
}

function defaultRcPath(): string {
    return join(env.getTrimmed("ZDOTDIR") ?? env.paths.getHome(), ".zshrc");
}

function home(): string {
    return env.paths.getHome();
}

function lineSpan(block: FoundHandBlock): string {
    const first = block.range.start + 1;
    const last = block.range.end + 1;
    return first === last ? `line ${first}` : `lines ${first}-${last}`;
}

function colorDiff(diff: string): string {
    return diff
        .split("\n")
        .map((line) => {
            if (line.startsWith("+++") || line.startsWith("---")) {
                return pc.bold(line);
            }

            if (line.startsWith("+")) {
                return pc.green(line);
            }

            if (line.startsWith("-")) {
                return pc.red(line);
            }

            if (line.startsWith("@@")) {
                return pc.cyan(line);
            }

            return line;
        })
        .join("\n");
}

/** The first and last lines of a hand block, for the question about it. */
function blockPreview(block: FoundHandBlock): string {
    const lines = block.lines.length <= 8 ? block.lines : [...block.lines.slice(0, 4), "…", ...block.lines.slice(-3)];
    return lines.join("\n");
}

function printPlanSummary(plan: CompletionPlan, rcPath: string): void {
    for (const provider of plan.wired) {
        out.log.step(
            `${pc.bold(provider.cli)}: ${provider.wiring} wiring from ${completionFilePath(completionsDir(), provider.cli)}`
        );
    }

    for (const block of plan.replaced) {
        out.log.step(
            `${pc.bold(block.provider.cli)}: replaces ${block.wiring.describe} (${rcPath} ${lineSpan(block)})`
        );
    }

    for (const entry of plan.skipped) {
        out.log.info(
            `${pc.bold(entry.provider.cli)}: already wired by hand, kept (${entry.block.wiring.describe}, ${lineSpan(entry.block)})`
        );
    }

    for (const block of plan.kept.filter((entry) => entry.wiring.coexists)) {
        out.log.info(
            `${pc.bold(block.provider.cli)}: ${block.wiring.describe} stays (${lineSpan(block)}); the block wires it too`
        );
    }
}

async function printList(input: {
    found: FoundProvider[];
    state: CompletionsState;
    rcText: string;
    rcPath: string;
}): Promise<void> {
    const versions = await Promise.all(input.found.map((entry) => readVersion(entry.provider)));
    const hand = findHandBlocks(
        input.rcText,
        input.found.map((entry) => entry.provider)
    );
    const ownBlock = findOwnBlock(input.rcText.split("\n"));
    const table = createBoxTable(["CLI", "STATUS", "WIRING", "VERSION", "PATH"]);
    const stale: string[] = [];

    input.found.forEach((entry, index) => {
        const installed = input.state.clis[entry.provider.cli];
        const handBlock = hand.find(
            (block) => block.provider.cli === entry.provider.cli && !block.adopted && !block.wiring.coexists
        );
        let status = formatDotStatus("dim", "not installed");

        if (installed && ownBlock) {
            status = formatDotStatus("ok", "installed");
        } else if (handBlock) {
            status = formatDotStatus("warn", `wired by hand (${lineSpan(handBlock)})`);
        }

        if (versionChanged(installed, versions[index])) {
            status = formatDotStatus("warn", "version changed: refresh");
            stale.push(entry.provider.cli);
        }

        table.push([pc.bold(entry.provider.cli), status, entry.provider.wiring, versions[index] ?? "", entry.path]);
    });

    out.println(table.toString());

    const missing = COMPLETION_PROVIDERS.filter(
        (provider) => !input.found.some((entry) => entry.provider.cli === provider.cli)
    );

    if (missing.length > 0) {
        out.println(pc.dim(`Not on PATH: ${missing.map((provider) => provider.cli).join(", ")}`));
    }

    out.println(pc.dim(`Files: ${completionsDir()}  ·  rc: ${input.rcPath}  ·  state: ${completionsStatePath()}`));

    if (stale.length > 0) {
        out.println(
            `${stale.join(", ")} changed since the files were generated: ${toolCommand("zsh completions refresh")}`
        );
    }
}

/** Which found CLIs to wire: all of them, or the user's pick in a terminal. */
async function pickProviders(found: FoundProvider[], interactive: boolean): Promise<CompletionProvider[]> {
    if (!interactive) {
        return found.map((entry) => entry.provider);
    }

    const picked = await p.multiselect({
        message: "Install static zsh completions for",
        options: found.map((entry) => ({
            value: entry.provider.cli,
            label: entry.provider.cli,
            hint: `${entry.provider.generate.join(" ")} · ${entry.provider.wiring}`,
        })),
        initialValues: found.map((entry) => entry.provider.cli),
        required: false,
    });

    return found.filter((entry) => picked.includes(entry.provider.cli)).map((entry) => entry.provider);
}

/** The hand blocks to replace: asked one by one in a terminal, all with `--replace-hand`, none otherwise. */
async function pickReplacements(input: {
    blocks: FoundHandBlock[];
    interactive: boolean;
    replaceHand: boolean;
    rcPath: string;
}): Promise<FoundHandBlock[]> {
    const replaceable = input.blocks.filter(isReplaceable);

    if (!input.interactive) {
        return input.replaceHand ? replaceable : [];
    }

    const chosen: FoundHandBlock[] = [];

    for (const block of replaceable) {
        p.note(blockPreview(block), `${input.rcPath} ${lineSpan(block)}`);
        const replace = await p.confirm({
            message: `Replace ${block.wiring.describe} with "${(block.wiring.replacement ?? []).join(" ")}" and wire ${block.provider.cli} from the static file?`,
            initialValue: true,
        });

        if (replace) {
            chosen.push(block);
        }
    }

    return chosen;
}

async function installAction(opts: InstallOptions): Promise<void> {
    const rcPath = opts.rc ?? defaultRcPath();
    const rcBefore = readRc(rcPath);
    const rcText = rcBefore ?? "";
    const found = detectProviders(COMPLETION_PROVIDERS);
    logger.debug({ rcPath, found: found.map((entry) => entry.provider.cli) }, "zsh completions: detected");

    if (opts.list) {
        const { state, problem } = readStateReadOnly();

        if (problem) {
            out.log.warn(problem);
        }

        await printList({ found, state, rcText, rcPath });
        return;
    }

    if (found.length === 0) {
        out.log.info(`None of ${COMPLETION_PROVIDERS.map((provider) => provider.cli).join(", ")} is on PATH.`);
        return;
    }

    if (!opts.dryRun && !opts.yes && !isInteractive()) {
        out.log.error(`This changes ${rcPath}. In a non-interactive shell pass --yes, or look first with --dry-run.`);
        out.log.info(toolCommand("zsh completions", "--dry-run"));
        out.log.info(toolCommand("zsh completions", "--yes"));
        process.exitCode = 1;
        return;
    }

    const interactive = isInteractive() && !opts.yes && !opts.dryRun;
    const selected = await pickProviders(found, interactive);
    const prior = readStateReadOnly().state;
    const isSelected = (cli: string): boolean => selected.some((provider) => provider.cli === cli);
    const deselected = Object.entries(prior.replacedHand ?? {}).filter(([cli]) => !isSelected(cli));
    const restore = restoreHandBlocks(
        rcText,
        deselected.flatMap(([, records]) => records)
    );
    const baseText = restore.text;

    for (const [cli] of deselected) {
        out.log.step(`${pc.bold(cli)}: not selected, its hand-made wiring is put back`);
    }

    for (const record of restore.missing) {
        out.log.warn(
            `Could not put back (its "${record.replacement.join(" ")}" line is gone): ${record.original[0] ?? ""} …`
        );
    }

    const replace = await pickReplacements({
        blocks: findHandBlocks(baseText, selected),
        interactive,
        replaceHand: opts.replaceHand ?? false,
        rcPath,
    });
    let plan = planCompletions({ rcText: baseText, selected, replace, completionsDir: completionsDir(), home: home() });
    printPlanSummary(plan, rcPath);
    const keptReplaceable = plan.kept.filter(isReplaceable);

    if (keptReplaceable.length > 0 && !interactive) {
        out.log.info(`Hand-made wiring is kept; ${toolCommand("zsh completions", "--replace-hand")} replaces it.`);
    }

    const diff = rcDiff({ rcPath, before: rcText, after: plan.after });

    if (opts.dryRun) {
        out.log.info(
            plan.wired.length > 0
                ? `Would generate: ${plan.wired.map((provider) => completionFilePath(completionsDir(), provider.cli)).join(", ")}`
                : "Would generate no file"
        );
        out.print(diff ? `${colorDiff(diff)}\n` : `${rcPath}: no change\n`);
        return;
    }

    if (interactive) {
        if (diff) {
            out.log.message(colorDiff(diff));
        }

        const ok = await p.confirm({
            message: `Generate ${plan.wired.length} file(s) and ${diff ? `write ${rcPath}` : `leave ${rcPath} as it is`}?`,
            initialValue: true,
        });

        if (!ok) {
            p.cancel("Nothing written");
            return;
        }
    }

    const state = readStateForUpdate();
    const results = await generateCompletions({ providers: plan.wired, completionsDir: completionsDir(), state });
    const failed = results.filter((result) => result.error && !result.installed);

    for (const result of results.filter((entry) => entry.error)) {
        out.log.warn(
            `${pc.bold(result.provider.cli)}: ${result.error}${result.installed ? " (the old file stays)" : ""}`
        );
    }

    if (failed.length > 0) {
        const failedNames = new Set(failed.map((result) => result.provider.cli));
        const remaining = selected.filter((provider) => !failedNames.has(provider.cli));
        plan = planCompletions({
            rcText: baseText,
            selected: remaining,
            replace: replace.filter((block) => !failedNames.has(block.provider.cli)),
            completionsDir: completionsDir(),
            home: home(),
        });
    }

    replaceRc(rcPath, rcBefore, plan.after);
    const clis: CompletionsState["clis"] = {};

    for (const result of results) {
        if (result.installed && plan.wired.some((provider) => provider.cli === result.provider.cli)) {
            clis[result.provider.cli] = result.installed;
        }
    }

    const replacedHand: Record<string, ReplacedHandBlock[]> = {};

    for (const [cli, records] of Object.entries(prior.replacedHand ?? {})) {
        if (plan.wired.some((provider) => provider.cli === cli)) {
            replacedHand[cli] = records;
        }
    }

    for (const block of plan.replaced) {
        replacedHand[block.provider.cli] = [...(replacedHand[block.provider.cli] ?? []), replacedRecord(block)];
    }

    writeState({ version: 1, rc: rcPath, clis, replacedHand });
    logger.debug({ rcPath, wired: Object.keys(clis) }, "zsh completions: installed");

    out.log.success(
        plan.wired.length > 0
            ? `Wired ${plan.wired.map((provider) => provider.cli).join(", ")} in ${rcPath}`
            : `No CLI wired; ${rcPath} has no completions block`
    );
    out.log.info("Open a new shell to use them.");
}

async function refreshAction(): Promise<void> {
    const state = readStateForUpdate();
    const names = Object.keys(state.clis);

    if (names.length === 0) {
        out.log.info(`Nothing installed yet: ${toolCommand("zsh completions")}`);
        return;
    }

    const known = names.map((name) => getCompletionProvider(name)).filter((provider) => provider !== undefined);
    const present = detectProviders(known).map((entry) => entry.provider);
    const results = await generateCompletions({ providers: present, completionsDir: completionsDir(), state });
    const table = createBoxTable(["CLI", "FILE", "VERSION", "RESULT"]);

    for (const name of names) {
        const result = results.find((entry) => entry.provider.cli === name);
        const before = state.clis[name];

        if (!result) {
            table.push([
                pc.bold(name),
                before?.file ?? "",
                before?.version ?? "",
                formatDotStatus("warn", "not on PATH, file kept"),
            ]);
            continue;
        }

        if (result.installed) {
            state.clis[name] = result.installed;
        }

        const after = result.installed?.version;
        const version = versionChanged(before, after) ? `${before?.version} → ${after}` : (after ?? "");
        let status = formatDotStatus("dim", "unchanged");

        if (result.error) {
            status = formatDotStatus("err", `failed: ${result.error}`);
        } else if (result.changed) {
            status = formatDotStatus("ok", "rewritten");
        }

        table.push([pc.bold(name), result.installed?.file ?? "", version, status]);
    }

    writeState(state);
    out.println(table.toString());

    for (const result of results) {
        const now = result.installed?.version;

        if (result.previousVersion && now && result.previousVersion !== now) {
            out.log.info(
                `${pc.bold(result.provider.cli)} changed version since its file was generated: ${result.previousVersion} → ${now}`
            );
        }
    }

    const rcPath = state.rc ?? defaultRcPath();

    if (!findOwnBlock((readRc(rcPath) ?? "").split("\n"))) {
        out.log.warn(`${rcPath} has no completions block; ${toolCommand("zsh completions")} writes it.`);
    }
}

async function uninstallAction(opts: InstallOptions): Promise<void> {
    const { state } = readStateReadOnly();
    const rcPath = opts.rc ?? state.rc ?? defaultRcPath();
    const before = readRc(rcPath);

    if (before === undefined || !findOwnBlock(before.split("\n"))) {
        out.log.info(`${rcPath} has no completions block.`);
    }

    const records = Object.values(state.replacedHand ?? {}).flat();
    const restore = before === undefined ? undefined : restoreHandBlocks(before, records);
    const after = restore === undefined ? undefined : stripOwnBlock(restore.text);

    for (const record of restore?.missing ?? []) {
        out.log.warn(
            `Could not put back (its "${record.replacement.join(" ")}" line is gone): ${record.original[0] ?? ""} …`
        );
    }

    if (restore && restore.restored.length > 0) {
        out.log.step(`Puts back ${restore.restored.length} hand-made block(s) the install replaced`);
    }

    if (opts.dryRun) {
        const diff = before === undefined || after === undefined ? "" : rcDiff({ rcPath, before, after });
        out.print(diff ? `${colorDiff(diff)}\n` : `${rcPath}: no change\n`);
        return;
    }

    if (before !== undefined && after !== undefined && before !== after) {
        replaceRc(rcPath, before, after);
        out.log.success(`Removed the completions block from ${rcPath}`);
    }

    const updated = readStateForUpdate();

    if (Object.keys(updated.clis).length > 0 || updated.rc || updated.replacedHand) {
        const unrestored = (restore?.missing ?? []).length > 0 ? updated.replacedHand : undefined;
        writeState({ version: 1, clis: {}, ...(unrestored ? { replacedHand: unrestored } : {}) });
    }

    logger.debug({ rcPath, removed: Object.keys(updated.clis) }, "zsh completions: uninstalled");
    out.log.info(
        `The generated files stay in ${completionsDir()}; delete them with ${toolCommand("rm", completionsDir())}`
    );
}

export function registerCompletionsCommand(program: Command): void {
    const completions = program
        .command("completions")
        .description(
            "Install static zsh completions for the CLIs on PATH (generated once, nothing runs at shell start)"
        )
        .option("-y, --yes", "accept the defaults without prompts: every CLI found, hand-made wiring kept")
        .option("--list", "print the CLIs found and what would be installed, change nothing")
        .option("--dry-run", "print the planned rc diff and the files to generate, write nothing")
        .option("--replace-hand", "without prompts: replace the hand-made wiring of the selected CLIs")
        .option("--rc <path>", "the zsh rc file (default: $ZDOTDIR/.zshrc, else ~/.zshrc)")
        .action(async (opts: InstallOptions) => {
            await installAction(opts);
        });

    completions
        .command("refresh")
        .description("Regenerate every installed completion file (after a CLI update) and report which changed")
        .action(async () => {
            await refreshAction();
        });

    completions
        .command("uninstall")
        .description("Remove the completions block from the rc file (honours --dry-run and --rc of `completions`)")
        .action(async (_opts: unknown, command: Command) => {
            await uninstallAction(command.optsWithGlobals<InstallOptions>());
        });
}
