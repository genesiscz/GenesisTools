#!/usr/bin/env bun

import { runTool } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import { runAction } from "./lib/actions";
import { buildExtension, DIST_DIR } from "./lib/build";
import { configPath, loadConfig, saveConfig } from "./lib/config";
import { liveDeps } from "./lib/deps";
import { explainHunk } from "./lib/explain";
import { dispatch } from "./lib/host/dispatch";
import { hostStatus, installHost } from "./lib/host/install";
import { describeCheckouts, openFile, openTerminal } from "./lib/open";
import { planReview, startReview } from "./lib/review";
import { routeLink } from "./lib/router";

const program = new Command()
    .name("browser-extension")
    .description(
        "The GenesisTools browser extension: build it, register its native host, and run its features from the CLI"
    );

function fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug({ error }, "browser-extension command failed");
    out.log.error(message);
    process.exitCode = 1;
}

function lineOption(value: string | undefined): number | undefined {
    return value === undefined ? undefined : Number(value);
}

program
    .command("build")
    .description(`Bundle the extension into ${DIST_DIR}`)
    .option("--out <dir>", "output folder", DIST_DIR)
    .action(async (opts: { out: string }) => {
        try {
            const built = await buildExtension({ outDir: opts.out });
            out.println(`Built ${built.files.length} files into ${built.outDir}`);
            out.println(
                "Load it: chrome://extensions (brave://extensions) > Developer mode > Load unpacked > that folder"
            );
        } catch (error) {
            fail(error);
        }
    });

program
    .command("install-host")
    .description("Write the native-messaging launcher and register it for Brave, Chrome and Chromium")
    .action(async () => {
        try {
            const installed = await installHost();
            out.println(`Extension id: ${installed.extensionId}`);
            out.println(`Launcher:     ${installed.launcher}`);

            for (const entry of installed.registered) {
                out.println(`Registered:   ${entry.browser}  ${entry.manifest}`);
            }

            if (installed.skipped.length > 0) {
                out.println(`Skipped (not installed): ${installed.skipped.join(", ")}`);
            }

            out.println("Restart the browser once so it reads the host manifest.");
        } catch (error) {
            fail(error);
        }
    });

program
    .command("status")
    .description("Extension id, launcher, per-browser registration and config path")
    .option("--json", "machine-readable output")
    .action((opts: { json?: boolean }) => {
        const status = { ...hostStatus(), configPath: configPath(), dist: DIST_DIR };

        if (opts.json) {
            out.result(status);
            return;
        }

        out.println(`extension id  ${status.extensionId}`);
        out.println(`launcher      ${status.launcher} ${status.launcherExists ? "" : "(missing: run install-host)"}`);

        for (const browser of status.browsers) {
            const state = !browser.registered
                ? "not registered"
                : browser.allowsThisId
                  ? "registered"
                  : "registered for another id";
            out.println(`${browser.browser.padEnd(13)} ${state}`);
        }

        out.println(`config        ${status.configPath}`);
        out.println(`dist          ${status.dist}`);
    });

program
    .command("config")
    .description("Print the effective config, or write the defaults with --init")
    .option("--init", "write the defaults when no config file exists yet")
    .action(async (opts: { init?: boolean }) => {
        try {
            const exists = await Bun.file(configPath()).exists();

            if (opts.init && !exists) {
                await saveConfig(await loadConfig());
                out.log.info(`Wrote ${configPath()}`);
            }

            out.result(await loadConfig());
        } catch (error) {
            fail(error);
        }
    });

program
    .command("checkout")
    .description("Local checkouts (main + worktrees) of the project a GitHub/GitLab URL points at, best first")
    .argument("<url>", "any page of the project, or its clone URL")
    .option("--branch <name>", "prefer the worktree on this branch")
    .action(async (url: string, opts: { branch?: string }) => {
        try {
            out.result(await describeCheckouts(liveDeps(), { url, branch: opts.branch }));
        } catch (error) {
            fail(error);
        }
    });

