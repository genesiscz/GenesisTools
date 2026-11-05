#!/usr/bin/env bun

import { join } from "node:path";
import { runTool } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import { registerReport } from "./commands/report";
import { registerRun } from "./commands/run";
import { registerScreen } from "./commands/screen";
import { loadProject, type ProjectOptions, withConfig } from "./lib/project";
import { RUNNERS } from "./lib/runners";
import { listSpecs } from "./lib/specs";

const program = new Command()
    .name("e2e")
    .description(
        "Run a project's e2e specs (WebdriverIO with Appium for mobile, Playwright for web) one runner process per spec, and collect results, screenshots and logs into one run folder"
    );

withConfig(program.command("config").description("Show the e2e project this folder resolves to"))
    .option("--json", "print as JSON")
    .action(async (options: ProjectOptions & { json?: boolean }) => {
        const project = await loadProject(options);
        const summary = {
            configPath: project.configPath,
            id: project.config.id,
            runner: project.config.runner,
            runnerTitle: RUNNERS[project.config.runner.kind].title,
            cwd: project.cwd,
            specs: join(project.dir, project.config.specs.dir),
            pages: project.config.pages ? join(project.dir, project.config.pages) : null,
            suites: Object.keys(project.config.suites ?? {}),
            hooks: Object.keys(project.config.hooks ?? {}),
        };

        if (options.json) {
            out.result(summary);
            return;
        }

        ui.info(`${project.config.title ?? summary.id} · ${summary.runnerTitle} · ${summary.configPath}`);
        ui.dim(`runs from ${summary.cwd} · specs ${summary.specs}${summary.pages ? ` · pages ${summary.pages}` : ""}`);
        ui.dim(`suites: ${summary.suites.join(", ") || "none"} · hooks: ${summary.hooks.join(", ") || "none"}`);
    });

withConfig(program.command("list").description("List the project's spec files and named suites"))
    .option("--json", "print as JSON")
    .action(async (options: ProjectOptions & { json?: boolean }) => {
        const project = await loadProject(options);
        const specs = listSpecs(project);
        const suites = project.config.suites ?? {};
        const pages = project.config.pages ? join(project.dir, project.config.pages) : null;

        if (options.json) {
            out.result({ specs, suites, pages });
            return;
        }

        if (pages) {
            ui.dim(`pages: ${pages}`);
        }

        for (const spec of specs) {
            ui.info(`${spec.name}  ${spec.path}`);
        }

        if (specs.length === 0) {
            ui.warn(`no spec under ${join(project.dir, project.config.specs.dir)}`);
        }

        for (const [name, members] of Object.entries(suites)) {
            ui.dim(`suite ${name}: ${members.join(", ")}`);
        }
    });

registerRun(program);
registerScreen(program);
registerReport(program);

await runTool(program, { tool: "e2e" });
