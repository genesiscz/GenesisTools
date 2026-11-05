import { resolve, sep } from "node:path";
import type { SnapInput, SnapReceiptDto } from "@app/dev-dashboard/contract/snap";
import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/alias-list";
import { logger } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";

/**
 * Snap it to the agent (F24): a photo the phone uploaded goes onto the widget file shelf as a capture and into the
 * chosen session's draft, the same path a Mac screenshot takes (`stageShelfImage`, then `attachShelfItem`). Only a
 * file under the upload folder is accepted, so the route cannot attach an arbitrary file of the Mac.
 */

export interface SnapDeps {
    uploadRoot?: string;
    sourceHome?: (input: { provider: string; sessionId: string }) => Promise<string | null>;
    stage?: (input: { input: string; name?: string }) => Promise<{ id: string }>;
    attach?: (input: { id: string; key: string }) => Promise<{ added: boolean }>;
}

async function liveSourceHome(input: { provider: string; sessionId: string }): Promise<string | null> {
    const { openHistoryReadOnly } = await import("@genesiscz/utils/agent-sessions/database");
    const { HistoryRepository } = await import("@genesiscz/utils/agent-sessions/repository");
    const { resolveProviderAlias } = await import("@genesiscz/utils/ai/providers/aliases");
    const db = openHistoryReadOnly();

    if (!db) {
        return null;
    }

    try {
        const matches = new HistoryRepository(db).listMetadata({
            providerId: resolveProviderAlias(input.provider),
            sessionId: input.sessionId,
            withUserText: false,
            limit: 2,
        });
        return matches.length === 1 ? (matches[0].sourceHome ?? "") : null;
    } finally {
        db.close();
    }
}

async function liveStage(input: { input: string; name?: string }): Promise<{ id: string }> {
    const { stageShelfImage } = await import("../widget/shelf");
    return stageShelfImage(input);
}

async function liveAttach(input: { id: string; key: string }): Promise<{ added: boolean }> {
    const { attachShelfItem } = await import("../widget/shelf");
    return attachShelfItem(input);
}

function under(root: string, path: string): boolean {
    const base = resolve(root);
    const target = resolve(path);
    return target.startsWith(`${base}${sep}`);
}

export async function snapToSession(input: SnapInput, deps: SnapDeps = {}): Promise<SnapReceiptDto> {
    const refused = (error: string): SnapReceiptDto => ({ attached: false, draftKey: null, shelfId: null, error });
    const root = deps.uploadRoot ?? toolDataDir("dev-dashboard", "uploads");

    if (!under(root, input.path)) {
        return refused("Only a photo the upload route stored can be attached.");
    }

    const provider = ACCOUNT_PROVIDER_ALIASES.find((alias) => alias === input.provider);

    if (!provider) {
        return refused(`Unknown provider ${input.provider}.`);
    }

    let sourceHome = input.sourceHome;

    if (sourceHome === undefined) {
        try {
            sourceHome =
                (await (deps.sourceHome ?? liveSourceHome)({ provider, sessionId: input.sessionId })) ?? undefined;
        } catch (error) {
            logger.warn({ error, provider, sessionId: input.sessionId }, "snap: source home lookup failed");
        }

        if (sourceHome === undefined) {
            logger.warn(
                { provider, sessionId: input.sessionId },
                "snap: no unique indexed session; using an empty source home"
            );
        }
    }

    const { widgetSessionKey } = await import("../widget/types");
    const key = widgetSessionKey({
        hostId: "local",
        provider,
        sessionId: input.sessionId,
        sourceHome: sourceHome ?? "",
        cwd: "",
    });

    try {
        const item = await (deps.stage ?? liveStage)({ input: input.path, name: input.name });
        await (deps.attach ?? liveAttach)({ id: item.id, key });
        logger.info({ key, shelfId: item.id }, "snap: a phone photo went onto the shelf and into a draft");
        return { attached: true, draftKey: key, shelfId: item.id, error: null };
    } catch (error) {
        logger.warn({ error, key }, "snap: could not attach the photo");
        return refused(error instanceof Error ? error.message : String(error));
    }
}