program
    .command("open")
    .description("Open a page's file at its line in the editor, or its checkout in a terminal")
    .argument("<url>", "blob URL, or a PR/MR URL together with --path")
    .option("--path <file>", "repository-relative file")
    .option("--line <n>", "line number")
    .option("--branch <name>", "prefer the worktree on this branch")
    .option("--terminal", "open the checkout in the terminal driver instead")
    .action(async (url: string, opts: { path?: string; line?: string; branch?: string; terminal?: boolean }) => {
        try {
            const deps = liveDeps();
            const opened = opts.terminal
                ? await openTerminal(deps, { url, branch: opts.branch })
                : await openFile(deps, { url, branch: opts.branch, path: opts.path, line: lineOption(opts.line) });
            out.println(`${opened.driver}: ${opened.detail}`);
        } catch (error) {
            fail(error);
        }
    });

program
    .command("explain")
    .description("Explain a diff hunk (read from stdin) with the headless agent in the page's checkout")
    .argument("<url>", "the PR/MR page")
    .option("--path <file>", "repository-relative file of the hunk")
    .option("--line <n>", "line number")
    .option("--branch <name>", "prefer the worktree on this branch")
    .action(async (url: string, opts: { path?: string; line?: string; branch?: string }) => {
        try {
            const hunk = await Bun.stdin.text();
            const answer = await explainHunk(liveDeps(), {
                url,
                hunk,
                path: opts.path,
                line: lineOption(opts.line),
                branch: opts.branch,
            });
            out.print(`${answer.answer}\n`);
        } catch (error) {
            fail(error);
        }
    });

program
    .command("review")
    .description("Start an agent session that reviews the PR/MR with the review-proposal flow")
    .argument("<url>", "the PR/MR page")
    .option("--branch <name>", "prefer the worktree on this branch")
    .option("--dry-run", "print the gate and the prompt; start nothing")
    .action(async (url: string, opts: { branch?: string; dryRun?: boolean }) => {
        try {
            const deps = liveDeps();

            if (opts.dryRun) {
                out.result(await planReview(deps, { url, branch: opts.branch }));
                return;
            }

            const started = await startReview(deps, { url, branch: opts.branch });
            out.println(`${started.driver}: ${started.detail}`);
            out.println(`prompt: ${started.promptFile}`);
        } catch (error) {
            fail(error);
        }
    });

program
    .command("action")
    .description("Run a configured page action (the popup's buttons) for a URL")
    .argument("<id>", "action id from the config")
    .argument("<url>", "the page URL")
    .option("--field <name=value>", "a value the popup would read from the page; repeatable", collect, [] as string[])
    .option("--dry-run", "print the command; run nothing")
    .action(async (id: string, url: string, opts: { field: string[]; dryRun?: boolean }) => {
        try {
            const fields = Object.fromEntries(
                opts.field.map((pair) => {
                    const at = pair.indexOf("=");
                    return at === -1 ? [pair, ""] : [pair.slice(0, at), pair.slice(at + 1)];
                })
            );
            out.result(await runAction(liveDeps(), { actionId: id, url, fields, dryRun: opts.dryRun }));
        } catch (error) {
            fail(error);
        }
    });

program
    .command("route")
    .description("Hand a genesis.tools link to GenesisTools.app, as the extension does")
    .argument("<url>", "https://genesis.tools/...")
    .action(async (url: string) => {
        try {
            out.result(await routeLink(liveDeps(), url));
        } catch (error) {
            fail(error);
        }
    });

program
    .command("call")
    .description("Send one request through the native host's dispatcher, in process (for testing the allowlist)")
    .argument("<command>", "a host command, e.g. ping or checkout.resolve")
    .argument("[params]", "JSON object of params")
    .action(async (command: string, params: string | undefined) => {
        const parsed: unknown = params ? SafeJSON.parse(params, { strict: true }) : {};
        const reply = await dispatch(liveDeps(), { command, params: parsed });
        out.result(reply);
        process.exitCode = reply.ok ? 0 : 1;
    });

function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
}

await runTool(program, { tool: "browser-extension" });
