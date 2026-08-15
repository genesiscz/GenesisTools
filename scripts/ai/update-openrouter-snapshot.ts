/**
 * Refresh the committed OpenRouter model snapshot.
 *
 * The snapshot is what prices an OpenRouter call on a machine that has never
 * reached the network, and what keeps `bun test` hermetic. It is pruned to the
 * fields `catalog/openrouter.ts` reads, which is also what keeps it around
 * 200 KB instead of the feed's 650 KB.
 *
 * Run deliberately, not on a schedule: a diff in this file is a price change and
 * deserves to be read.
 *
 * Usage: bun scripts/ai/update-openrouter-snapshot.ts
 */

import { SafeJSON } from "@genesiscz/utils/json";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const TARGET = new URL("../../src/utils/ai/catalog/data/openrouter-snapshot.json", import.meta.url);

interface FeedModel {
    id?: unknown;
    name?: unknown;
    context_length?: unknown;
    pricing?: unknown;
    architecture?: unknown;
    supported_parameters?: unknown;
    reasoning?: unknown;
}

/** Keep the key only when the feed carries it, so absent never becomes null. */
function keep(source: FeedModel, key: keyof FeedModel): Record<string, unknown> {
    const value = source[key];

    return value === undefined || value === null ? {} : { [key]: value };
}

const response = await fetch(MODELS_URL, { headers: { "X-Title": "GenesisTools" } });

if (!response.ok) {
    throw new Error(`OpenRouter models API error: ${response.status} ${response.statusText}`);
}

const payload = SafeJSON.parse(await response.text(), { strict: true }) as { data?: FeedModel[] };
const feed = payload.data ?? [];

if (feed.length === 0) {
    throw new Error("OpenRouter models API returned no models — refusing to overwrite the snapshot");
}

const models = feed
    .filter((model): model is FeedModel & { id: string } => typeof model.id === "string")
    .map((model) => ({
        id: model.id,
        ...keep(model, "name"),
        ...keep(model, "context_length"),
        ...keep(model, "pricing"),
        ...keep(model, "architecture"),
        ...keep(model, "supported_parameters"),
        ...keep(model, "reasoning"),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

// One line per model: a fully indented file is twice the size for no gain, and a
// single-line file makes every refresh a one-line diff nobody can read. Per-model
// lines mean `git diff` shows exactly which models changed price.
const lines = models.map((model) => `  ${SafeJSON.stringify(model)}`).join(",\n");
const serialized = `{\n  "fetchedAt": ${SafeJSON.stringify(new Date().toISOString())},\n  "models": [\n${lines}\n  ]\n}\n`;

atomicWriteFileSync(TARGET.pathname, serialized);

process.stdout.write(
    `wrote ${models.length} models to ${TARGET.pathname} (${(serialized.length / 1024).toFixed(0)} KB)\n`
);
