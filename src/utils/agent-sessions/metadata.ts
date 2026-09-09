import type { BoundedMetadataField, HistoryMetadataRecord } from "./types";

export const HISTORY_METADATA_LIMITS = {
    customTitleBytes: 4_096,
    summaryBytes: 16_384,
    firstPromptBytes: 16_384,
    allUserTextCollectedChars: 5_000,
    allUserTextBytes: 20_000,
} as const;

export function boundHistoryText(options: { value: string | null; limitBytes: number }): {
    value: string | null;
    bounded: boolean;
} {
    if (options.value === null || Buffer.byteLength(options.value, "utf8") <= options.limitBytes) {
        return { value: options.value, bounded: false };
    }

    let bytes = 0;
    let value = "";
    for (const character of options.value) {
        const width = Buffer.byteLength(character, "utf8");
        if (bytes + width > options.limitBytes) {
            break;
        }
        value += character;
        bytes += width;
    }

    return { value, bounded: true };
}

export function boundHistoryMetadata(metadata: HistoryMetadataRecord): HistoryMetadataRecord {
    const customTitle = boundHistoryText({
        value: metadata.customTitle,
        limitBytes: HISTORY_METADATA_LIMITS.customTitleBytes,
    });
    const summary = boundHistoryText({
        value: metadata.summary,
        limitBytes: HISTORY_METADATA_LIMITS.summaryBytes,
    });
    const firstPrompt = boundHistoryText({
        value: metadata.firstPrompt,
        limitBytes: HISTORY_METADATA_LIMITS.firstPromptBytes,
    });
    const allUserText = boundHistoryText({
        value: metadata.allUserText,
        limitBytes: HISTORY_METADATA_LIMITS.allUserTextBytes,
    });
    const boundedFields = [...new Set(metadata.boundedFields)];
    const storageTruncatedFields = [
        ...new Set(
            metadata.storageTruncatedFields ??
                metadata.boundedFields.filter((field) => field !== "firstTimestamp" && field !== "lastTimestamp")
        ),
    ];

    function add(field: BoundedMetadataField, bounded: boolean): void {
        if (bounded && !boundedFields.includes(field)) {
            boundedFields.push(field);
        }
        if (bounded && !storageTruncatedFields.includes(field)) {
            storageTruncatedFields.push(field);
        }
    }

    add("customTitle", customTitle.bounded);
    add("summary", summary.bounded);
    add("firstPrompt", firstPrompt.bounded);
    add("allUserText", allUserText.bounded);

    return {
        ...metadata,
        customTitle: customTitle.value,
        summary: summary.value,
        firstPrompt: firstPrompt.value,
        allUserText: allUserText.value,
        boundedFields,
        storageTruncatedFields,
    };
}
