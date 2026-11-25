import { readFileSync } from "node:fs";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { type MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import type { Command } from "commander";
import { z } from "zod";
import { planFindings } from "../lib/add-findings";
import { decisionsFileSchema, findingsFromDecisions, lineDecisionSchema } from "../lib/from-decisions";
import { OpenedMeeting } from "../lib/opened-meeting";
import { missingProjectWarning } from "../lib/project";
import { withMeetingsClient } from "../lib/service/client";
import { errorText, fail, unknownMeetingText } from "../lib/shared";
import { localMeetingTranscript } from "../lib/sources";
import { correctTranscript, outcomeText } from "../lib/transcript-corrections";

const { log } = logger.scoped("meetings-items");

function resolveMeeting(store: MeetingStore, ref: string): MeetingRecord | undefined {
    try {
        const record = store.resolve(ref);

        if (!record) {
            fail(unknownMeetingText(store, ref));
        }

        return record;
    } catch (err) {
        fail(err);
        return undefined;
    }
}

/**
 * `items from-decisions`: one decisions file (a speaker per transcript line) becomes the speaker-range and label
 * findings `items add --from-file` takes. `--plan` prints the plan `items add --plan` prints for them; without it
 * they are added through the decision journal, as `items add` adds them.
 */
async function fromDecisions(ref: string, opts: { file: string; plan?: boolean }): Promise<void> {
    const store = new MeetingStore();
    const record = resolveMeeting(store, ref);

    if (!record) {
        return;
    }

    let raw: unknown;

    try {
        raw = SafeJSON.parse(readFileSync(opts.file, "utf8"), { strict: true });
    } catch (err) {
        fail(new Error(`--file ${opts.file}: ${errorText(err)}`, { cause: err }));
        return;
    }

    const parsed = decisionsFileSchema.safeParse(raw);

    if (!parsed.success) {
        // The union's own message says only "Invalid input"; the entries' schema names the field.
        const entries = Array.isArray(raw) ? raw : [raw];
        const issue = z.array(lineDecisionSchema).safeParse(entries).error?.issues[0] ?? parsed.error.issues[0];
        const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
        fail(
            `Not a decision${where}: ${issue?.message ?? "invalid"}. Each entry is { idx, speaker (a name or "?"), confidence, reason }.`
        );
        return;
    }

    try {
        const config = await new MeetingsConfigStore().read();

        if (opts.plan) {
            // Local only, as `items add --plan` reads it.
            const transcript = await localMeetingTranscript(record, store);
            const findings = findingsFromDecisions({ record, transcript }, parsed.data);
            out.result(planFindings({ findings, record, transcript, config }));
            return;
        }

        const transcript = (await OpenedMeeting.of(store, record).meeting()).transcript;
        const findings = findingsFromDecisions({ record, transcript }, parsed.data);

        if (findings.length === 0) {
            ui.info(`Nothing to add to ${record.id}: every decided line already has its label's person.`);
            return;
        }

        const projectWarning = missingProjectWarning(record, config);

        if (projectWarning) {
            ui.warn(projectWarning);
        }

        // Through the decision journal, as `items add`: the history says who suggested them and an Undo removes them.
        const decided = await withMeetingsClient((client) =>
            client.call("decision.apply", { meeting: record.id, action: { kind: "add", findings } })
        );
        const added = (decided.entry?.changes ?? []).flatMap((change) => (change.after ? [change.after] : []));
        log.debug(
            { meeting: record.id, decisions: parsed.data.length, findings: findings.length, added: added.length },
            "decisions added"
        );

        for (const warning of decided.warnings ?? []) {
            ui.warn(warning);
        }

        const ids = added.map((item) => item.id);
        const result = correctTranscript({
            record: store.read(record.id) ?? record,
            transcript,
            config,
            format: "txt",
            dictionary: false,
            include: ids,
        });

        for (const outcome of result.outcomes.filter((outcome) => ids.includes(outcome.item))) {
            const text = outcomeText(outcome);

            if (text) {
                ui.warn(text);
            }
        }

        if (added.length === 0) {
            ui.info(`No new items in ${record.id}.`);
            return;
        }

        ui.ok(
            `${added.length} items from ${parsed.data.length} decisions added to ${record.id} (${added[0]?.id} to ${added.at(-1)?.id}).`
        );
    } catch (err) {
        fail(err);
    }
}

export function registerFromDecisions(items: Command): void {
    items
        .command("from-decisions")
        .argument("<meeting>", "meeting id, a unique prefix, last, or wisprflow:<id>")
        .description(
            `Turn per-line speaker decisions into speaker-range and label findings, and add them as ${toolCommand("meetings", "items", "add")} does`
        )
        .requiredOption(
            "--file <decisions.json>",
            'an array of { idx, speaker, confidence, reason }: idx is the transcript line index evidence prints, speaker the full name or the legend initial of a person, or "?" when the label tracks no one person there'
        )
        .option(
            "--plan",
            `print the plan ${toolCommand("meetings", "items", "add", "--plan")} prints for the findings; write nothing`
        )
        .action(fromDecisions);
}
