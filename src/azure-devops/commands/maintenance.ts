import { readFileSync, writeFileSync } from "node:fs";
import { Api } from "@app/azure-devops/api";
import { requireConfig } from "@app/azure-devops/config";
import {
    type AdoFieldManifest,
    buildFieldManifest,
    diffManifests,
    isIdentifier,
    parseManifestFile,
    renderManifestJson,
    renderManifestMd,
    renderManifestTs,
    type TypeInput,
} from "@app/azure-devops/lib/field-manifest";
import { concurrentMap } from "@genesiscz/utils/async";

import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { formatLocalDateTimeStamp } from "@genesiscz/utils/date";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";

const FORMATS = ["md", "json", "ts"] as const;
type ManifestFormat = (typeof FORMATS)[number];

interface GetFieldsOptions {
    types?: string;
    into?: string;
    check?: string;
    name?: string;
    format: string;
}

function isFormat(value: string): value is ManifestFormat {
    return FORMATS.some((format) => format === value);
}

function render(manifest: AdoFieldManifest, format: ManifestFormat, exportName?: string): string {
    if (format === "ts") {
        return renderManifestTs(manifest, exportName);
    }

    return format === "json" ? renderManifestJson(manifest) : renderManifestMd(manifest);
}

function formatOfPath(path: string): ManifestFormat | null {
    if (path.endsWith(".ts")) {
        return "ts";
    }

    return path.endsWith(".json") ? "json" : null;
}

function splitTypes(list: string): string[] {
    return list
        .split(",")
        .map((type) => type.trim())
        .filter(Boolean);
}

async function fetchManifest(options: { types?: string[]; into?: string; name?: string }): Promise<AdoFieldManifest> {
    const config = requireConfig();
    const api = new Api(config);
    const typeNames = options.types ?? (await api.getAvailableWorkItemTypes());
    logger.debug({ types: typeNames }, "maintenance get-fields: fetching types");

    const failures: string[] = [];
    const [catalog, process, fetched] = await Promise.all([
        api.getFieldCatalog(),
        api.getProjectProcessName().catch((error: unknown) => {
            logger.debug({ error }, "maintenance get-fields: process name unavailable");
            return null;
        }),
        concurrentMap({
            items: typeNames,
            concurrency: 4,
            fn: async (name): Promise<TypeInput> => {
                const [fields, states] = await Promise.all([
                    api.getWorkItemTypeFields(name),
                    api.getWorkItemTypeStates(name),
                ]);
                return { name, fields, states };
            },
            onError: (name, error) => failures.push(`${name}: ${error instanceof Error ? error.message : error}`),
        }),
    ]);

    // A type that failed to load would read as "removed" in a check, so a partial manifest is never written.
    if (failures.length > 0) {
        throw new Error(`Could not read ${failures.length} work item type(s):\n  ${failures.join("\n  ")}`);
    }

    const regenerate = toolCommand(
        "azure-devops maintenance get-fields",
        ...(options.types ? ["--types", options.types.join(",")] : []),
        ...(options.into ? ["--into", options.into] : []),
        ...(options.name ? ["--name", options.name] : [])
    );

    return buildFieldManifest({
        meta: {
            org: config.org,
            project: config.project,
            process,
            fetchedAt: formatLocalDateTimeStamp(new Date(), { seconds: false }),
            regenerate,
        },
        catalog,
        types: [...fetched.values()],
    });
}

async function checkManifest(path: string, types: string[] | undefined): Promise<void> {
    const saved = parseManifestFile(readFileSync(path, "utf-8"), path);
    const live = await fetchManifest({ types: types ?? Object.keys(saved.types) });
    const drift = diffManifests(saved, live);

    if (drift.length === 0) {
        out.println(pc.green(`${path} matches ADO (${Object.keys(saved.types).length} types).`));
        return;
    }

    out.println(pc.red(`${path} drifted from ADO in ${drift.length} place(s):`));

    for (const line of drift) {
        out.println(`  ${line}`);
    }

    out.println(pc.dim(`Regenerate with: ${saved.meta.regenerate}`));
    process.exitCode = 1;
}

export function registerMaintenanceCommand(program: Command): void {
    const maintenance = program
        .command("maintenance")
        .description("Project upkeep: generated manifests of the project's configuration");

    maintenance
        .command("get-fields")
        .description("Every field of each work item type (label, type, allowed values) and the type's states")
        .option("--types <list>", 'Comma-separated work item types (default: every enabled type), e.g. "Bug,Task"')
        .option("--into <file>", "Write the manifest to a .ts (export const AdoFields) or .json file")
        .option("--name <identifier>", "The exported constant's name in a .ts file (default: AdoFields)")
        .option("--check <file>", "Compare a written manifest with ADO and exit 1 on drift")
        .option("-f, --format <format>", "Output format on stdout: md|json|ts", "md")
        .action(async (options: GetFieldsOptions) => {
            const types = options.types ? splitTypes(options.types) : undefined;

            if (options.name && !isIdentifier(options.name)) {
                out.error(`--name needs a TypeScript identifier, got "${options.name}"`);
                process.exitCode = 1;
                return;
            }

            if (options.check) {
                await checkManifest(options.check, types);
                return;
            }

            if (options.into) {
                const format = formatOfPath(options.into);

                if (!format) {
                    out.error(`--into needs a .ts or .json file, got ${options.into}`);
                    process.exitCode = 1;
                    return;
                }

                const manifest = await fetchManifest({ types, into: options.into, name: options.name });
                writeFileSync(options.into, render(manifest, format, options.name));
                out.println(pc.green(`Wrote ${Object.keys(manifest.types).length} types to ${options.into}`));
                return;
            }

            if (!isFormat(options.format)) {
                out.error(`--format does not accept "${options.format}". Possible: ${FORMATS.join(", ")}`);
                process.exitCode = 1;
                return;
            }

            out.print(
                render(await fetchManifest({ types, name: options.name }), options.format, options.name).trimEnd()
            );
        });
}
