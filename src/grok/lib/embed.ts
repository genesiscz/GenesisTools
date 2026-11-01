import type { EmbedLauncher } from "@app/ai/lib/embed/types";

export const grokEmbed: EmbedLauncher = {
    alias: "grok",
    hostProtocol: "acp",
    async run() {
        throw new Error("tools grok embed is not implemented yet");
    },
};
