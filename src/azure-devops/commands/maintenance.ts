import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Api } from "@app/azure-devops/api";
import { requireConfig } from "@app/azure-devops/config";
import {
    type AdoManifest,
    isIdentifier,
    parseManifestText,
    renderManifestJson,
    renderManifestTs,
} from "@app/azure-devops/lib/ado-manifest";
import {
    diffOfKind,
    kindOfManifest,
    MANIFEST_KIND_NAMES,
    MANIFEST_KINDS,
    type ManifestKind,
    manifestKind,
    renderGenericMd,
} from "@app/azure-devops/lib/manifest-kinds";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { formatLocalDateTimeStamp } from "@genesiscz/utils/date";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";

const FORMATS = ["md", "json", "ts"] as const;
type ManifestFormat = (typeof FORMATS)[number];
const FILE_FORMATS = ["ts", "json"] as const;
const GENERATED_FILE = /^ado-[a-z]+\.generated\.(ts|json)$/;

type Manifest = AdoManifest & Record<string, unknown>;

interface KindOptions {
    types?: string;
    into?: string;
    check?: string;
    name?: string;
    format: string;
}

interface SyncOptions {
    into: string;
    only?: string;
    prefix?: string;
    types?: string;
    format: string;
}

interface RunContext {
    api: Api;
    meta(): Promise<Omit<AdoManifest["meta"], "kind" | "regenerate">>;
}

function isFormat(value: string): value is ManifestFormat {
    return FORMATS.some((format) => format === value);
}

