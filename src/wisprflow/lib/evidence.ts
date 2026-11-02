import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { MeetingEvidence } from "@genesiscz/utils/meetings/sources";
import type { EvidenceSegment, SpeakingObservation } from "@genesiscz/utils/transcribe/evidence";
import { z } from "zod";
import { parseLive } from "./live";
import { WISPR_DIR } from "./local";

const { log } = logger.scoped("wisprflow-evidence");

/**
 * Teams adds status text to a participant's name ("Bob Example External unfamiliar left the meeting"); the person is the
 * name before it.
 */
export function participantName(raw: string): string {
    return raw.replace(/(?:\s+External)?(?:\s+unfamiliar)?(?:\s+left the meeting)?\s*$/i, "").trim();
}

const observationLine = z.union([
    z.object({ participant: z.object({ pid: z.string(), name: z.string(), self: z.boolean().optional() }) }),
    z.object({
        obs: z.object({
            tMs: z.number(),
            speaking: z.array(z.string()).nullish(),
            muted: z.array(z.string()).nullish(),
        }),
    }),
    z.object({ meta: z.unknown() }),
]);

/**
 * `speakers.observations.ndjson`: Teams' speaking indicator about every 5 s. A failed read has no `speaking`. Teams
 * names the user by email; with `selfName` the user is called that instead.
 */
export function parseObservations(raw: string, selfName?: string): SpeakingObservation[] {
    const names = new Map<string, string>();
    const observations: SpeakingObservation[] = [];

    for (const row of raw.split("\n")) {
        if (!row.trim()) {
            continue;
        }

        const parsed = observationLine.safeParse(SafeJSON.parse(row, { strict: true }));

        if (!parsed.success) {
            continue;
        }

        const line = parsed.data;

        if ("participant" in line) {
            const name = line.participant.self && selfName ? selfName : participantName(line.participant.name);
            names.set(line.participant.pid, name);
        } else if ("obs" in line && line.obs.speaking) {
            const named = (pids: string[]) => pids.map((pid) => names.get(pid) ?? pid);
            observations.push({
                tSec: line.obs.tMs / 1000,
                speaking: named(line.obs.speaking),
                muted: named(line.obs.muted ?? []),
            });
        }
    }

    return observations.sort((a, b) => a.tSec - b.tSec);
}

const tokensSchema = z.object({
    mic: z.object({ total_tokens: z.number() }),
    system: z.object({ total_tokens: z.number() }),
});

function readJson(path: string): unknown {
    return existsSync(path) ? SafeJSON.parse(readFileSync(path, "utf8")) : undefined;
}

/**
 * The raw evidence in the app's meeting folder: the channel of every live segment (\`live.ndjson\`, on the same
 * recording clock as the refined transcript), Teams' speaking indicator, the token count per channel and the audio
 * setup. Read-only; a missing file leaves its part empty.
 */
export function readEvidence(meetingId: string, selfName: string | undefined): MeetingEvidence {
    const folder = join(WISPR_DIR, "meetings", meetingId);
    const files = existsSync(folder)
        ? readdirSync(folder).map((name) => ({ name, bytes: statSync(join(folder, name)).size }))
        : [];
    const livePath = join(folder, "live.ndjson");
    const segments: EvidenceSegment[] = existsSync(livePath)
        ? parseLive(readFileSync(livePath, "utf8")).flatMap((line) => {
              const source = line.speaker?.source;

              if ((source !== "mic" && source !== "system") || line.endRecordingMs === undefined) {
                  return [];
              }

              return [
                  {
                      startSec: line.startRecordingMs! / 1000,
                      endSec: line.endRecordingMs / 1000,
                      channel: source,
                      ...(line.text?.trim() ? { text: line.text.trim() } : {}),
                      ...(line.speaker?.id !== undefined ? { voiceId: line.speaker.id } : {}),
                      ...(source === "system" && line.speaker?.name
                          ? { liveName: participantName(line.speaker.name) }
                          : {}),
                  },
              ];
          })
        : [];
    const observationsPath = join(folder, "speakers.observations.ndjson");
    const speaking = existsSync(observationsPath)
        ? parseObservations(readFileSync(observationsPath, "utf8"), selfName)
        : [];
    const tokens = tokensSchema.safeParse(readJson(join(folder, "native-language-evidence.json")));
    const devices = z.record(z.string(), z.unknown()).safeParse(readJson(join(folder, "audio-devices.json")));
    log.debug(
        { meetingId, segments: segments.length, observations: speaking.length, files: files.length },
        "evidence read"
    );

    return {
        ...(selfName ? { selfName } : {}),
        segments,
        speaking,
        ...(tokens.success
            ? { tokens: { mic: tokens.data.mic.total_tokens, system: tokens.data.system.total_tokens } }
            : {}),
        ...(devices.success ? { devices: devices.data } : {}),
        ...(existsSync(join(folder, "upload.ogg")) ? { audioPath: join(folder, "upload.ogg") } : {}),
        files,
    };
}
