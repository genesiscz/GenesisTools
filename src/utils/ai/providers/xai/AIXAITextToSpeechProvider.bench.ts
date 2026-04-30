import { performance } from "node:perf_hooks";
import { AIXAITextToSpeechProvider } from "./AIXAITextToSpeechProvider";

const SAMPLE = [
    "In quiet hours when the screen is bright, the cursor blinks against the night.",
    "Through tangled trees of thought I roam, and find at last the syntax of home.",
    "Each function called, each variable named, builds quiet stanzas, gently framed.",
    "The compiler hums a steady tune; the bug, once feared, departs by noon.",
].join(" ");

if (!process.env.X_AI_API_KEY) {
    console.error("X_AI_API_KEY not set — skipping benchmark.");
    process.exit(1);
}

const provider = new AIXAITextToSpeechProvider();

async function timeRest(): Promise<{ ttfbMs: number; totalMs: number; bytes: number }> {
    const start = performance.now();
    const result = await provider.synthesize(SAMPLE);
    const total = performance.now() - start;

    return { ttfbMs: total, totalMs: total, bytes: result.audio.byteLength };
}

async function timeWs(): Promise<{ ttfbMs: number; totalMs: number; bytes: number }> {
    const start = performance.now();
    const { audio } = provider.synthesizeStream(SAMPLE);
    let firstByteMs = 0;
    let bytes = 0;

    for await (const chunk of audio) {
        if (firstByteMs === 0 && chunk.byteLength > 0) {
            firstByteMs = performance.now() - start;
        }

        bytes += chunk.byteLength;
    }

    const total = performance.now() - start;
    return { ttfbMs: firstByteMs, totalMs: total, bytes };
}

console.log(`Sample: ${SAMPLE.length} chars`);

const rest = await timeRest();
console.log(
    `REST  /v1/tts (HTTP)  → TTFB ${rest.ttfbMs.toFixed(0)}ms, total ${rest.totalMs.toFixed(0)}ms, ${rest.bytes} bytes`
);

const ws = await timeWs();
console.log(
    `WS    /v1/tts (WSS)   → TTFB ${ws.ttfbMs.toFixed(0)}ms, total ${ws.totalMs.toFixed(0)}ms, ${ws.bytes} bytes`
);

const winner = ws.ttfbMs < rest.ttfbMs ? "WS" : "REST";
const delta = Math.abs(ws.ttfbMs - rest.ttfbMs).toFixed(0);
console.log(`\nFirst-byte winner: ${winner} (by ${delta}ms)`);
