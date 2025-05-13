/**
 * This tool is internal and probably not useful to you.
 */

import logger from "../logger";

interface Message {
    content: string;
    threadId: string;
}

interface InputJson {
    json: {
        messages: Message[];
    };
}

interface OutputMessageInfo {
    threadLink: string;
    contentSizeKB: number; // This will represent the total content size for the thread
}

function processMessages(input: InputJson): OutputMessageInfo[] {
    const messages = input.json.messages;
    const threadTotals = new Map<string, number>();

    // Group by threadId and sum contentSizeKB
    messages.forEach((message) => {
        const contentSizeBytes = new TextEncoder().encode(message.content).length;
        const contentSizeKB = contentSizeBytes / 1024;
        const currentTotal = threadTotals.get(message.threadId) || 0;
        threadTotals.set(message.threadId, currentTotal + contentSizeKB);
    });

    // Convert map to array of OutputMessageInfo
    const aggregatedMessages: OutputMessageInfo[] = [];
    for (const [threadId, totalSizeKB] of threadTotals.entries()) {
        const threadLink = `https://t3.chat/chat/${threadId}`;
        aggregatedMessages.push({
            threadLink,
            contentSizeKB: totalSizeKB,
        });
    }

    // Sort by contentSizeKB descending
    aggregatedMessages.sort((a, b) => b.contentSizeKB - a.contentSizeKB);

    return aggregatedMessages;
}

// https://t3.chat/api/trpc/syncData
const myInputJson: InputJson = {
    json: {
        messages: []
    },
};

const processedInfo = processMessages(myInputJson);
logger.info(processedInfo);