function splitList(list: string): string[] {
    return list
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

function formatOfPath(path: string): "ts" | "json" | null {
    if (path.endsWith(".ts")) {
        return "ts";
    }

    return path.endsWith(".json") ? "json" : null;
}

function render(manifest: Manifest, kind: ManifestKind, format: ManifestFormat, exportName?: string): string {
    if (format === "ts") {
        return renderManifestTs(manifest, exportName ?? kind.exportName);
    }

    if (format === "json") {
        return renderManifestJson(manifest);
    }

    return kind.renderMd ? kind.renderMd(manifest) : renderGenericMd(manifest);
}

/** One api and one process lookup per run, shared by every manifest it writes or checks. */
function createContext(): RunContext {
    const config = requireConfig();
    const api = new Api(config);
    let processName: Promise<string | null> | undefined;

    return {
        api,
        meta: async () => {
            processName ??= api.getProjectProcessName().catch((error: unknown) => {
                logger.debug({ error }, "maintenance: process name unavailable");
                return null;
            });

            return {
                org: config.org,
                project: config.project,
                process: await processName,
                fetchedAt: formatLocalDateTimeStamp(new Date(), { seconds: false }),
            };
        },
    };
}

async function fetchManifest(options: {
    context: RunContext;
    kind: ManifestKind;
    types?: string[];
    regenerate: string;
}): Promise<Manifest> {
    const { context, kind, types } = options;
    logger.debug({ kind: kind.kind, types }, "maintenance: fetching a manifest");
    const payload = await kind.fetch({ api: context.api, types: kind.usesTypes ? types : undefined });

    return { meta: { kind: kind.kind, ...(await context.meta()), regenerate: options.regenerate }, ...payload };
}

function typesOf(manifest: Manifest): string[] | undefined {
    const types = manifest.types;

    if (typeof types !== "object" || types === null) {
        return undefined;
    }

    const names = Object.keys(types);
    return names.length > 0 ? names : undefined;
}

/** Compares written manifests with ADO. Returns the number of files that drifted. */
async function checkFiles(paths: string[], types: string[] | undefined): Promise<number> {
    const context = createContext();
    let drifted = 0;

    for (const path of paths) {
        const saved = parseManifestText(readFileSync(path, "utf-8"), path);
        const kind = kindOfManifest(saved);

        if (!kind) {
            out.error(`${path}: unknown manifest kind "${saved.meta.kind}"`);
            drifted++;
            continue;
        }

        const live = await fetchManifest({
            context,
            kind,
            types: types ?? (kind.usesTypes ? typesOf(saved) : undefined),
            regenerate: saved.meta.regenerate,
        });
        const drift = diffOfKind(kind, saved, live);

        if (drift.length === 0) {
            out.println(pc.green(`${path} matches ADO (${kind.kind}).`));
            continue;
        }

        drifted++;
        out.println(pc.red(`${path} (${kind.kind}) drifted from ADO in ${drift.length} place(s):`));

        for (const line of drift) {
            out.println(`  ${line}`);
        }

        out.println(pc.dim(`  Regenerate with: ${saved.meta.regenerate}`));
    }

    return drifted;
}

function generatedFilesIn(dir: string): string[] {
    return readdirSync(dir)
        .filter((name) => GENERATED_FILE.test(name))
        .sort()
        .map((name) => join(dir, name));
}

function registerKind(maintenance: Command, kind: ManifestKind): void {
    const command = maintenance.command(kind.kind).description(kind.description);

    if (kind.kind === "fields") {
        command.alias("get-fields");
    }

    if (kind.usesTypes) {
        command.option(
            "--types <list>",
            'Comma-separated work item types (default: every enabled type), e.g. "Bug,Task"'
        );
    }

    command
        .option("--into <file>", `Write the manifest to a .ts (export const ${kind.exportName}) or .json file`)
        .option("--check <file>", "Compare a written manifest with ADO and exit 1 on drift")
        .option("--name <identifier>", `The exported constant's name in a .ts file (default: ${kind.exportName})`)
        .option("-f, --format <format>", "Output format on stdout: md|json|ts", "md")
        .action(async (options: KindOptions) => {
            const types = options.types ? splitList(options.types) : undefined;

            if (options.name && !isIdentifier(options.name)) {
                out.error(`--name needs a TypeScript identifier, got "${options.name}"`);
                process.exitCode = 1;
                return;
            }

            if (options.check) {
                if ((await checkFiles([options.check], types)) > 0) {
                    process.exitCode = 1;
                }

                return;
            }

            const format = options.into ? formatOfPath(options.into) : options.format;

            if (!format || !isFormat(format)) {
                out.error(
                    options.into
                        ? `--into needs a .ts or .json file, got ${options.into}`
                        : `--format does not accept "${options.format}". Possible: ${FORMATS.join(", ")}`
                );
                process.exitCode = 1;
                return;
            }

            const regenerate = toolCommand(
                `azure-devops maintenance ${kind.kind}`,
                ...(types ? ["--types", types.join(",")] : []),
                ...(options.into ? ["--into", options.into] : []),
                ...(options.name ? ["--name", options.name] : [])
            );
            const manifest = await fetchManifest({ context: createContext(), kind, types, regenerate });
            const text = render(manifest, kind, format, options.name);

            if (options.into) {
                writeFileSync(options.into, text);
                out.println(pc.green(`Wrote the ${kind.kind} manifest to ${options.into}`));
                return;
            }

            out.print(text.trimEnd());
        });
}

export function registerMaintenanceCommand(program: Command): void {
    const maintenance = program
        .command("maintenance")
        .description("Generated manifests of the project's configuration (fields, workflow, sprints, …)");

    for (const kind of MANIFEST_KINDS) {
        registerKind(maintenance, kind);
    }

    maintenance
        .command("sync")
        .description("Write every manifest (or --only some) into one folder as ado-<kind>.generated.<ts|json>")
        .requiredOption("--into <dir>", "The folder to write into (created when missing)")
        .option("--only <kinds>", `Comma-separated kinds: ${MANIFEST_KIND_NAMES.join(",")}`)
        .option("--prefix <identifier>", "Put this in front of each export name, e.g. Sample gives SampleAdoFields")
        .option("--types <list>", "Work item types for the fields and workflow manifests (default: every enabled type)")
        .option("-f, --format <format>", "File format: ts|json", "ts")
        .action(async (options: SyncOptions) => {
            const names = options.only ? splitList(options.only) : MANIFEST_KIND_NAMES;
            const unknown = names.filter((name) => !manifestKind(name));
            const format = FILE_FORMATS.find((value) => value === options.format);

            if (unknown.length > 0 || !format) {
                out.error(
                    unknown.length > 0
                        ? `Unknown kind(s): ${unknown.join(", ")}. Possible: ${MANIFEST_KIND_NAMES.join(", ")}`
                        : `--format does not accept "${options.format}". Possible: ${FILE_FORMATS.join(", ")}`
                );
                process.exitCode = 1;
                return;
            }

            if (options.prefix && !isIdentifier(`${options.prefix}Ado`)) {
                out.error(`--prefix must start a TypeScript identifier, got "${options.prefix}"`);
                process.exitCode = 1;
                return;
            }

            const types = options.types ? splitList(options.types) : undefined;
            const regenerate = toolCommand(
                "azure-devops maintenance sync",
                "--into",
                options.into,
                ...(options.only ? ["--only", names.join(",")] : []),
                ...(options.prefix ? ["--prefix", options.prefix] : []),
                ...(types ? ["--types", types.join(",")] : []),
                ...(format === "json" ? ["--format", "json"] : [])
            );
            const context = createContext();
            mkdirSync(options.into, { recursive: true });

            for (const name of names) {
                const kind = manifestKind(name);

                if (!kind) {
                    continue;
                }

                const manifest = await fetchManifest({ context, kind, types, regenerate });
                const path = join(options.into, `ado-${kind.kind}.generated.${format}`);
                writeFileSync(path, render(manifest, kind, format, `${options.prefix ?? ""}${kind.exportName}`));
                out.println(pc.green(`Wrote ${path}`));
            }
        });

    maintenance
        .command("check")
        .description(
            "Compare written manifests (files, or every ado-*.generated.* in a folder) with ADO; exit 1 on drift"
        )
        .argument("<paths...>", "Manifest files or folders")
        .option("--types <list>", "Check these work item types instead of the ones in each file")
        .action(async (paths: string[], options: { types?: string }) => {
            const missing = paths.filter((path) => !existsSync(path));

            if (missing.length > 0) {
                out.error(`Not found: ${missing.join(", ")}`);
                process.exitCode = 1;
                return;
            }

            const files = paths.flatMap((path) => (statSync(path).isDirectory() ? generatedFilesIn(path) : [path]));

            if (files.length === 0) {
                out.error(`No ado-<kind>.generated.ts or .json files in ${paths.join(", ")}`);
                process.exitCode = 1;
                return;
            }

            const drifted = await checkFiles(files, options.types ? splitList(options.types) : undefined);

            if (drifted > 0) {
                out.println(pc.red(`${drifted} of ${files.length} manifest(s) drifted.`));
                process.exitCode = 1;
            }
        });
}
