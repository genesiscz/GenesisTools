#!/usr/bin/env bun
/**
 * The REPL goal of the recorder and editor toolsets, end to end, in one `tools node-repl run --toolset
 * recorder,editor` turn: 20 s of every display with system sound, a mute, a display switch and back, an fps
 * change, stop after post-processing, change-only frames from 00:05 to 00:20, and a 3 × 3 grid saved as PNG.
 * It records the screen (and the microphone only with --mic, which may ask for the microphone permission); it
 * never moves the pointer, focuses an app or types.
 *
 *   bun src/node-repl/scripts/recorder-editor-demo.ts --out /tmp/cc/<project>/<session>/repl [--mic]
 */
import { mkdirSync } from "node:fs";
import { execTool } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? args[outIndex + 1] : undefined;
const withMic = args.includes("--mic");

if (!outDir) {
    out.log.error("--out <folder> is required: the grid PNG goes there");
    process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const code = `
const OUT = ${SafeJSON.stringify(outDir)};
const WITH_MIC = ${withMic};
const log = (line) => nodeRepl.write(line);
const started = Date.now();
const at = () => ((Date.now() - started) / 1000).toFixed(1).padStart(5) + " s";

const rec = await recorder.start({
    title: "recorder-editor demo",
    displays: "all",
    audio: { mic: WITH_MIC, system: true },
    fps: 2,
    ocr: { languages: ["cs-CZ", "en-US"] },
});
await rec.on("progress", (e) => log(\`\${at()} [recorder \${e.job}] \${e.step} \${e.done}/\${e.total} \${e.unit}\${e.message ? " " + e.message : ""}\`));
await rec.on("warning", (e) => log(\`\${at()} [recorder warning] \${e.warning}\`));
log(\`\${at()} started \${rec.recordingId} (\${rec.kind}) in \${rec.folder}\`);
if (!WITH_MIC) {
    log("note: the microphone is left out (run with --mic); muting the system sound instead");
}

const source = WITH_MIC ? "mic" : "system";
try {
    await rec.audio.mute(source);
    log(\`\${at()} \${source} muted\`);
} catch (error) {
    log(\`note: audio skipped: \${error.message}\`);
}

await rec.set({ fps: 8, threshold: 1.5 });
log(\`\${at()} fps 8, threshold 1.5 %\`);
const displays = await rec.displays.list();
log(\`\${at()} displays: \${displays.map((d) => \`\${d.id} \${d.name}\${d.recorded ? " (recorded)" : ""}\`).join(", ")}\`);
await sleep(8_000);

const second = displays.find((d) => !d.main);
if (second) {
    const switched = await rec.displays.switch(second.id);
    log(\`\${at()} switched to display \${second.id} (\${switched.applied})\`);
    await sleep(4_000);
    const back = await rec.displays.mode("all");
    log(\`\${at()} back to all displays (\${back.applied})\`);
} else {
    log("note: one display only, no switch");
}

const status = await rec.waitFor((s) => s.frames > 0, { timeoutMs: 10_000 });
log(\`\${at()} \${status.frames} frames so far\`);
await sleep(Math.max(0, 20_000 - (Date.now() - started)));

const done = await rec.stop();
log(\`\${at()} stopped: \${done.outcome}, \${done.frames} frames, job \${done.job}\`);

const clip = editor.open(done.recordingId);
const info = await clip.info();
log(\`\${at()} clip: \${info.frames} frames over \${(info.durationUs / 1e6).toFixed(1)} s on displays \${info.displays.join(", ")}\`);
const framesJob = clip.frames({ changeOnly: true, threshold: 2, from: "00:05", to: "00:20" });
framesJob.on("progress", (e) => log(\`\${at()} [editor \${e.job}] \${e.step} \${e.done}/\${e.total} \${e.unit}\${e.message ? " " + e.message : ""}\`));
const frames = await framesJob;
log(\`\${at()} \${frames.frames.length} of \${frames.total} frames changed by 2 % or more\`);
const grid = clip.grid({ frames, cols: 3, rows: 3, labels: "time" });
grid.on("progress", (e) => log(\`\${at()} [editor \${e.job}] \${e.step} \${e.done}/\${e.total} \${e.unit}\${e.message ? " " + e.message : ""}\`));
const paths = await grid.show();
for (const [index, path] of paths.entries()) {
    const target = \`\${OUT}/grid-\${index + 1}.png\`;
    await Bun.write(target, Bun.file(path));
    log(\`\${at()} grid \${index + 1} saved to \${target}\`);
}
"done";
`;

const result = await execTool(["node-repl", "run", "--toolset", "recorder,editor", "--timeout", "240000"], {
    stdin: code,
    timeout: 300_000,
});
out.print(result.stdout);

if (result.stderr.trim()) {
    out.log.info(result.stderr.trim().split("\n").slice(-20).join("\n"));
}

process.exitCode = result.exitCode ?? 1;
