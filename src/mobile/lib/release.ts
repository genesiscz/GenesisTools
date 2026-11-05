import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { iosApp, type MobileProject, type ReleaseCommand } from "@genesiscz/utils/mobile/project";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";

const log = logger.child({ component: "mobile.release" });

/** The App Store Connect API key `xcodebuild` signs and uploads with (Users and Access > Integrations > Keys). */
export interface AscApiKey {
    /** The `AuthKey_<id>.p8` file. */
    path: string;
    id: string;
    /** The issuer id shown above the key list. */
    issuer: string;
}

export interface ReleaseInput {
    project: MobileProject;
    /** The Apple Developer team id. */
    team?: string;
    apiKey?: Partial<AscApiKey>;
    /** CFBundleVersion; each upload needs a higher one. */
    buildNumber: string;
    /** Where the archive, the export options and the logs go. */
    outDir: string;
    /** `false` uploads the build to App Store Connect (TestFlight); `true` exports the .ipa only. */
    exportOnly: boolean;
}

export interface ReleaseStep {
    title: string;
    command: string[];
    cwd: string;
    env?: Record<string, string>;
    runIf?: () => boolean;
}

export interface ReleasePlan {
    steps: ReleaseStep[];
    archivePath: string;
    exportOptionsPath: string;
    exportOptions: string;
    /** What the user must supply before the plan can run; empty when it can. */
    missing: string[];
}

/** The user-facing name of each input the plan needs, for the "missing" list. */
const NEEDS = {
    team: "--team <Apple team id> (developer.apple.com > Membership details)",
    keyPath: "--api-key <AuthKey_XXXX.p8> (App Store Connect > Users and Access > Integrations > Keys)",
    keyId: "--api-key-id <key id>",
    issuer: "--api-issuer <issuer id>",
} as const;

function authFlags(key: Partial<AscApiKey> | undefined): string[] {
    return key?.path && key.id && key.issuer
        ? ["-authenticationKeyPath", key.path, "-authenticationKeyID", key.id, "-authenticationKeyIssuerID", key.issuer]
        : [];
}

/** ExportOptions.plist for App Store Connect: automatic signing, and an upload unless `exportOnly`. */
export function exportOptionsPlist({ team, exportOnly }: { team: string; exportOnly: boolean }): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store-connect</string>
    <key>destination</key>
    <string>${exportOnly ? "export" : "upload"}</string>
    <key>teamID</key>
    <string>${team}</string>
    <key>signingStyle</key>
    <string>automatic</string>
    <key>uploadSymbols</key>
    <true/>
    <key>manageAppVersionAndBuildNumber</key>
    <false/>
