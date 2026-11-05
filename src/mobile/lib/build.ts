import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { logger } from "@genesiscz/utils/logger";
import { type IosApp, type IosConfiguration, iosApp, type MobileProject } from "@genesiscz/utils/mobile/project";
import { installApp } from "@genesiscz/utils/mobile/simulator";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { fingerprintBuild, saveFingerprint } from "./fingerprint";

const log = logger.child({ component: "mobile.build" });

export function defaultDerivedData(appDir: string): string {
    return join(appDir, "ios", "build");
}

/** Where xcodebuild leaves the simulator `.app` for one configuration. */
export function builtAppPath(ios: Pick<IosApp, "build">, derivedData: string, configuration: IosConfiguration): string {
    return join(derivedData, "Build", "Products", `${configuration}-iphonesimulator`, `${ios.build.productName}.app`);
}

export interface BuildResult {
    appPath: string;
    logPath: string;
    seconds: number;
}

/**
 * Builds the project's iOS app for one simulator with `xcodebuild` and installs it with `simctl`. This is the path
 * that still works on Xcode 27, where Expo's `run:ios` stops at "Can't determine id of Simulator app" because
 * DeviceHub replaced it. The whole xcodebuild output goes to a log file; only its last error lines are raised.
 */
export async function buildAndInstall(options: {
    project: MobileProject;
    udid: string;
    logDir: string;
    install?: boolean;
    /** The DerivedData folder; default `<app>/ios/build`. Give each session its own, so two builds never share one. */
    derivedData?: string;
    /** Overrides the project's configuration (`up` builds Debug, which loads its JS from Metro). */
    configuration?: IosConfiguration;
}): Promise<BuildResult> {
    const { project, udid, logDir, install = true } = options;
    const { appDir } = project;
    const ios = iosApp(project);
    const configuration = options.configuration ?? ios.build.configuration;
    const derivedData = resolve(options.derivedData ?? defaultDerivedData(appDir));
    // Taken before the build: a file saved while xcodebuild runs must make the next `up` build again.
    const fingerprint = fingerprintBuild({ inputs: ios.buildInputs, appDir, configuration });
    const settings = Object.entries(ios.build.buildSettings ?? {}).map(([key, value]) => `${key}=${value}`);
    const command = [
        "xcodebuild",
        "-workspace",
        join(appDir, ios.build.workspace),
        "-scheme",
        ios.build.scheme,
        "-configuration",
        configuration,
        "-sdk",
        "iphonesimulator",
        "-destination",
        `id=${udid}`,
        "-derivedDataPath",
        derivedData,
        ...settings,
    ];

    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, `xcodebuild-${project.config.id}-${configuration}.log`);
    const started = performance.now();
    log.debug({ command: command.join(" "), logPath }, "xcodebuild start");

    const sink = createWriteStream(logPath);
    const errors: string[] = [];
    let sinkError: Error | undefined;
    sink.on("error", (error) => {
        sinkError = error;
    });
    const pump = async (chunk: Uint8Array) => {
        const text = new TextDecoder().decode(chunk);
        if (!sink.write(text)) {
            await once(sink, "drain");
        }
        errors.push(...text.split("\n").filter((line) => /\berror:/.test(line)));
        errors.splice(0, Math.max(0, errors.length - 5));
    };
    let proc: Awaited<ReturnType<typeof boundedCommand>>;

    try {
        proc = await boundedCommand({
            command,
            cwd: appDir,
            timeoutMs: 3_600_000,
            streamOnly: true,
            onStdout: pump,
            onStderr: pump,
        });
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
    const seconds = Math.round((performance.now() - started) / 1000);
    log.debug({ exitCode: proc.status, seconds, errors: errors.length }, "xcodebuild done");

    if (proc.status !== 0) {
        const tail = errors.slice(-5).join("\n") || "no error: line, read the log";
        throw new Error(`xcodebuild failed after ${seconds} s (log ${logPath}):\n${tail}`);
    }

    const appPath = builtAppPath(ios, derivedData, configuration);

    if (!existsSync(appPath)) {
        throw new Error(
            `xcodebuild succeeded but ${appPath} is missing; check platforms.ios.build.productName in ${project.configPath}`
        );
    }

    saveFingerprint({ derivedData, configuration, fingerprint });

    if (install) {
        await installApp(udid, appPath);
        log.debug({ udid, appPath }, "installed");
    }

    return { appPath, logPath, seconds };
}
