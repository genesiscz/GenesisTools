import * as p from "@clack/prompts";
import { getCustomSuites, BUILTIN_SUITES, saveCustomSuites } from "@app/benchmark/lib/suites";
import type { AddOptions, BenchmarkCommand, BenchmarkSuite } from "@app/benchmark/types";

export async function cmdAdd(name: string, commandPairs: string[], opts: AddOptions = {}): Promise<void> {
    if (BUILTIN_SUITES.some((s) => s.name === name)) {
        p.log.error(`Cannot overwrite built-in suite "${name}".`);
        process.exit(1);
    }

    // Parse --prepare-for pairs into a lookup: label → prepare command
    const prepareForMap = new Map<string, string>();

    for (const pair of opts.prepareFor ?? []) {
        const eqIdx = pair.indexOf("=");

        if (eqIdx === -1) {
            p.log.error(`Invalid --prepare-for format: "${pair}". Expected "label=command".`);
            process.exit(1);
        }

        prepareForMap.set(pair.slice(0, eqIdx), pair.slice(eqIdx + 1));
    }

    const commands: BenchmarkCommand[] = [];

    for (const pair of commandPairs) {
        const colonIdx = pair.indexOf(":");

        if (colonIdx === -1) {
            p.log.error(`Invalid format: "${pair}". Expected "label:command".`);
            process.exit(1);
        }

        const label = pair.slice(0, colonIdx);
        const cmd: BenchmarkCommand = {
            label,
            cmd: pair.slice(colonIdx + 1),
        };

        const perCmdPrepare = prepareForMap.get(label);

        if (perCmdPrepare) {
            cmd.prepare = perCmdPrepare;
        }

        commands.push(cmd);
    }

    const suite: BenchmarkSuite = { name, commands };

    if (opts.runs) {
        suite.runs = opts.runs;
    }

    if (opts.warmup !== undefined) {
        suite.warmup = opts.warmup;
    }

    if (opts.setup) {
        suite.setup = opts.setup;
    }

    if (opts.prepare) {
        suite.prepare = opts.prepare;
    }

    if (opts.cleanup) {
        suite.cleanup = opts.cleanup;
    }

    // Parse --param entries: "variant=on,off" → { variant: ["on", "off"] }
    if (opts.param && opts.param.length > 0) {
        const params: Record<string, string[]> = {};

        for (const p of opts.param) {
            const eqIdx = p.indexOf("=");

            if (eqIdx === -1) {
                continue;
            }

            const key = p.slice(0, eqIdx);
            const values = p.slice(eqIdx + 1).split(",").map((v) => v.trim()).filter(Boolean);
            params[key] = values;
        }

        if (Object.keys(params).length > 0) {
            suite.params = params;
        }
    }

    const custom = await getCustomSuites();
    const existing = custom.findIndex((s) => s.name === name);

    if (existing >= 0) {
        custom[existing] = suite;
    } else {
        custom.push(suite);
    }

    await saveCustomSuites(custom);
    p.log.success(`Suite "${name}" saved with ${commands.length} commands.`);
}
