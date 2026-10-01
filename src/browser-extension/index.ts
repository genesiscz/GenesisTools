#!/usr/bin/env bun

import { resolve } from "node:path";
import { reloadExtension, reloadSummary } from "@app/chrome-devtools/lib/extensions";
import { extensionByKey } from "@genesiscz/utils/browser-extension/registry";
import { runTool } from "@genesiscz/utils/cli";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { BROWSER_DEVTOOLS_PORT } from "@genesiscz/utils/net/ports";
import { Command } from "commander";
import { runAction } from "./lib/actions";
import { buildExtension, DIST_DIR } from "./lib/build";
import { configPath, loadConfig, saveConfig } from "./lib/config";
import { liveDeps } from "./lib/deps";
import { watchAndRebuild } from "./lib/dev";
import { explainHunk } from "./lib/explain";
import { dispatch } from "./lib/host/dispatch";
import { hostStatus, installHost } from "./lib/host/install";
import { hubTarget, openInHub } from "./lib/hub";
import { describeCheckouts, openFile, openTerminal } from "./lib/open";
import { planReview, startReview } from "./lib/review";
import { routeLink } from "./lib/router";
import { verifyExtension } from "./lib/verify";

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

const ENTRY = extensionByKey("genesis-tools");

/** Reloads the extension in the running browser over DevTools and says what happened. */
async function reloadInBrowser(port: number): Promise<boolean> {
    if (!ENTRY) {
        return false;
    }

    const result = await reloadExtension({ id: ENTRY.id, page: ENTRY.reloadPage, port });
    out.println(reloadSummary(result, ENTRY));
    return result.ok;
}

program
    .command("build")
    .description(`Bundle the extension into ${DIST_DIR}, then reload it in the browser when DevTools is open`)
    .option("--out <dir>", "output folder", DIST_DIR)
    .option("--no-reload", "Do not reload the extension in the browser")
    .option("--port <port>", "DevTools port of the running browser", String(BROWSER_DEVTOOLS_PORT))
    .action(async (opts: { out: string; reload: boolean; port: string }) => {
        try {
            const built = await buildExtension({ outDir: opts.out });
            out.println(`Built ${built.files.length} files into ${built.outDir}`);

            if (opts.reload && opts.out === DIST_DIR) {
                await reloadInBrowser(Number(opts.port));
            }
        } catch (error) {
            fail(error);
        }
    });

program
    .command("reload")
    .description("Reload the extension in the running browser over DevTools (no click)")
    .option("--port <port>", "DevTools port of the running browser", String(BROWSER_DEVTOOLS_PORT))
    .action(async (opts: { port: string }) => {
        if (!(await reloadInBrowser(Number(opts.port)))) {
            process.exitCode = 1;
        }
    });

program
    .command("verify")
    .description("Load dist in a headless browser on a throwaway profile and check it works")
    .option("--dist <dir>", "the build to check", DIST_DIR)
    .action(async (opts: { dist: string }) => {
        try {
            const checks = await verifyExtension(opts.dist);

            for (const check of checks) {
                out.println(`${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`);
            }

            if (checks.length === 0 || checks.some((check) => !check.ok)) {
                process.exitCode = 1;
            }
        } catch (error) {
            fail(error);
        }
    });

program
    .command("dev")
    .description("Rebuild on every change and reload the extension in the browser, until Ctrl-C")
    .option("--port <port>", "DevTools port of the running browser", String(BROWSER_DEVTOOLS_PORT))
    .action(async (opts: { port: string }) => {
        const roots = [ENTRY?.sourceDir, resolve(DIST_DIR, "..", "..", "src", "browser-extension", "lib")].filter(
            (root): root is string => root !== undefined
        );
        // One build and reload first: the watcher only reacts to changes, so dist would stay old until one.
        try {
            const built = await buildExtension();
            out.println(`Built ${built.info.buildId.slice(0, 8)}`);
            await reloadInBrowser(Number(opts.port));
        } catch (error) {
            fail(error);
            return;
        }

        out.println(`Watching ${roots.join(", ")}. Ctrl-C stops.`);
        await withInterrupt((signal) =>
            watchAndRebuild({
                roots,
                signal,
                build: async () => {
                    const built = await buildExtension();
                    out.println(`Built ${built.info.buildId.slice(0, 8)}`);
                },
                after: async () => {
                    await reloadInBrowser(Number(opts.port));
                },
            })
        );
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
    .command("hub")
    .description(
        "Open a page in GenesisTools, as the extension's Open in GenesisTools does: a PR/MR in the PRs mode, any other project page in Worktrees"
    )
    .argument("<url>", "a PR/MR page, or any page of a project with a local checkout")
    .option("--path <file>", "with a PR/MR: open this repository-relative file in its review")
    .option("--branch <name>", "prefer the worktree on this branch")
    .option("--dry-run", "print what would open; open nothing")
    .action(async (url: string, opts: { path?: string; branch?: string; dryRun?: boolean }) => {
        try {
            const deps = liveDeps();

            if (opts.dryRun) {
                out.result(await hubTarget(deps, { url, path: opts.path, branch: opts.branch }));
                return;
            }

            const opened = await openInHub(deps, { url, path: opts.path, branch: opts.branch });
            out.println(opened.detail);
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
    .description("Hand a router link to GenesisTools.app, as the extension does")
    .argument("<url>", "a link on the router's link host, or one of its configured hosts")
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
