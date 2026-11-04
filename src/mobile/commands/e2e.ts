import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { out } from "@genesiscz/utils/logger";
import { findById, parseSource } from "@genesiscz/utils/mobile/a11y";
import type { Command } from "commander";
import { mobileApp } from "../apps";
import { captureScreen } from "../lib/capture";
import { pickSimulator } from "../lib/device";
import { listSpecs, type RunSummary, resolveSpecs, runE2e, type SpecFile, specFailed, suiteSpecs } from "../lib/e2e";
import { runDirFor } from "../lib/paths";
import { resolveRoute } from "../lib/routes";
import { openScreenDriver, RootMissingError } from "../lib/screen-driver";
import { ensureAppium } from "../lib/session";
import { requireInstalled } from "../lib/tour";

interface RunOptions {
    udid?: string;
    appiumPort?: string;
    agent?: string;
    alertWatcher: boolean;
    out?: string;
    stream?: boolean;
    json?: boolean;
}

function runOptions(command: Command): Command {
    return command
        .option("--udid <udid>", "the simulator; default: the only booted one")
        .option("--appium-port <port>", "the Appium server (default: the simulator's own, started when missing)")
        .option("--agent <url>", "the server the app pairs with, e.g. a side agent on http://127.0.0.1:3143")
        .option("--no-alert-watcher", "do not answer system alerts during the run")
        .option("--out <dir>", "the run folder (default ~/.genesis-tools/mobile/runs/<time>)")
        .option("--stream", "print the runner's output while it runs")
        .option("--json", "print the summary as JSON");
}

async function run(id: string, pick: (all: SpecFile[]) => SpecFile[], options: RunOptions): Promise<void> {
    const app = mobileApp(id);
    const appDir = app.locate();
    const specs = pick(listSpecs(app, appDir));
    const device = await pickSimulator(options.udid);
    await requireInstalled(app, device.udid, app.bundleId(appDir));
    const appiumPort = await ensureAppium({
        udid: device.udid,
        port: options.appiumPort ? Number(options.appiumPort) : undefined,
    });
    const runDir = options.out ?? runDirFor("runs");

    if (!options.json) {
        ui.info(`${specs.length} spec(s) on ${device.name} (${device.udid}) · appium :${appiumPort} · ${runDir}`);
    }

    const summary: RunSummary = await runE2e({
        app,
        appDir,
        device,
        specs,
        appiumPort,
        runDir,
        agentUrl: options.agent,
        watchAlerts: options.alertWatcher,
        onSpecStart: options.json ? undefined : (spec, index, total) => ui.info(`${index + 1}/${total} ${spec.name}`),
        onSpecDone: options.json
            ? undefined
            : (spec) => {
                  const passed = spec.tests.filter((test) => test.state === "passed").length;
                  const line = `${spec.spec.name}: ${passed}/${spec.tests.length} passed in ${spec.seconds} s`;
                  specFailed(spec) ? ui.err(`${line} (exit ${spec.exitCode}, log ${spec.log})`) : ui.ok(line);

                  for (const test of spec.tests.filter((candidate) => candidate.state === "failed")) {
                      ui.dim(`  ✗ ${test.title}: ${(test.error ?? "").split("\n")[0]}`);
                  }
              },
        onLine: options.stream && !options.json ? (line) => ui.dim(line) : undefined,
    });

    if (options.json) {
        out.result(summary);
    } else {
        const { counts } = summary;
        const line = `${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped · ${summary.alerts.length} alert(s)`;
        summary.ok ? ui.ok(line) : ui.err(line);
        ui.dim(`summary: ${runDir}/summary.md`);
    }

    if (!summary.ok) {
        process.exitCode = 1;
    }
}

