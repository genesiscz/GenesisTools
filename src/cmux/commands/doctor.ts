import { probeSelfSend } from "@app/cmux/lib/send-self-preflight";
import { ui } from "@genesiscz/utils/cli/ui";
import { type CmuxHealth, type CmuxProbeResult, probeCmuxHealth } from "@genesiscz/utils/cmux/lib/health";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

interface DoctorFlags {
    json?: boolean;
}

export function registerDoctorCommand(parent: Command): void {
    parent
        .command("doctor")
        .description("Diagnose cmux health: socket vs UI-thread responsiveness, app CPU, rescue recipe. Read-only.")
        .option("--json", "Emit the raw health object")
        .action(async (flags: DoctorFlags) => {
            await runDoctor(flags);
        });
}

async function runDoctor(flags: DoctorFlags): Promise<void> {
    const health = await probeCmuxHealth({ full: true, identifyTimeoutMs: 5000 });
    // A green socket says nothing about whether THIS shell can type into its own
    // prompt: send-self failed for weeks while every line below it read ok.
    const selfSend = await probeSelfSend();

    if (flags.json) {
        out.result({ ...health, selfSend });
        setExitCode(health, selfSend.ok);
        return;
    }

    ui.header("cmux doctor");
    ui.kv("app", health.appPid ? `running (pid ${health.appPid}, ${health.appCpu ?? "?"}% CPU)` : "not running");
    ui.kv("ping", probeLine(health.probes.ping));
    if (health.probes.capabilities) {
        ui.kv("capabilities", probeLine(health.probes.capabilities));
    }

    ui.kv("identify", probeLine(health.probes.identify));
    ui.kv("send-self", selfSend.detail);

    switch (health.state) {
        case "healthy":
            ui.ok(`healthy — socket and UI thread both answer`);
            break;
        case "not-running":
            ui.warn(
                "cmux is not running. Start it from the Dock/Finder (NOT via `open` from an agent shell — see below)."
            );
            break;
        case "socket-dead":
            ui.err("the app is running but the socket does not answer. A restart of cmux is likely required.");
            break;
        case "ui-starved":
            ui.err(
                "UI-thread livelock signature: ping answers but identify starves" +
                    (health.appCpu !== undefined ? ` while the app burns ${health.appCpu}% CPU` : "") +
                    ". UI clicks and every state command are stuck."
            );
            ui.section("Rescue recipe");
            ui.raw("  1. tools cmux profiles save rescue --offline   # capture layout+commands without the socket");
            ui.raw("  2. kill -TERM <app pid>   # plain TERM works; wait, then kill -9 if it survives");
            ui.raw("  3. Relaunch with a CLEAN env — never `open -a cmux` from an agent shell:");
            ui.raw('     env -i HOME="$HOME" USER="$USER" PATH=/usr/bin:/bin:/usr/sbin:/sbin open -a cmux');
            ui.raw("     (`open` forwards its env; agent markers make resumed claudes disable transcript saving)");
            ui.raw("  4. tools cmux profiles restore rescue --enter   # review the drift diff it prints");
            break;
    }

    if (!selfSend.ok) {
        ui.warn(`send-self would not reach this prompt: ${selfSend.fix}`);
    }

    setExitCode(health, selfSend.ok);
}

function setExitCode(health: CmuxHealth, selfSendOk: boolean): void {
    if (health.state !== "healthy" || !selfSendOk) {
        process.exitCode = 1;
    }
}

function probeLine(probe: CmuxProbeResult): string {
    if (probe.ok) {
        return `ok (${probe.ms} ms)`;
    }

    return `FAIL (${probe.ms} ms${probe.detail ? ` — ${probe.detail}` : ""})`;
}
