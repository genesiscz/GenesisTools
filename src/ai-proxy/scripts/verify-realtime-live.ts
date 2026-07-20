/**
 * Live end-to-end verification of the ai-proxy realtime tunnel + batch STT
 * against the REAL xAI upstream (spends a fraction of a cent of credits).
 *
 *   XAI_API_KEY=… bun src/ai-proxy/scripts/verify-realtime-live.ts <audio.wav>
 *
 * The wav must be LEI16 mono 24 kHz (e.g. `say -o x.wav --data-format=LEI16@24000 "hi"`).
 * Boots a throwaway proxy on a random port with a temp GENESIS_TOOLS_HOME
 * (never touches the user's running proxy/config), then:
 *   1. WS tunnel: session.update (turn_detection null, pcm24k, grok-transcribe
 *      input transcription) → input_audio_buffer.append/commit →
 *      response.create → waits for transcripts/audio deltas.
 *   2. POST /v1/audio/transcriptions with the same wav.
 *   3. POST /v1/realtime/client_secrets mint.
 */
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAiProxyConfigStore, resetAiProxyConfigStore } from "@app/ai-proxy/lib/config-store";
import { createRuntime, startAiProxyServer } from "@app/ai-proxy/lib/server";
import { getAiProxyStorage, resetAiProxyStorage } from "@app/ai-proxy/lib/storage";
import type { AiProxyConfig } from "@app/ai-proxy/lib/types";
import { SafeJSON } from "@genesiscz/utils/json";

const PROXY_KEY = `live-verify-${crypto.randomUUID()}`;
const MODEL = "live/grok/grok-voice-latest";
const OPENAI_MODEL = "live-oa/openai/gpt-realtime";

function extractPcm(wavPath: string): Buffer {
    const wav = readFileSync(wavPath);
    const dataAt = wav.indexOf(Buffer.from("data"));

    if (dataAt < 0) {
        throw new Error(`${wavPath}: no RIFF data chunk`);
    }

    return wav.subarray(dataAt + 8);
}

