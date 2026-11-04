import { ui } from "@genesiscz/utils/cli/ui";
import { out } from "@genesiscz/utils/logger";
import { shellCommandLine } from "@genesiscz/utils/shell/quote";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import type { Command } from "commander";
import { mobileApp } from "../apps";
import { stamp } from "../lib/paths";
import { clockBuildNumber, releasePlan, runRelease } from "../lib/release";

interface ReleaseOptions {
    team?: string;
    apiKey?: string;
    apiKeyId?: string;
    apiIssuer?: string;
    buildNumber?: string;
    exportOnly?: boolean;
    dryRun?: boolean;
    json?: boolean;
}

/**
 * `tools mobile release <app>`: prebuild with the production push environment, a signed device archive, and an export
 * that uploads to App Store Connect for TestFlight. `--dry-run` prints the steps and what is still missing.
 */
export function registerRelease(program: Command): void {
    program
        .command("release <app>")
        .description("Archive a signed device build and upload it to App Store Connect (TestFlight)")
        .option("--team <id>", "the Apple Developer team id")
        .option("--api-key <file>", "the App Store Connect API key (AuthKey_XXXX.p8)")
        .option("--api-key-id <id>", "the API key id")
        .option("--api-issuer <id>", "the API key issuer id")
        .option("--build-number <n>", "CFBundleVersion; default: the UTC clock to the minute")
        .option("--export-only", "export the .ipa and do not upload")
        .option("--dry-run", "print the steps and what is missing; build nothing")
        .option("--json", "print the plan as JSON (with --dry-run)")
        .action(async (id: string, options: ReleaseOptions) => {
            const app = mobileApp(id);
            const outDir = toolDataDir("mobile", "releases", app.id, stamp());
            const plan = releasePlan({
                app,
                appDir: app.locate(),
                team: options.team,
                apiKey: { path: options.apiKey, id: options.apiKeyId, issuer: options.apiIssuer },
                buildNumber: options.buildNumber ?? clockBuildNumber(),
                outDir,
                exportOnly: Boolean(options.exportOnly),
            });

            if (options.dryRun) {
                if (options.json) {
                    out.result(plan);
                    return;
                }

                for (const [index, step] of plan.steps.entries()) {
                    const env = Object.entries(step.env ?? {}).map(([key, value]) => `${key}=${value} `);
                    ui.info(`${index + 1}. ${step.title}`);
                    ui.dim(`   (cd ${step.cwd} && ${env.join("")}${shellCommandLine(step.command)})`);
                }

                ui.dim(`ExportOptions.plist → ${plan.exportOptionsPath}`);

                for (const need of plan.missing) {
                    ui.warn(`missing: ${need}`);
                }

                process.exitCode = plan.missing.length > 0 ? 1 : 0;
                return;
            }

            if (plan.missing.length > 0) {
                for (const need of plan.missing) {
                    ui.err(`missing: ${need}`);
                }

                process.exitCode = 1;
                return;
            }

            await runRelease(plan, {
                outDir,
                onStep: (step, index) => ui.info(`${index + 1}/${plan.steps.length} ${step.title}`),
            });
            ui.ok(
                options.exportOnly ? `exported to ${outDir}/export` : "uploaded; TestFlight shows it after processing"
            );
        });
}
