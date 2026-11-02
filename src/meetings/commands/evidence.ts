import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { formatBytes } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { createBoxTable } from "@genesiscz/utils/table";
import { labelIdentityTable, lineEvidence, SELF } from "@genesiscz/utils/transcribe/evidence";
import { sameName } from "@genesiscz/utils/transcribe/speakers";
import type { Command } from "commander";
import pc from "picocolors";
import { energyMicShareFor } from "../lib/energy";
import { speakingEvidence } from "../lib/platforms";
import { presenceFor } from "../lib/presence";
import { errorText, fail, resolveEnum, TOOL } from "../lib/shared";
import { meetingSource } from "../lib/sources";

const FORMATS = ["table", "json"] as const;
/** The user's microphone recognized this many times more words than their own label holds: they are spread over others. */
const VOLUME_RATIO = 2;

async function evidence(
    ref: string,
    opts: { attendance?: string; format?: string | boolean; files?: boolean }
): Promise<void> {
    const format = await resolveEnum({
        value: opts.format,
        fallback: "table",
        values: FORMATS,
        flag: "--format",
        subcommand: ["evidence"],
    });
    const store = new MeetingStore();

    if (!format) {
        return;
    }

    try {
        const record = store.resolve(ref);

        if (!record) {
            fail(`No meeting "${ref}". List them: ${TOOL} list`);
            return;
        }

        const [sourceId, block] =
            Object.entries(record.sources).find(([, value]) => typeof value.meetingId === "string") ?? [];

        if (!sourceId || typeof block?.meetingId !== "string") {
            fail(`${record.id} has no linked source. Link one: ${TOOL} link ${record.id} wisprflow:<id>`);
            return;
        }

        const source = await meetingSource(sourceId);
        const meeting = await source.load(block.meetingId);
        const found = speakingEvidence(record, await source.evidence(block.meetingId));

        if (!found) {
            fail(`${source.label} keeps no speaker evidence for this meeting on this Mac.`);
            return;
        }

        const presence = await presenceFor(record, meeting, opts.attendance);
        const energy = await energyMicShareFor(store, record, found);
        const lines = lineEvidence(meeting.transcript, found, presence, energy.share);
        const selfLabelWords = meeting.transcript
            .filter((entry) => found.selfName && sameName(entry.speaker, found.selfName))
            .reduce((sum, entry) => sum + entry.text.split(/\s+/).filter(Boolean).length, 0);
        const volume = found.tokens
            ? {
                  micTokens: found.tokens.mic,
                  selfLabelWords,
                  spread: found.tokens.mic >= VOLUME_RATIO * Math.max(1, selfLabelWords),
              }
            : undefined;

        if (format === "json") {
            out.result(
                SafeJSON.stringify(
                    {
                        meeting: record.id,
                        selfName: found.selfName,
                        volume,
                        channels: energy.calibration ?? null,
                        files: found.files,
                        devices: found.devices,
                        lines,
                    },
                    null,
                    2
                )
            );
            return;
        }

        const table = labelIdentityTable(lines);
        const identities = [...new Set([...table.values()].flatMap((row) => [...row.keys()]))].sort((a, b) =>
            a === SELF ? -1 : b === SELF ? 1 : a.localeCompare(b)
        );
        const view = createBoxTable([
            "LABEL \\ VOICE",
            ...identities.map((name) => (name === SELF ? `you (${found.selfName ?? "mic"})` : name)),
        ]);

        for (const [label, row] of table) {
            view.push([pc.white(label), ...identities.map((name) => String(row.get(name) ?? ""))]);
        }

        out.println(view.toString());
        ui.dim(
            `${lines.length} lines · ${found.segments.length} channel segments · ${found.speaking.length} speaking readings · ${lines.filter((line) => line.tie).length} ties (two voices equal) · "?" = no channel segment overlaps the line`
        );

        const channels = energy.calibration;

        if (!channels) {
            ui.dim("audio energy: not checked (no audio on this Mac, or ffmpeg is missing)");
        } else if (channels.layout === "unknown") {
            ui.warn(`audio energy: not used, the microphone channel is unknown: ${channels.reason}`);
        } else {
            ui.dim(
                `audio energy: ${channels.layout} (mic segments median left share ${channels.micMedian}, call ${channels.systemMedian}; ${channels.segments.mic} + ${channels.segments.system} segments)`
            );
        }

        if (volume) {
            const say = `your microphone recognized ${volume.micTokens} words; your label "${found.selfName}" holds ${volume.selfLabelWords}`;
            volume.spread
                ? ui.warn(
                      `${say}: you are spread over other labels (${toolCommand("meetings", "suggest", record.id, "--rules", "evidence")})`
                  )
                : ui.dim(say);
        }

        if (opts.files) {
            for (const file of found.files) {
                ui.dim(`  ${file.name} ${formatBytes(file.bytes)}`);
            }
        }
    } catch (err) {
        fail(errorText(err));
    }
}

export function registerEvidenceCommand(program: Command): void {
    program
        .command("evidence")
        .argument("<meeting>", "meeting id, a unique prefix, last, or wisprflow:<id>")
        .description("Which voice each label's lines are, by audio channel and the platform's speaking indicator")
        .option("--attendance <teams|file>", "who was in the call and when (Teams)")
        .option("--files", "also list the evidence files and their sizes")
        .option("--format [format]", "table | json (json has one row per line)")
        .action(evidence);
}
