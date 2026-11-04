import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { installApp } from "@genesiscz/utils/mobile/simulator";
import type { MobileApp } from "./types";

const log = logger.child({ component: "mobile.build" });

export interface BuildResult {
    appPath: string;
    logPath: string;
    seconds: number;
}

/**
 * Builds the app for one simulator with `xcodebuild` and installs it with `simctl`. This is the path that still works
 * on Xcode 27, where Expo's `run:ios` stops at "Can't determine id of Simulator app" because DeviceHub replaced it.
 * The whole xcodebuild output goes to a log file; only its last error lines are raised.
 */
export async function buildAndInstall(options: {
    app: MobileApp;
    appDir: string;
    udid: string;
    logDir: string;
    install?: boolean;
}): Promise<BuildResult> {
    const { app, appDir, udid, logDir, install = true } = options;
    const { ios } = app;
    const derivedData = join(appDir, "ios", "build");
    const settings = Object.entries(ios.buildSettings ?? {}).map(([key, value]) => `${key}=${value}`);
    const command = [
        "xcodebuild",
        "-workspace",
        join(appDir, ios.workspace),
        "-scheme",
        ios.scheme,
        "-configuration",
        ios.configuration,
        "-sdk",
        "iphonesimulator",
        "-destination",
        `id=${udid}`,
        "-derivedDataPath",
        derivedData,
        ...settings,
    ];

    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, `xcodebuild-${app.id}.log`);
    const started = performance.now();
    log.debug({ command: command.join(" "), logPath }, "xcodebuild start");

    const proc = Bun.spawn(command, { cwd: appDir, stdout: "pipe", stderr: "pipe" });
    const sink = createWriteStream(logPath);
    const errors: string[] = [];
    const pump = async (stream: ReadableStream<Uint8Array>) => {
        const decoder = new TextDecoder();
        for await (const chunk of stream) {
            const text = decoder.decode(chunk, { stream: true });
            sink.write(text);

            for (const line of text.split("\n")) {
                if (/\berror:/.test(line)) {
                    errors.push(line.trim());
                }
            }
        }
    };

    await Promise.all([pump(proc.stdout), pump(proc.stderr), proc.exited]);
    sink.end();
    const seconds = Math.round((performance.now() - started) / 1000);
    log.debug({ exitCode: proc.exitCode, seconds, errors: errors.length }, "xcodebuild done");

    if (proc.exitCode !== 0) {
        const tail = errors.slice(-5).join("\n") || "no error: line, read the log";
        throw new Error(`xcodebuild failed after ${seconds} s (log ${logPath}):\n${tail}`);
    }

    const appPath = join(
        derivedData,
        "Build",
        "Products",
        `${ios.configuration}-iphonesimulator`,
        `${ios.productName}.app`
    );

    if (!existsSync(appPath)) {
        throw new Error(`xcodebuild succeeded but ${appPath} is missing; check productName in the ${app.id} adapter`);
    }

    if (install) {
        await installApp(udid, appPath);
        log.debug({ udid, appPath }, "installed");
    }

    return { appPath, logPath, seconds };
}
