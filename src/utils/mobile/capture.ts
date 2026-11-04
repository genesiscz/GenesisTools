import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { formatTree, type LogBoxView, parseSource, readLogBox, type ScreenSummary, summarize } from "./a11y";
import type { MobileRoute } from "./project";
import type { ScreenDriver } from "./screen-driver";

export interface CaptureFiles {
    png: string;
    /** Absent when the driver cannot read the tree (simctl with no WDA running). */
    xml?: string;
    tree?: string;
    json: string;
}

export interface CaptureResult {
    files: CaptureFiles;
    summary: ScreenSummary | null;
    logbox: LogBoxView["state"] | null;
}

/**
 * One screen to files: `<name>.png`, the raw tree `<name>.xml`, the readable tree `<name>.tree.txt` (one line per
 * element that has a testID, words or a tap target), and `<name>.json` with the summary (testIDs, visible words, tap
 * targets, open alerts) and whether a LogBox shows.
 */
export async function captureScreen(options: {
    driver: ScreenDriver;
    outDir: string;
    name: string;
    route?: MobileRoute;
}): Promise<CaptureResult> {
    const { driver, outDir, name, route } = options;
    mkdirSync(outDir, { recursive: true });
    const files: CaptureFiles = { png: join(outDir, `${name}.png`), json: join(outDir, `${name}.json`) };
    await driver.screenshot(files.png);
    const xml = await driver.source();
    let summary: ScreenSummary | null = null;
    let logbox: LogBoxView["state"] | null = null;

    if (xml !== null) {
        const nodes = parseSource(xml);
        files.xml = join(outDir, `${name}.xml`);
        files.tree = join(outDir, `${name}.tree.txt`);
        writeFileSync(files.xml, xml);
        writeFileSync(files.tree, `${formatTree(nodes, { visibleOnly: true })}\n`);
        summary = summarize(nodes);
        logbox = readLogBox(nodes).state;
    }

    writeFileSync(
        files.json,
        SafeJSON.stringify(
            { capturedAt: new Date().toISOString(), driver: driver.kind, route: route ?? null, files, logbox, summary },
            null,
            2
        )
    );
    return { files, summary, logbox };
}