export function registerE2e(program: Command): void {
    const e2e = program
        .command("e2e")
        .description("Run the app's own e2e specs on one simulator and collect the results");

    e2e.command("specs <app>")
        .description("List the app's spec files and named suites")
        .option("--json", "print as JSON")
        .action((id: string, options: { json?: boolean }) => {
            const app = mobileApp(id);
            const specs = listSpecs(app, app.locate());
            const suites = app.e2e?.suites ?? {};

            if (options.json) {
                out.result({ specs, suites });
                return;
            }

            for (const spec of specs) {
                ui.info(`${spec.name}  ${spec.path}`);
            }

            for (const [name, members] of Object.entries(suites)) {
                ui.dim(`suite ${name}: ${members.join(", ")}`);
            }
        });

    runOptions(
        e2e
            .command("run <app> <specs...>")
            .description("Run these spec files (a name, a path, or a word in the name), one runner process each")
    ).action((id: string, names: string[], options: RunOptions) => run(id, (all) => resolveSpecs(all, names), options));

    runOptions(
        e2e
            .command("suite <app> [name]")
            .description(`Run a named suite, or all (list them: ${toolCommand("mobile e2e specs", "<app>")})`)
    ).action((id: string, name: string | undefined, options: RunOptions) => {
        const app = mobileApp(id);
        return run(id, () => suiteSpecs(app, app.locate(), name ?? "all"), options);
    });

    e2e.command("screen <app> <route>")
        .description("Open one screen, check its root shows and no LogBox covers it, and save its capture")
        .option("--udid <udid>", "the simulator; default: the only booted one")
        .option("--appium-port <port>", "the Appium server (default: the simulator's own, started when missing)")
        .option("--expect <ids...>", "testIDs that must be on the screen")
        .option("--out <dir>", "the folder (default ~/.genesis-tools/mobile/runs/<time>)")
        .option("--json", "print the result as JSON")
        .action(
            async (
                id: string,
                target: string,
                options: { udid?: string; appiumPort?: string; expect?: string[]; out?: string; json?: boolean }
            ) => {
                const app = mobileApp(id);
                const appDir = app.locate();
                const device = await pickSimulator(options.udid);
                const bundleId = app.bundleId(appDir);
                await requireInstalled(app, device.udid, bundleId);
                const route = resolveRoute(app, appDir, target);
                const driver = await openScreenDriver("appium", {
                    udid: device.udid,
                    bundleId,
                    settleMs: 1_500,
                    appiumPort: options.appiumPort ? Number(options.appiumPort) : undefined,
                });
                const problems: string[] = [];
                const outDir = options.out ?? runDirFor("runs");

                try {
                    try {
                        await driver.open(route);
                    } catch (error) {
                        if (!(error instanceof RootMissingError)) {
                            throw error;
                        }

                        problems.push(error.message);
                    }

                    const capture = await captureScreen({ driver, outDir, name: route.name, route });
                    const xml = capture.files.xml ? await Bun.file(capture.files.xml).text() : "";
                    const nodes = parseSource(xml);

                    for (const expected of options.expect ?? []) {
                        if (!findById(nodes, expected)) {
                            problems.push(`#${expected} is not on the screen`);
                        }
                    }

                    if (capture.logbox && capture.logbox !== "none") {
                        problems.push(`a LogBox is ${capture.logbox} over the screen`);
                    }

                    for (const alert of capture.summary?.alerts ?? []) {
                        problems.push(`an alert is open: ${alert}`);
                    }

                    if (options.json) {
                        out.result({ route, ok: problems.length === 0, problems, ...capture });
                    } else {
                        if (problems.length === 0) {
                            ui.ok(`${route.name} shows`);
                        }

                        for (const problem of problems) {
                            ui.err(problem);
                        }

                        ui.dim(`tree: ${capture.files.tree ?? "(none)"} · screenshot: ${capture.files.png}`);
                        ui.dim(`texts: ${(capture.summary?.texts ?? []).slice(0, 20).join(" · ")}`);
                    }
                } finally {
                    await driver.close();
                }

                if (problems.length > 0) {
                    process.exitCode = 1;
                }
            }
        );
}
