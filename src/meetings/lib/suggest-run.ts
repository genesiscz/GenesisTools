import { languageSettings } from "@genesiscz/utils/meetings/config";
import type { MeetingItem, MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { OpenedMeeting } from "./opened-meeting";
import { type SuggestRule, suggestItems } from "./suggest";
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
}): Promise<{ fresh: MeetingItem[]; warnings: string[] }> {
    const { store, record, rules } = options;
    const warnings: string[] = [];
    const opened = OpenedMeeting.of(store, record);
    const collected = await opened.collectWhenIncomplete();
    const meeting = await opened.meeting();
    const config = await opened.config();
    const evidence = rules.includes("evidence") ? await opened.evidence() : null;
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
        now: new Date().toISOString(),
    };
    let fresh: MeetingItem[] = [];

    try {
        await store.update(record.id, { command: "suggest", change: "suggest findings and questions" }, (current) => {
            fresh = suggestItems({ ...inputs, record: current });
            current.items.push(...fresh);
        });
    } finally {
        wordCheck?.dispose();
    }

    return { fresh, warnings };
}
