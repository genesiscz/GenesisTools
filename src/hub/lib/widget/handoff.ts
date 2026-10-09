import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveTranscript, transcriptEnvelope } from "@genesiscz/utils/ai/transcripts";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { serializeWidgetMedia } from "../composer/serialize";
import { composeHandoff } from "../insights/handoff";
import { type WidgetSources, widgetSnapshot } from "./snapshot";
import { widgetRoot } from "./storage";
import { type WidgetAsset, widgetSessionKey } from "./types";

async function handoffMedia(asset: WidgetAsset): Promise<string> {
    if (asset.type === "video" && asset.status !== "ready") {
        return `Original video (preparation incomplete): ${asset.path}`;
    }

    return serializeWidgetMedia([asset]);
}

export async function createWidgetHandoff({
    root,
    key,
    sources,
}: {
    root?: string;
    key: string;
    sources?: WidgetSources;
}) {
    const snapshot = await widgetSnapshot({ root, selectedKey: key, sources });
    const session = snapshot.sessions.find((entry) => entry.key === key);
    if (!session) {
        throw new Error("This session is no longer available; choose a destination in Hub.");
    }
    const paragraphs = [
        `# Continue: ${session.title}`,
        `Source session: ${session.target.provider} / ${session.target.sessionId}`,
        `Working directory: ${session.target.cwd}`,
        "This is a separate handoff draft. It has not been sent to an agent.",
    ];
    if (session.transcriptPath && session.target.provider !== "unknown") {
        if (existsSync(session.transcriptPath) && statSync(session.transcriptPath).size <= 8 * 1024 * 1024) {
            try {
                const resolved = await resolveTranscript(session.transcriptPath, {}, session.target.provider);
                const envelope = await transcriptEnvelope(resolved, { limit: 40 });
                paragraphs.push(
                    composeHandoff({
                        turns: envelope.turns,
                        range: { last: 5 },
                        meta: {
                            sessionId: session.target.sessionId,
                            provider: resolved.provider,
                            title: session.title,
                            cwd: session.target.cwd,
                        },
                    }).markdown
                );
            } catch (error) {
                logger.warn(
                    { error, path: session.transcriptPath },
                    "Handoff transcript summary unavailable; the draft keeps the transcript path"
                );
            }
        }

        paragraphs.push(`Original transcript: ${session.transcriptPath}`);
    }
    for (const card of snapshot.cards.slice(-12)) {
        paragraphs.push(`## ${card.kind}: ${card.title}`, `State: ${card.status}`, card.body);
        for (const image of card.attachments) {
            paragraphs.push(`Image: ${image.path}`);
        }
    }
    for (const message of snapshot.state.outgoing
        .filter((message) => widgetSessionKey(message.target) === key && message.state !== "cancelled")
        .slice(-20)) {
        paragraphs.push(`## Outgoing message · ${message.state}`);
        paragraphs.push(
            message.payload.kind === "form"
                ? [message.payload.text, SafeJSON.stringify(message.payload.answers, null, 2)]
                      .filter(Boolean)
                      .join("\n\n")
                : message.payload.text
        );
        if (message.state === "unknown") {
            paragraphs.push("Delivery is uncertain. Check the source conversation before repeating this message.");
        }
        for (const id of message.assetIds) {
            const asset = snapshot.state.assets[id];
            if (!asset) {
                continue;
            }
            paragraphs.push(await handoffMedia(asset));
        }
    }
    const draft = snapshot.state.drafts[key];
    if (draft?.text) {
        paragraphs.push("## User's unsent draft", draft.text);
    }
    const assets = (draft?.assetIds ?? [])
        .map((id) => snapshot.state.assets[id])
        .filter((asset) => asset !== undefined);
    for (const asset of assets) {
        paragraphs.push(await handoffMedia(asset));
    }
    const folder = join(widgetRoot(root), "handoffs");
    await mkdir(folder, { recursive: true });
    const file = join(folder, `${randomUUID()}.md`);
    await writeFile(file, `${paragraphs.filter(Boolean).join("\n\n")}\n`, { flag: "wx", mode: 0o600 });
    logger.info({ file, key, cards: snapshot.cards.length }, "Widget handoff draft created");
    return { path: file, title: session.title, cwd: session.target.cwd, sent: false };
}
