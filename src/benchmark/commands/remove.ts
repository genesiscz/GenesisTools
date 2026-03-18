import * as p from "@clack/prompts";
import { getCustomSuites, BUILTIN_SUITES, saveCustomSuites } from "@app/benchmark/lib/suites";

export async function cmdRemove(name: string): Promise<void> {
    if (BUILTIN_SUITES.some((s) => s.name === name)) {
        p.log.error(`Cannot delete built-in suite "${name}".`);
        process.exit(1);
    }

    const custom = await getCustomSuites();
    const idx = custom.findIndex((s) => s.name === name);

    if (idx === -1) {
        p.log.error(`Suite "${name}" not found.`);
        process.exit(1);
    }

    custom.splice(idx, 1);
    await saveCustomSuites(custom);
    p.log.success(`Suite "${name}" removed.`);
}
