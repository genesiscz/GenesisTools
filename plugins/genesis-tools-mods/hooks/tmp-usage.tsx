// The /tmp row: how much this session's scratch folder (`/tmp/cc/<project>/<session>`) holds and the free space on
// the system disk, every `mods.tmpUsage.minutes`. All of /tmp/cc is not measured: `du` over it took 75 s and 38 s of
// system CPU at 67 GB (2026-10-23), too much for a band. Each reading goes to `mods-log/tmp.jsonl`.
import type { ElementTable, RenderElement } from "claude-code";
import type { TmpReading, TmpUsage } from "../types";
import { type Feature, type Host, logMod, settingsOf } from "./shared";

let usage: TmpUsage = null;
const LOW_FREE_KB = 10 * 1024 * 1024;

async function kbOf(host: Host, argv: string[], column: number): Promise<number | null> {
    const done = await host.run(argv, { timeoutMs: 60_000 }).catch(() => undefined);
    const lines = done?.stdout.trim().split("\n") ?? [];
    const value = Number(lines[lines.length - 1]?.trim().split(/\s+/)[column]);

    return Number.isFinite(value) && lines.length > 0 ? value : null;
}

/** The main checkout's folder name, so every worktree of one repository shares its /tmp/cc project folder. */
async function projectOf(host: Host): Promise<string> {
    const cwd = await host.cwd();
    const done = await host
        .run(["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeoutMs: 5_000 })
        .catch(() => undefined);
    const common = done?.exitCode === 0 ? done.stdout.trim() : "";
    const main = common.endsWith("/.git") ? common.slice(0, -5) : cwd;

    return main.split("/").filter(Boolean).pop() ?? "unknown";
}

async function measure(host: Host): Promise<void> {
    const settings = (await settingsOf(host)).tmpUsage;

    if (!settings.enabled) {
        return;
    }

    // lint-rules-ignore: /tmp/cc/<project>/<session> is the agents' scratch folder by convention, not a temp file.
    const folder = `/tmp/cc/${await projectOf(host)}/${await host.sessionId()}`;
    const sessionKb = (await host.exists(folder)) ? await kbOf(host, ["du", "-sk", folder], 0) : 0;
    const reading: TmpReading = { at: Date.now(), sessionKb, freeKb: await kbOf(host, ["df", "-k", "/"], 3) };

    usage = reading;
    host.redraw();
    await logMod(host, "tmp", { folder, ...reading });
}

export const tmpUsage: Feature = {
    async start(host) {
        const settings = (await settingsOf(host)).tmpUsage;

        host.every(settings.minutes * 60_000, () => {
            void measure(host);
        });
        void measure(host);
    },
};

export function sizeText(kb: number | null): string {
    if (kb === null) {
        return "?";
    }

    if (kb < 1024) {
        return `${kb}K`;
    }

    if (kb < 1024 * 1024) {
        return `${Math.round(kb / 1024)}M`;
    }

    return `${(kb / 1024 / 1024).toFixed(1)}G`;
}

/** The band's /tmp row, or null while off or not measured yet. */
export async function tmpRow(host: Host, ui: ElementTable): Promise<RenderElement | null> {
    const held = usage;

    if (!held || !(await settingsOf(host)).tmpUsage.enabled) {
        return null;
    }

    const { Box, Text } = ui;
    const low = held.freeKb !== null && held.freeKb < LOW_FREE_KB;

    return (
        <Box key="tmp-band" flexDirection="row" gap={1}>
            <Text dimColor>{`tmp: session ${sizeText(held.sessionKb)} ·`}</Text>
            <Text color={low ? "red" : undefined} dimColor={!low} bold={low}>
                {`disk free ${sizeText(held.freeKb)}`}
            </Text>
        </Box>
    );
}