</dict>
</plist>
`;
}

function prepareStep(appDir: string, step: ReleaseCommand): ReleaseStep {
    return { title: step.title, command: step.command, cwd: resolve(appDir, step.cwd ?? "."), env: step.env };
}

/**
 * The steps from source to TestFlight: the project's own preparation (`platforms.ios.release.prepare`, given the build
 * number), the pods, a signed device archive, then an export that uploads to App Store Connect. Pure, so `--dry-run`
 * prints exactly what a run would do.
 */
export function releasePlan(input: ReleaseInput): ReleasePlan {
    const { project, team, apiKey, buildNumber, outDir, exportOnly } = input;
    const { appDir } = project;
    const ios = iosApp(project);
    const missing = [
        ...(team ? [] : [NEEDS.team]),
        ...(apiKey?.path ? [] : [NEEDS.keyPath]),
        ...(apiKey?.id ? [] : [NEEDS.keyId]),
        ...(apiKey?.issuer ? [] : [NEEDS.issuer]),
    ];
    const teamId = team ?? "<TEAM_ID>";
    const archivePath = join(outDir, `${ios.build.productName}.xcarchive`);
    const exportOptionsPath = join(outDir, "ExportOptions.plist");
    const auth = authFlags(apiKey);
    const settings = Object.entries(ios.build.buildSettings ?? {}).map(([key, value]) => `${key}=${value}`);
    const prepare = (ios.release?.prepare?.({ buildNumber }) ?? []).map((step) => prepareStep(appDir, step));
    const pods = ios.release?.pods;

    return {
        archivePath,
        exportOptionsPath,
        exportOptions: exportOptionsPlist({ team: teamId, exportOnly }),
        missing,
        steps: [
            ...prepare,
            ...(pods === false
                ? []
                : [
                      {
                          title: "pods",
                          command: ["pod", "install"],
                          cwd: join(appDir, "ios"),
                          runIf: pods === true ? undefined : () => existsSync(join(appDir, "ios", "Podfile")),
                      },
                  ]),
            {
                title: "signed device archive",
                command: [
                    "xcodebuild",
                    "archive",
                    "-workspace",
                    join(appDir, ios.build.workspace),
                    "-scheme",
                    ios.build.scheme,
                    "-configuration",
                    "Release",
                    "-destination",
                    "generic/platform=iOS",
                    "-archivePath",
                    archivePath,
                    "-allowProvisioningUpdates",
                    ...auth,
                    `DEVELOPMENT_TEAM=${teamId}`,
                    "CODE_SIGN_STYLE=Automatic",
                    ...settings,
                ],
                cwd: appDir,
            },
            {
                title: exportOnly ? "export the .ipa" : "export and upload to App Store Connect (TestFlight)",
                command: [
                    "xcodebuild",
                    "-exportArchive",
                    "-archivePath",
                    archivePath,
                    "-exportOptionsPlist",
                    exportOptionsPath,
                    "-exportPath",
                    join(outDir, "export"),
                    "-allowProvisioningUpdates",
                    ...auth,
                ],
                cwd: appDir,
            },
        ],
    };
}

/** A build number from the clock (UTC, minute resolution): always higher than the last upload. */
export function clockBuildNumber(now = new Date()): string {
    return now.toISOString().slice(0, 16).replace(/[-T:]/g, "");
}

/** Runs the plan's steps in order, each step's output into its own log; stops at the first failure. */
export async function runRelease(
    plan: ReleasePlan,
    {
        outDir,
        onStep,
        timeoutMs,
    }: { outDir: string; onStep: (step: ReleaseStep, index: number) => void; timeoutMs?: number }
): Promise<void> {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(plan.exportOptionsPath, plan.exportOptions);

    for (const [index, step] of plan.steps.entries()) {
        if (step.runIf?.() === false) {
            continue;
        }

        onStep(step, index);
        const logPath = join(outDir, `${String(index + 1).padStart(2, "0")}.log`);
        if (!existsSync(step.cwd)) {
            throw new Error(`${step.title}: ${step.cwd} does not exist`);
        }

        log.debug({ command: step.command, logPath }, "release step");
        const sink = createWriteStream(logPath);
        let sinkError: Error | undefined;
        sink.on("error", (error) => {
            sinkError = error;
        });
        const pump = async (chunk: Uint8Array) => {
            if (!sink.write(chunk)) {
                await once(sink, "drain");
            }
        };

        try {
            const result = await boundedCommand({
                command: step.command,
                cwd: step.cwd,
                environment: { ...env.getProcessEnv(), ...step.env },
                timeoutMs: 3_600_000,
                streamOnly: true,
                onStdout: pump,
                onStderr: pump,
            });

            if (sinkError) {
                throw sinkError;
            }

            if (result.status !== 0) {
                throw new Error(`${step.title} failed (${result.error?.message ?? result.status}); log: ${logPath}`);
            }
        } finally {
            sink.end();
            try {
                await finished(sink, { signal: AbortSignal.timeout(5_000) });
            } catch (error) {
                sink.destroy();
                sinkError = error instanceof Error ? error : new Error(String(error));
            }
        }

        if (sinkError) {
            throw sinkError;
        }
    }
}
