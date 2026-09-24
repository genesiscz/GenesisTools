#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { isInteractive, runTool, suggestEnumFlag } from "@genesiscz/utils/cli";
import { PR_LIST_STATES, type PrListState } from "@genesiscz/utils/git/origins";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { genesisAppBundlePath } from "@genesiscz/utils/macos/genesis-app";
import { Command } from "commander";
import {
    hubStatus,
    listProposals,
    ProposalError,
    parseProposal,
    proposalKey,
    proposalMarkdown,
    saveProposal,
} from "./lib/proposal";
import { hubPr, hubPrs, PrRefError } from "./lib/prs";
import { repoFactsMany } from "./lib/repo";

function isPrListState(value: unknown): value is PrListState {
    return typeof value === "string" && (PR_LIST_STATES as readonly string[]).includes(value);
}

const program = new Command()
    .name("hub")
    .description("Data doors for the GenesisTools.app hub: review proposals, repo facts, PRs/MRs, the install gate");

const proposal = program
    .command("proposal")
    .description("Agent-written review proposals: verdict, draft comments, meta");

async function readInput(file: string): Promise<string> {
    return file === "-" ? await Bun.stdin.text() : await Bun.file(file).text();
}

function openInApp(path: string): void {
    const binary = join(genesisAppBundlePath(), "Contents", "MacOS", "GenesisTools");
    const child = spawn(binary, ["--review", "--proposal", path], { detached: true, stdio: "ignore" });
    child.unref();
}

proposal
    .command("push")
    .description("Validate and store a proposal (JSON file or - for stdin); keeps decisions already made in the window")
    .argument("<file>", "proposal JSON, or - for stdin")
    .option("--open", "open it in the review window")
    .option("--json", "print the stored key and path as JSON")
    .action(async (file: string, opts: { open?: boolean; json?: boolean }) => {
        try {
            const parsed = parseProposal(SafeJSON.parse(await readInput(file)));
            const saved = await saveProposal(parsed);

            if (opts.open) {
                const status = hubStatus();

                if (status.available) {
                    openInApp(saved.path);
                } else {
                    out.log.warn(`Not opened: ${status.reason}`);
                }
            }

            if (opts.json) {
                out.result(saved);
                return;
            }

            out.println(`Stored ${saved.key} (${parsed.drafts.length} drafts, ${saved.kept} kept from the window)`);
            out.println(saved.path);
        } catch (error) {
            out.log.error(error instanceof ProposalError ? `Invalid proposal: ${error.message}` : String(error));
            process.exitCode = 1;
        }
    });

proposal
    .command("list")
    .description("Stored proposals, newest first")
    .option("--json", "machine-readable output")
    .action((opts: { json?: boolean }) => {
        const all = listProposals();

        if (opts.json) {
            out.result(all.map((item) => ({ key: proposalKey(item), ...item })));
            return;
        }

        for (const item of all) {
            const open = item.drafts.filter((draft) => draft.status === "proposed").length;
            out.println(
                `${proposalKey(item)}  ${item.verdict.decision}  ${open}/${item.drafts.length} drafts open  ${item.title ?? ""}`
            );
        }
    });

proposal
    .command("show")
    .description("Print one proposal as markdown (json2md) or JSON")
    .argument("<key>", "key from `proposal list`")
    .option("--json", "the stored JSON")
    .action((key: string, opts: { json?: boolean }) => {
        const found = listProposals().find((item) => proposalKey(item) === key);

        if (!found) {
            out.log.error(`No proposal ${key}. See tools hub proposal list.`);
            process.exitCode = 1;
            return;
        }

        if (opts.json) {
            out.result(found);
            return;
        }

        out.print(proposalMarkdown(found));
    });

program
    .command("status")
    .description("Exit 0 when GenesisTools.app with the review window is installed, 1 otherwise (the hard gate)")
    .option("--json", "machine-readable output")
    .action((opts: { json?: boolean }) => {
        const status = hubStatus();

        if (opts.json) {
            out.result(status);
        } else {
            out.println(status.available ? `available: ${status.bundlePath}` : `not available: ${status.reason}`);
        }

        process.exitCode = status.available ? 0 : 1;
    });

program
    .command("repo")
    .description("Checkout, branch, origin web pages and (with --pr) the PR/MR of each folder, as JSON")
    .argument("<paths...>", "folders inside git checkouts")
    .option("--pr", "also look up the PR/MR whose head is the branch (gh / glab; slower)")
    .action(async (paths: string[], opts: { pr?: boolean }) => {
        out.result(await repoFactsMany({ paths, withPr: Boolean(opts.pr) }));
    });

// `tools hub pr …`: read-only views here (list, show); the review-thread verbs (find, threads, reply,
// draft, publish, resolve) join this group from handoff h_3te8zv19.
const pr = program.command("pr").description("GitHub PRs and GitLab MRs of the projects the hub shows");

pr.command("list")
    .description("Open (or merged/all) PRs/MRs of every project among the folders, as JSON; read-only")
    .argument("<paths...>", "folders inside git checkouts; worktrees and clones of one origin count once")
    .option("--state [state]", `${PR_LIST_STATES.join("|")} (default open)`)
    .option("--mine", "only PRs/MRs authored by the logged-in gh/glab user")
    .option("--limit <n>", "at most this many per project", "30")
    .action(async (paths: string[], opts: { state?: string | true; mine?: boolean; limit: string }) => {
        let state = opts.state === undefined ? "open" : opts.state;

        if (!isPrListState(state) && isInteractive()) {
            const picked = await p.select({
                message: "Which PRs/MRs",
                options: PR_LIST_STATES.map((value) => ({ value, label: value })),
            });

            if (p.isCancel(picked)) {
                process.exitCode = 1;
                return;
            }

            state = picked;
        }

        if (!isPrListState(state)) {
            out.log.error(
                suggestEnumFlag("tools hub", "--state", PR_LIST_STATES, {
                    subcommand: ["pr", "list"],
                    given: typeof state === "string" ? state : undefined,
                })
            );
            process.exitCode = 1;
            return;
        }

        const limit = Number(opts.limit);

        if (!Number.isInteger(limit) || limit < 1) {
            out.log.error(`--limit must be a positive integer, got "${opts.limit}"`);
            process.exitCode = 1;
            return;
        }

        out.result(await hubPrs({ paths, state, mine: Boolean(opts.mine), limit }));
    });

pr.command("show")
    .description("One PR/MR with body, commits, checks and merge state, as JSON; read-only")
    .argument("<ref>", "PR/MR URL, or <repoPath>#<number> (the path form also finds the local worktree)")
    .action(async (ref: string) => {
        try {
            out.result(await hubPr({ ref }));
        } catch (error) {
            if (!(error instanceof PrRefError)) {
                throw error;
            }

            out.log.error(error.message);
            out.result({ ref, error: error.message });
            process.exitCode = 1;
        }
    });

await runTool(program, { tool: "hub" });
