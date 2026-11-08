import { logger } from "@genesiscz/utils/logger";
import { languageSettings } from "@genesiscz/utils/meetings/config";
import type { MeetingItem, MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { isEnglishWord } from "@genesiscz/utils/transcribe/terms";
import { contextFileText, contextMoment } from "./context-file";
import { OpenedMeeting } from "./opened-meeting";
import { type SuggestRule, settledTermItems, suggestItems } from "./suggest";
import type { WordCheckChoice } from "./word-check";

/**
 * Runs the rules on a meeting's transcript and adds what they find as suggested items, in one save: the CLI's
 * `suggest` and the REPL's meeting.suggest(). The platform, attendance and channel layout are collected first when the
 * record lacks them. A word check that cannot run is a warning, not a failure: the term rules then skip every word
 * with a Czech letter.
 */
export async function runSuggest(options: {
    store: MeetingStore;
    record: MeetingRecord;
    rules: SuggestRule[];
    attendance?: string;
    wordCheck?: WordCheckChoice;
}): Promise<{ fresh: MeetingItem[]; retired: string[]; warnings: string[] }> {
    const { store, record, rules } = options;
    const warnings: string[] = [];
    const opened = OpenedMeeting.of(store, record);
    const collected = await opened.collectWhenIncomplete();
    const meeting = await opened.meeting();
    const config = await opened.config();
    const evidence = rules.includes("evidence") ? await opened.evidence() : null;

    if (rules.includes("terms")) {
        warnings.push(...contextWarnings(collected));
    }
    let wordCheck: Awaited<ReturnType<OpenedMeeting["wordCheck"]>>["check"];

    if (rules.includes("terms")) {
        const check = await opened.wordCheck(options.wordCheck);

        if (!check.check && options.wordCheck !== "off") {
            warnings.push(
                `The word check is off (${check.reason}); the term rules skip every word with a Czech letter.`
            );
        }

        wordCheck = check.check;
    }

    const inputs: Parameters<typeof suggestItems>[0] = {
        record: collected,
        meeting,
        rules,
        dictionary: await opened.dictionary(),
        sourceWords: await opened.sourceWords(),
        presence: await opened.presence(options.attendance),
        evidence,
        energyMicShare: (await opened.energy()).share,
        listenBelow: config.global.suggest.listenBelow,
        questionBudget: config.global.suggest.questionCap,
        minPriority: config.global.playback.listen.minPriority,
        points: await opened.summaryPoints(),
        wordCheck,
        sourceLabels: languageSettings(config).render,
        restatedIdentifiers: config.global.suggest.restatedIdentifiers,
        now: new Date().toISOString(),
    };
    let fresh: MeetingItem[] = [];
    let retired: string[] = [];
    const known = (word: string) =>
        isEnglishWord(word) || (wordCheck !== undefined && wordCheck.verdict(word).class !== "unknown");

    try {
        await store.update(record.id, { command: "suggest", change: "suggest findings and questions" }, (current) => {
            // What the dictionary or the slang rule settles now is retired first, so its questions free the budget.
            const settled = rules.includes("terms")
                ? settledTermItems({ record: current, dictionary: inputs.dictionary, known })
                : new Map<string, string>();

            for (const item of current.items) {
                const reason = settled.get(item.id);

                if (reason) {
                    item.status = "rejected";
                    item.decidedAt = inputs.now;
                    item.evidence = { ...item.evidence, retired: reason };
                }
            }

            retired = [...settled.keys()];
            fresh = suggestItems({ ...inputs, record: current });
            current.items.push(...fresh);
        });
    } finally {
        wordCheck?.dispose();
    }

    return { fresh, retired, warnings };
}

/** What the term rules cannot read as the meeting saw it: a context file that is gone, or changed with no commit. */
export function contextWarnings(record: MeetingRecord): string[] {
    return record.context.flatMap((entry) => {
        if (entry.kind !== "file") {
            return [];
        }

        const file = contextFileText(entry.ref, contextMoment(record));

        if (!file) {
            return [
                `The context file ${entry.ref} is gone and no git commit holds it; its quotes and identifiers are not checked`,
            ];
        }

        if (file.from === "git") {
            logger.debug(
                { ref: entry.ref, commit: file.commit },
                "meetings: context file read at its commit before the meeting"
            );
        }

        return file.warning ? [file.warning] : [];
    });
}
