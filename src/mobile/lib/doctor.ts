import { existsSync } from "node:fs";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { adbBinary, androidSdkRoot, emulatorBinary } from "@genesiscz/utils/mobile/android";
import { appiumHome, appiumReady, xcuitestDriverVersion, xcuitestXcodeProblem } from "@genesiscz/utils/mobile/appium";
import {
    developerDir,
    listSimulators,
    simulatorUiClient,
    simulatorUiRunning,
    wdaPortsFor,
} from "@genesiscz/utils/mobile/simulator";

export interface DoctorCheck {
    name: string;
    ok: boolean;
    detail: string;
    fix?: string;
}

export interface DoctorReport {
    checks: DoctorCheck[];
    booted: Array<{ udid: string; name: string; osVersion: string; wdaPort: number }>;
}

/** Reads the Xcode, simulator and Appium state. It changes nothing: every problem comes with the command that fixes it. */
export async function mobileDoctor(appiumPort: number): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    let devDir = "";
    try {
        devDir = await developerDir();
        checks.push({ name: "xcode", ok: true, detail: devDir });
    } catch (error) {
        checks.push({
            name: "xcode",
            ok: false,
            detail: String(error),
            fix: "Install Xcode and select its developer directory",
        });
    }

    const client = simulatorUiClient(devDir);
    const uiRunning = await simulatorUiRunning();
    checks.push({
        name: "simulator UI",
        ok: client !== null,
        detail: client
            ? `${client.name}.app (${uiRunning ? "open, so Appium needs isHeadless false" : "closed, so isHeadless true"})`
            : "neither Simulator.app nor DeviceHub.app is in this Xcode",
    });

    const driver = xcuitestDriverVersion();
    const problem = xcuitestXcodeProblem(driver, client?.name === "DeviceHub");
    checks.push({
        name: "xcuitest driver",
        ok: problem === null,
        detail: driver ? `${driver} under ${appiumHome()}` : `none under ${appiumHome()}`,
        fix: problem ?? undefined,
    });

    const ready = await appiumReady(appiumPort);
    checks.push({
        name: "appium",
        ok: true,
        detail: ready ? `answers on :${appiumPort}` : `not running on :${appiumPort} (only the Appium driver needs it)`,
        fix: ready ? undefined : toolCommand("mobile appium start", "--port", String(appiumPort)),
    });

    const adbPath = adbBinary();
    const hasAdb = adbPath !== "adb" || Bun.which("adb") !== null;
    checks.push({
        name: "android",
        ok: true,
        detail: hasAdb
            ? `adb ${adbPath} · emulator ${existsSync(emulatorBinary()) ? emulatorBinary() : "missing"}`
            : `no adb under ${androidSdkRoot()} or on PATH (only Android needs it)`,
    });

    const simulators = await listSimulators().catch((error: unknown) => {
        checks.push({ name: "simctl", ok: false, detail: String(error), fix: "Install and select Xcode" });
        return [];
    });
    const booted = simulators
        .filter((device) => device.state === "Booted")
        .map((device) => ({
            udid: device.udid,
            name: device.name,
            osVersion: device.osVersion,
            wdaPort: wdaPortsFor(device.udid).wda,
        }));
    checks.push({
        name: "booted simulators",
        ok: booted.length > 0,
        detail: `${booted.length}`,
        fix: booted.length > 0 ? undefined : "xcrun simctl boot <udid>",
    });

    return { checks, booted };
}
