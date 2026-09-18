import { logger } from "@genesiscz/utils/logger";
import { createFixtureStt } from "./fixture";
import { type LiveSttSession, type OpenLiveSttOptions, STT_PROVIDER_IDS, type SttProviderId } from "./types";

const { log } = logger.scoped("ai-stt");

export function parseSttProvider(value: unknown): SttProviderId {
    if (typeof value === "string" && (STT_PROVIDER_IDS as readonly string[]).includes(value)) {
        return value as SttProviderId;
    }

    throw new Error(`Unknown STT provider '${String(value)}'. Valid: ${STT_PROVIDER_IDS.join("|")}`);
}

export async function openLiveStt(options: OpenLiveSttOptions): Promise<LiveSttSession> {
    const provider = parseSttProvider(options.provider);
    log.debug({ provider, accountId: options.accountId, model: options.model }, "Opening live STT session");
    options.signal?.throwIfAborted();

    if (provider === "fixture") {
        return createFixtureStt({
            events: options.events ?? [],
            accountId: options.accountId,
            signal: options.signal,
        });
    }

    throw new Error(
        `Live STT provider '${provider}' needs a bound ${provider} account. ` +
            `Configure one with: tools ai config default set transcribe @account/<id> ` +
            `or pass --transcript for the fixture path.`
    );
}
