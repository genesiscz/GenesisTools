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
    stage?: (input: { input: string; name?: string }) => Promise<{ id: string }>;
    attach?: (input: { id: string; key: string }) => Promise<{ added: boolean }>;
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

    const { widgetSessionKey } = await import("../widget/types");
    const key = widgetSessionKey({
        hostId: "local",
        provider,
        sessionId: input.sessionId,
        sourceHome: input.sourceHome ?? "",
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
