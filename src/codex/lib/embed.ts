import type { EmbedLauncher } from "@app/ai/lib/embed/types";

export const codexEmbed: EmbedLauncher = {
    alias: "codex",
    hostProtocol: "codex-app-server",
    async run() {
        throw new Error("tools codex embed is not implemented yet");
    },
};