async function main() {
    const wavPath = process.argv[2];

    if (!wavPath || !process.env.XAI_API_KEY) {
        console.error("usage: XAI_API_KEY=… bun verify-realtime-live.ts <audio-24k-lei16.wav>");
        process.exit(2);
    }

    const pcm = extractPcm(wavPath);
    console.log(`audio: ${wavPath} → ${pcm.length} PCM bytes (~${(pcm.length / 48000).toFixed(2)}s @24k)`);

    const tempDir = mkdtempSync(join(tmpdir(), "ai-proxy-live-"));
    process.env.GENESIS_TOOLS_HOME = tempDir;
    resetAiProxyConfigStore();
    resetAiProxyStorage();

    const config: AiProxyConfig = {
        listen: { host: "127.0.0.1", port: 0 },
        proxyApiKey: PROXY_KEY,
        translation: { cursorAgent: "off", thinking: "raw" },
        accounts: [
            {
                name: "live",
                provider: "xai-api-key",
                providerSlug: "grok",
                enabled: true,
                apiKeyEnv: "XAI_API_KEY",
            },
            {
                name: "live-oa",
                provider: "openai",
                providerSlug: "openai",
                enabled: true,
                apiKeyEnv: "OPENAI_API_KEY",
            },
        ],
    };

    mkdirSync(getAiProxyStorage().getBaseDir(), { recursive: true });
    await getAiProxyConfigStore().save(config);

    const proxy = startAiProxyServer(await createRuntime(config));
    console.log(`throwaway proxy on 127.0.0.1:${proxy.port}`);

    async function runTunnel(model: string, transcriptionModel?: string) {
        console.log(`--- realtime WS tunnel: ${model} ---`);
        const eventCounts = new Map<string, number>();
        let inputTranscript = "";
        let outputTranscript = "";
        let audioDeltaBytes = 0;
        const done = Promise.withResolvers<string>();

        const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/v1/realtime?model=${encodeURIComponent(model)}`, {
            headers: { Authorization: `Bearer ${PROXY_KEY}` },
        } as never);

        const deadline = setTimeout(() => done.resolve("timeout after 30s"), 30_000);
        ws.onerror = () => done.resolve("client WS error");
        ws.onclose = (event) => done.resolve(`closed code=${event.code} reason=${event.reason}`);
        ws.onmessage = (event) => {
            if (typeof event.data !== "string") {
                return;
            }

            const parsed = SafeJSON.parse(event.data) as {
                type?: string;
                delta?: string;
                transcript?: string;
                error?: unknown;
            };
            const type = parsed.type ?? "?";
            eventCounts.set(type, (eventCounts.get(type) ?? 0) + 1);

            if (type === "error") {
                console.log(`  upstream error event: ${event.data.slice(0, 400)}`);
            }

            if (type === "session.created") {
                ws.send(
                    SafeJSON.stringify({
                        type: "session.update",
                        session: {
                            type: "realtime",
                            instructions: "Reply with one short sentence.",
                            audio: {
                                input: {
                                    format: { type: "audio/pcm", rate: 24000 },
                                    turn_detection: null,
                                    ...(transcriptionModel ? { transcription: { model: transcriptionModel } } : {}),
                                },
                            },
                        },
                    })
                );
            }

            if (type === "session.updated") {
                ws.send(SafeJSON.stringify({ type: "input_audio_buffer.append", audio: pcm.toString("base64") }));
                ws.send(SafeJSON.stringify({ type: "input_audio_buffer.commit" }));
                ws.send(SafeJSON.stringify({ type: "response.create" }));
            }

            if (type === "conversation.item.input_audio_transcription.completed") {
                inputTranscript = parsed.transcript ?? "";
            }

            if (type.endsWith("output_audio.delta") && typeof parsed.delta === "string") {
                audioDeltaBytes += Buffer.from(parsed.delta, "base64").length;
            }

            if (type.endsWith("output_audio_transcript.delta") && typeof parsed.delta === "string") {
                outputTranscript += parsed.delta;
            }

            if (type === "response.done") {
                done.resolve("response.done");
            }
        };

        const outcome = await done.promise;
        clearTimeout(deadline);
        ws.close(1000);
        console.log(`outcome: ${outcome}`);
        console.log(`events: ${[...eventCounts.entries()].map(([k, v]) => `${k}×${v}`).join(", ")}`);
        console.log(`input transcript:  ${SafeJSON.stringify(inputTranscript)}`);
        console.log(`output transcript: ${SafeJSON.stringify(outputTranscript)}`);
        console.log(`output audio delta bytes: ${audioDeltaBytes}`);
    }

    await runTunnel(MODEL, "grok-transcribe");

    if (process.env.OPENAI_API_KEY) {
        await runTunnel(OPENAI_MODEL);
    } else {
        console.log("--- skipping OpenAI tunnel (no OPENAI_API_KEY) ---");
    }

    console.log("--- 2. batch /v1/audio/transcriptions ---");
    const form = new FormData();
    form.append("model", "live/grok/grok-transcribe");
    form.append("file", new Blob([readFileSync(wavPath)], { type: "audio/wav" }), "sample.wav");
    const stt = await fetch(`http://127.0.0.1:${proxy.port}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${PROXY_KEY}` },
        body: form,
    });
    console.log(`HTTP ${stt.status}: ${(await stt.text()).slice(0, 300)}`);

    console.log("--- 3. /v1/realtime/client_secrets mint ---");
    const mint = await fetch(`http://127.0.0.1:${proxy.port}/v1/realtime/client_secrets`, {
        method: "POST",
        headers: { Authorization: `Bearer ${PROXY_KEY}`, "Content-Type": "application/json" },
        body: SafeJSON.stringify({ session: { type: "realtime", model: MODEL } }),
    });
    const mintBody = (await mint.json()) as { value?: string; expires_at?: number };
    console.log(
        `HTTP ${mint.status}: secret=${mintBody.value ? `${mintBody.value.slice(0, 24)}… (${mintBody.value.length} chars)` : "none"} expires_at=${mintBody.expires_at}`
    );

    proxy.stop(true);
    process.exit(0);
}

await main();
