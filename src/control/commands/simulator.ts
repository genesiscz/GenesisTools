import { suggestCommand, suggestEnumFlag } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import {
    createBoxTable,
    formatDotStatus,
    renderCliHeader,
    renderCliSection,
    truncateDisplay,
} from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import type { ControlAction } from "../lib/decision/action";
import { elementLabel, type Observation, observationSchema } from "../lib/decision/observation";
import { addFormatOption, type FormatOptions, resolveFormat } from "../lib/output-format";
import { actOnSimulator } from "../lib/simulator/act";
import { SIMULATOR_ACTIONS, SimulatorControlDriver } from "../lib/simulator/driver";
import { IDB_INSTALL_HINT, idbAvailable } from "../lib/simulator/idb";
import { launchApp, listDevices, resolveDevice, screenshot } from "../lib/simulator/simctl";

const ACTION_VALUES = [...SIMULATOR_ACTIONS].sort();

interface SharedOptions {
    udid?: string;
    bundleId?: string;
    probe?: boolean;
    probeStep?: string;
    maxPoints?: string;
    json?: boolean;
}

function driverOptions(options: SharedOptions) {
    return {
        udid: options.udid,
        bundleId: options.bundleId,
        probe: options.probe,
        probeStep: options.probeStep === undefined ? undefined : Number(options.probeStep),
        maxProbePoints: options.maxPoints === undefined ? undefined : Number(options.maxPoints),
    };
}

async function requireIdb(): Promise<void> {
    if (await idbAvailable()) {
        return;
    }
    throw new Error(IDB_INSTALL_HINT);
}

function fail(error: unknown): never {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}

function printElements(observation: Observation): void {
    const table = createBoxTable(["#", "ROLE", "LABEL", "IDENTIFIER", "FRAME"]);
    for (const row of observation.elements) {
        const frame =
            typeof row.x === "number"
                ? `${Math.round(Number(row.x))},${Math.round(Number(row.y))} ${Math.round(Number(row.width))}x${Math.round(Number(row.height))}`
                : "—";
        table.push([
            pc.dim(String(row.index)),
            pc.cyan(row.role.replace(/^AX/, "")),
            truncateDisplay(`${"  ".repeat(row.depth)}${elementLabel(row)}`, 46),
            truncateDisplay(row.AXIdentifier ?? "", 26),
            pc.dim(frame),
        ]);
    }
    out.println(table.toString());
}

