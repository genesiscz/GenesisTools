import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { LIVE_STT_MODELS } from "@genesiscz/utils/ai/stt/models";
import { logger } from "@genesiscz/utils/logger";

export async function voiceConfiguration({
    readStore = AiConfigStore.readOnly,
}: {
    readStore?: () => Promise<Pick<AiConfigStore, "accounts">>;
} = {}) {
    const store = await readStore();
    const accounts = store.accounts({ enabled: true });
    const providers = Object.entries(LIVE_STT_MODELS).map(([id, model]) => ({
        id,
        title: { xai: "xAI", openai: "OpenAI", deepgram: "Deepgram", elevenlabs: "ElevenLabs" }[id] ?? id,
        defaultModel: model,
        models: [model],
        accounts: accounts
            .filter((account) => account.provider === id)
            .map((account) => ({ id: account.id, name: account.label || account.name })),
    }));
    logger.debug(
        {
            providers: providers.length,
            accounts: providers.reduce((sum, provider) => sum + provider.accounts.length, 0),
        },
        "Read voice configuration metadata"
    );
    return { providers };
}
