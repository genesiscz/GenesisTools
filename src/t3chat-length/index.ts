/**
 * This tool is internal and probably not useful to you.
 */

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
    contentSizeKB: number;
}

function processMessages(input: InputJson): OutputMessageInfo[] {
    const messages = input.json.messages;

    const messageInfo = messages.map((message) => {
        const contentSizeBytes = new TextEncoder().encode(message.content).length;
        const contentSizeKB = contentSizeBytes / 1024;
        const threadLink = `https://t3.chat/chat/${message.threadId}`;

        return {
            threadLink,
            contentSizeKB,
        };
    });

    messageInfo.sort((a, b) => b.contentSizeKB - a.contentSizeKB);

    return messageInfo;
}

// https://t3.chat/api/trpc/syncData
const myInputJson: InputJson = {
    json: {
    },
};

const processedInfo = processMessages(myInputJson);
console.log(processedInfo);