export function registerSimulatorCommands(program: Command): void {
    const sim = program
        .command("sim")
        .description(
            "iOS Simulator control — booted devices, app launch, and the same observe/act/readback contract as macOS, over idb.\nStart with `control sim see`, then `control sim act --snapshot-file`."
        );

    addFormatOption(sim.command("devices"))
        .description("List available simulators and which are booted")
        .action(async (options: FormatOptions & { json?: boolean }) => {
            const format = resolveFormat(options, "tools control sim");
            if (!format) {
                return;
            }
            try {
                const devices = await listDevices();
                if (format === "json") {
                    out.result(devices);
                    return;
                }
                renderCliHeader("iOS Simulators", "udid is what every other sim command takes");
                const table = createBoxTable(["STATE", "NAME", "RUNTIME", "UDID"]);
                for (const device of devices) {
                    table.push([
                        formatDotStatus(
                            device.booted ? "ok" : "dim",
                            device.booted ? "booted" : device.state.toLowerCase()
                        ),
                        pc.white(device.name),
                        pc.dim(device.runtime),
                        pc.dim(device.udid),
                    ]);
                }
                out.println(table.toString());
                renderCliSection("Next");
                out.println(suggestCommand("tools control sim", { replaceCommand: ["see"] }));
            } catch (error) {
                fail(error);
            }
        });

    addFormatOption(sim.command("launch"))
        .description("Launch an app by bundle id, or bring an already-running one to the front")
        .requiredOption("--bundle-id <id>", "e.g. com.apple.mobilecal")
        .option("--udid <udid>", "device udid or name; only needed when several are booted")
        .action(async (options: FormatOptions & { bundleId: string; udid?: string; json?: boolean }) => {
            const format = resolveFormat(options, "tools control sim");
            if (!format) {
                return;
            }
            try {
                const device = await resolveDevice({ udid: options.udid });
                const result = await launchApp({ udid: device.udid, bundleId: options.bundleId });
                if (format === "json") {
                    out.result({ ...result, udid: device.udid, device: device.name });
                    return;
                }
                out.println(
                    `${pc.green(result.alreadyRunning ? "foregrounded" : "launched")} ${pc.cyan(result.bundleId)} pid=${result.pid} on ${device.name}`
                );
            } catch (error) {
                fail(error);
            }
        });

    sim.command("screenshot")
        .description("Write a PNG of the simulator screen")
        .requiredOption("--path <file>", "output PNG path")
        .option("--udid <udid>", "device udid or name")
        .action(async (options: FormatOptions & { path: string; udid?: string }) => {
            const format = resolveFormat(options, "tools control sim");
            if (!format) {
                return;
            }
            try {
                const device = await resolveDevice({ udid: options.udid });
                await screenshot({ udid: device.udid, path: options.path });
                out.println(`${pc.green("wrote")} ${options.path}`);
            } catch (error) {
                fail(error);
            }
        });

    addFormatOption(sim.command("see"))
        .description("Read the screen as addressable, labelled elements")
        .option("--udid <udid>", "device udid or name")
        .option("--bundle-id <id>", "app under test; gives the observation its real pid")
        .option("--no-probe", "skip the hit-test grid (top-level accessibility elements only)")
        .option("--probe-step <points>", "grid spacing in device points (default 40)")
        .option("--max-points <n>", "hard cap on probe points (default 400)")
        .option("--out <file>", "also write the observation JSON here, for `sim act --snapshot-file`")
        .action(async (options: FormatOptions & SharedOptions & { out?: string }) => {
            const format = resolveFormat(options, "tools control sim see");
            if (!format) {
                return;
            }

            try {
                await requireIdb();
                const driver = new SimulatorControlDriver(driverOptions(options));
                const observation = await driver.observe({});
                if (options.out) {
                    await Bun.write(options.out, SafeJSON.stringify(observation, { strict: true }, 2));
                }
                if (format === "json") {
                    out.result(observation);
                    return;
                }
                renderCliHeader(
                    `${observation.window.title}`,
                    `${observation.elements.length} elements${observation.probe ? ` · ${observation.probe.points} probe points in ${observation.probe.elapsedMs}ms` : " · probe off"}`
                );
                printElements(observation);
                if (observation.probe?.truncated) {
                    out.log.warn("The probe grid was cut short; this element list is incomplete.");
                }
                renderCliSection("Next");
                out.println(suggestCommand("tools control sim", { replaceCommand: ["see", "--out", "screen.json"] }));
            } catch (error) {
                fail(error);
            }
        });

    addFormatOption(sim.command("act"))
        .description("Act on one element that a previous `see` observed, against a fresh read, with readback")
        .requiredOption("--snapshot-file <file>", "observation JSON from `sim see --out`")
        .requiredOption("--element <index>", "element index from that observation")
        .option("--action [action]", `one of ${ACTION_VALUES.join(", ")}`)
        .option("--text <text>", "value for --action type")
        .option("--keys <keys>", "key name(s) for --action key, e.g. return")
        .option("--direction <direction>", "up|down|left|right for --action scroll")
        .option("--pages <n>", "scroll distance in pages")
        .option("--pixels <n>", "scroll distance in device points")
        .option("--udid <udid>", "device udid or name")
        .option("--bundle-id <id>", "app under test")
        .option("--no-probe", "skip the hit-test grid on the reads this act performs")
        .option("--probe-step <points>", "grid spacing in device points")
        .option("--max-points <n>", "hard cap on probe points")
        .action(
            async (
                options: FormatOptions &
                    SharedOptions & {
                        snapshotFile: string;
                        element: string;
                        action?: string;
                        text?: string;
                        keys?: string;
                        direction?: string;
                        pages?: string;
                        pixels?: string;
                    }
            ) => {
                const format = resolveFormat(options, "tools control sim act");
                if (!format) {
                    return;
                }

                if (!options.action || !ACTION_VALUES.includes(options.action as ControlAction)) {
                    out.println(suggestEnumFlag("tools control sim act", "--action", ACTION_VALUES));
                    process.exitCode = 1;
                    return;
                }
                try {
                    await requireIdb();
                    const chosenFrom = observationSchema.parse(
                        SafeJSON.parse(await Bun.file(options.snapshotFile).text(), { strict: true })
                    );
                    const result = await actOnSimulator({
                        ...driverOptions(options),
                        chosenFrom,
                        element: Number(options.element),
                        action: options.action as ControlAction,
                        value: options.text,
                        parameters: {
                            ...(options.keys ? { keys: options.keys } : {}),
                            ...(options.direction
                                ? { direction: options.direction as "up" | "down" | "left" | "right" }
                                : {}),
                            ...(options.pages ? { pages: Number(options.pages) } : {}),
                            ...(options.pixels ? { pixels: Number(options.pixels) } : {}),
                        },
                    });
                    if (format === "json") {
                        out.result(result);
                        process.exitCode = result.ok ? 0 : 1;
                        return;
                    }
                    const label = result.chosen.identifier ?? result.chosen.label ?? result.chosen.role;
                    if (!result.ok) {
                        out.println(
                            `${pc.red("refused")} ${result.action} on ${pc.cyan(label)} — ${result.error ?? result.refusal}`
                        );
                        process.exitCode = 1;
                        return;
                    }
                    out.println(
                        `${pc.green("dispatched")} ${result.action} on ${pc.cyan(label)}${result.resolved.moved ? pc.yellow(" (element had moved; re-resolved)") : ""}`
                    );
                    out.log.info("`ok` means dispatched. The readback below is what actually happened.");
                    if (result.after) {
                        printElements(result.after);
                    } else {
                        out.log.warn("No readback: the screen could not be observed after the action.");
                    }
                } catch (error) {
                    fail(error);
                }
            }
        );
}
