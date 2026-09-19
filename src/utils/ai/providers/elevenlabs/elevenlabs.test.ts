import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpeechModelV3, TranscriptionModelV3 } from "@ai-sdk/provider";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import type { SpeechModel, TranscriptionModel } from "ai";
import type { AccountEntry } from "../../config/schema";
import { CredentialUnavailableError, resolveCredential } from "../credentials";
import { _resetBuiltInPluginsForTest, registerBuiltInPlugins } from "../plugins";
import { elevenLabsPlugin } from "../plugins/elevenlabs";
import { speechEngineFor, speechEngineIds } from "../speech-engines";
import { AIElevenLabsTextToSpeechProvider } from "./AIElevenLabsTextToSpeechProvider";
import { AIElevenLabsTranscriptionProvider } from "./AIElevenLabsTranscriptionProvider";

const FIXTURE_KEY = "sk_fixture_elevenlabs_key";
const VOICE_ALPHA = "voice_fixture_alpha";
const VOICE_BETA = "voice_fixture_beta";
const MP3_BYTES = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x11, 0x22]);

interface RecordedCall {
    url: string;
    init?: RequestInit;
}

/** `SpeechModel` / `TranscriptionModel` from "ai" are version unions; the members live on the spec. */
function asSpeechV3(model: SpeechModel | undefined): SpeechModelV3 {
    if (!model || typeof model === "string") {
        throw new Error("expected a bound speech model");
    }

    return model as SpeechModelV3;
}

function asTranscriptionV3(model: TranscriptionModel | undefined): TranscriptionModelV3 {
    if (!model || typeof model === "string") {
        throw new Error("expected a bound transcription model");
    }

    return model as TranscriptionModelV3;
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
    return new Headers(init?.headers).get(name);
}

function bodyJson(init: RequestInit | undefined): Record<string, unknown> {
    if (typeof init?.body !== "string") {
        throw new Error("expected a JSON string body");
    }

    return SafeJSON.parse(init.body);
}

function voicesResponse(): Response {
    return Response.json({
        voices: [
            { voice_id: VOICE_ALPHA, name: "Alpha", description: "first", labels: { language: "en" } },
            { voice_id: VOICE_BETA, name: "Beta" },
        ],
    });
}

function audioResponse(): Response {
    return new Response(MP3_BYTES, { headers: { "content-type": "audio/mpeg" } });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response): {
    calls: RecordedCall[];
    restore: () => void;
} {
    const calls: RecordedCall[] = [];
    const original = globalThis.fetch;

    const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        calls.push({ url, init });
        return handler(url, init);
    };

    globalThis.fetch = stub as unknown as typeof fetch;

    return {
        calls,
        restore: () => {
            globalThis.fetch = original;
        },
    };
}

/** Routes the two endpoints the engine uses; anything else fails the test loudly. */
function stubElevenLabs(): ReturnType<typeof stubFetch> {
    return stubFetch((url) => {
        if (url.includes("/v1/voices")) {
            return voicesResponse();
        }

        if (url.includes("/v1/text-to-speech/")) {
            return audioResponse();
        }

        return new Response("unexpected endpoint", { status: 500 });
    });
}

function account(overrides: Partial<AccountEntry> = {}): AccountEntry {
    return {
        id: "acc_voice",
        name: "voice-shop",
        provider: "elevenlabs",
        enabled: true,
        billing: { mode: "metered" },
        credentials: {},
        useEnvApiKey: false,
        ...overrides,
    };
}

let stub: ReturnType<typeof stubFetch> | undefined;

beforeEach(() => {
    env.testing.set("GENESIS_TOOLS_HOME", mkdtempSync(join(tmpdir(), "gt-eleven-")));
});

afterEach(() => {
    stub?.restore();
    stub = undefined;
    env.testing.unset("GENESIS_TOOLS_HOME");
    env.testing.unset("ELEVENLABS_API_KEY");
});

describe("AIElevenLabsTextToSpeechProvider", () => {
    test("speaks only, and reports itself as elevenlabs", () => {
        const provider = new AIElevenLabsTextToSpeechProvider({ apiKey: FIXTURE_KEY });

        expect(provider.type).toBe("elevenlabs");
        expect(provider.supports("tts")).toBe(true);
        expect(provider.supports("transcribe")).toBe(false);
        expect(provider.supports("summarize")).toBe(false);
    });

    test("synthesize posts the voice url, the xi-api-key header and the multilingual model", async () => {
        stub = stubElevenLabs();
        const provider = new AIElevenLabsTextToSpeechProvider({ apiKey: FIXTURE_KEY, forceFreshVoices: true });

        const result = await provider.synthesize("Nine short words for the fixture voice.", { voice: VOICE_BETA });

        const speech = stub.calls.find((call) => call.url.includes("/v1/text-to-speech/"));
        expect(speech).toBeDefined();
        expect(speech?.url).toBe(
            `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_BETA}?output_format=mp3_44100_128`
        );
        expect(speech?.init?.method).toBe("POST");
        expect(headerOf(speech?.init, "xi-api-key")).toBe(FIXTURE_KEY);
        expect(headerOf(speech?.init, "content-type")).toBe("application/json");
        expect(bodyJson(speech?.init)).toEqual({
            text: "Nine short words for the fixture voice.",
            model_id: "eleven_multilingual_v2",
        });
        expect(result.contentType).toBe("audio/mpeg");
        expect(result.audio.byteLength).toBe(MP3_BYTES.byteLength);
    });

    test("an unset voice falls back to the first voice the key can see", async () => {
        stub = stubElevenLabs();
        const provider = new AIElevenLabsTextToSpeechProvider({ apiKey: FIXTURE_KEY, forceFreshVoices: true });

        await provider.synthesize("no voice was chosen");

        const speech = stub.calls.find((call) => call.url.includes("/v1/text-to-speech/"));
        expect(speech?.url).toContain(`/v1/text-to-speech/${VOICE_ALPHA}?`);
    });

    test("wav asks for the 24 kHz output format, which no subscription tier gates", async () => {
        stub = stubElevenLabs();
        const provider = new AIElevenLabsTextToSpeechProvider({ apiKey: FIXTURE_KEY, forceFreshVoices: true });

        await provider.synthesize("format check", { voice: VOICE_ALPHA, format: "wav" });

        const speech = stub.calls.find((call) => call.url.includes("/v1/text-to-speech/"));
        expect(speech?.url).toContain("output_format=wav_24000");
    });

    test("textNormalization turns the apply_text_normalization flag on", async () => {
        stub = stubElevenLabs();
        const provider = new AIElevenLabsTextToSpeechProvider({ apiKey: FIXTURE_KEY, forceFreshVoices: true });

        await provider.synthesize("42 dogs", { voice: VOICE_ALPHA, textNormalization: true });

        const speech = stub.calls.find((call) => call.url.includes("/v1/text-to-speech/"));
        expect(bodyJson(speech?.init).apply_text_normalization).toBe("on");
    });

    test("a language hint is dropped for multilingual_v2, which ignores it, and sent for other models", async () => {
        stub = stubElevenLabs();
        const multilingual = new AIElevenLabsTextToSpeechProvider({ apiKey: FIXTURE_KEY, forceFreshVoices: true });
        const turbo = new AIElevenLabsTextToSpeechProvider({
            apiKey: FIXTURE_KEY,
            modelId: "eleven_turbo_v2_5",
            forceFreshVoices: true,
        });

        await multilingual.synthesize("ahoj", { voice: VOICE_ALPHA, language: "cs" });
        await turbo.synthesize("ahoj", { voice: VOICE_ALPHA, language: "cs" });

        const speechCalls = stub.calls.filter((call) => call.url.includes("/v1/text-to-speech/"));
        expect(speechCalls).toHaveLength(2);
        expect(bodyJson(speechCalls[0]?.init).language_code).toBeUndefined();
        expect(bodyJson(speechCalls[1]?.init).language_code).toBe("cs");
    });

    test("streaming posts to the /stream sibling and yields the body chunks", async () => {
        stub = stubElevenLabs();
        const provider = new AIElevenLabsTextToSpeechProvider({ apiKey: FIXTURE_KEY, forceFreshVoices: true });

        const { audio, contentType } = provider.synthesizeStream("stream me", { voice: VOICE_ALPHA });
        const chunks: Uint8Array[] = [];

        for await (const chunk of audio) {
            chunks.push(chunk);
        }

        expect(contentType).toBe("audio/mpeg");
        expect(chunks.reduce((total, chunk) => total + chunk.byteLength, 0)).toBe(MP3_BYTES.byteLength);
        const speech = stub.calls.find((call) => call.url.includes("/v1/text-to-speech/"));
        expect(speech?.url).toContain(`/v1/text-to-speech/${VOICE_ALPHA}/stream?`);
    });

    test("a failed request names the status and quotes the body", async () => {
        stub = stubFetch(() => new Response('{"detail":{"status":"quota_exceeded"}}', { status: 401 }));
        const provider = new AIElevenLabsTextToSpeechProvider({ apiKey: FIXTURE_KEY, forceFreshVoices: true });

        await expect(provider.synthesize("nope", { voice: VOICE_ALPHA })).rejects.toThrow(/401.*quota_exceeded/s);
        // 401 is not retried: three attempts against a dead key waste the quota.
        expect(stub.calls).toHaveLength(1);
    });

    test("listVoices maps ids, names and the language label", async () => {
        stub = stubElevenLabs();
        const provider = new AIElevenLabsTextToSpeechProvider({ apiKey: FIXTURE_KEY, forceFreshVoices: true });

        const voices = await provider.listVoices();

        expect(voices).toEqual([
            { id: VOICE_ALPHA, name: "Alpha", description: "first", locale: "en" },
            { id: VOICE_BETA, name: "Beta", description: undefined, locale: undefined },
        ]);
    });

    test("the voice list is cached, so a second engine on the same home does not refetch", async () => {
        stub = stubElevenLabs();
        const first = new AIElevenLabsTextToSpeechProvider({ apiKey: FIXTURE_KEY });
        await first.listVoices();
        const afterFirst = stub.calls.length;

        const second = new AIElevenLabsTextToSpeechProvider({ apiKey: FIXTURE_KEY });
        const voices = await second.listVoices();

        expect(afterFirst).toBe(1);
        expect(stub.calls).toHaveLength(1);
        expect(voices.map((voice) => voice.id)).toEqual([VOICE_ALPHA, VOICE_BETA]);
    });

    test("forceFreshVoices bypasses that cache", async () => {
        stub = stubElevenLabs();
        await new AIElevenLabsTextToSpeechProvider({ apiKey: FIXTURE_KEY }).listVoices();

        await new AIElevenLabsTextToSpeechProvider({ apiKey: FIXTURE_KEY, forceFreshVoices: true }).listVoices();

        expect(stub.calls).toHaveLength(2);
    });
});

describe("AIElevenLabsTranscriptionProvider", () => {
    test("posts a multipart Scribe request carrying the model and the diarize flag", async () => {
        stub = stubFetch(() => Response.json({ text: "hello there", language_code: "eng", words: [] }));
        const provider = new AIElevenLabsTranscriptionProvider({ apiKey: FIXTURE_KEY });

        const result = await provider.transcribe(Buffer.from("RIFFfake"), { diarize: true, language: "en" });

        const call = stub.calls[0];
        expect(call?.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
        expect(headerOf(call?.init, "xi-api-key")).toBe(FIXTURE_KEY);

        const body = call?.init?.body;
        if (!(body instanceof FormData)) {
            throw new Error("expected a multipart body");
        }

        expect(body.get("model_id")).toBe("scribe_v1");
        expect(body.get("diarize")).toBe("true");
        expect(body.get("language_code")).toBe("en");
        expect(result.text).toBe("hello there");
        expect(result.language).toBe("eng");
    });

    test("spacing entries never become empty segments", async () => {
        stub = stubFetch(() =>
            Response.json({
                text: "one two",
                words: [
                    { text: "one", type: "word", start: 0, end: 0.4 },
                    { text: " ", type: "spacing", start: 0.4, end: 0.45 },
                    { text: "two", type: "word", start: 0.45, end: 0.9 },
                ],
            })
        );
        const provider = new AIElevenLabsTranscriptionProvider({ apiKey: FIXTURE_KEY });

        const result = await provider.transcribe(Buffer.from("RIFFfake"));

        expect(result.segments).toEqual([
            { text: "one", start: 0, end: 0.4 },
            { text: "two", start: 0.45, end: 0.9 },
        ]);
    });
});

describe("the elevenlabs plugin", () => {
    test("registers through the barrel and declares the variable it will read", () => {
        _resetBuiltInPluginsForTest();
        registerBuiltInPlugins();

        expect(elevenLabsPlugin.id).toBe("elevenlabs");
        expect(elevenLabsPlugin.kind).toBe("api-key");
        expect(elevenLabsPlugin.credential.envKeys).toEqual(["ELEVENLABS_API_KEY"]);
        expect(elevenLabsPlugin.credential.required).toContain("apiKey");
        expect([...elevenLabsPlugin.capabilities].sort()).toEqual(["realtime", "transcribe", "tts"]);
    });

    test("the speech engine table can build an elevenlabs engine", () => {
        expect(speechEngineIds()).toContain("elevenlabs");
        expect(speechEngineFor("elevenlabs")?.type).toBe("elevenlabs");
    });

    test("the environment is read only for an account that opted in", async () => {
        env.testing.set("ELEVENLABS_API_KEY", FIXTURE_KEY);

        const optedIn = await resolveCredential(
            account({ useEnvApiKey: ["ELEVENLABS_API_KEY"] }),
            elevenLabsPlugin.credential
        );

        expect(optedIn.apiKey).toBe(FIXTURE_KEY);
        expect(optedIn.source).toBe("env");
        expect(optedIn.envKey).toBe("ELEVENLABS_API_KEY");
    });

    // The negative control: the same variable, the same spec, an account that did
    // not opt in. Without this, a resolver that ignored `useEnvApiKey` entirely
    // would pass the test above.
    test("an account without the opt-in gets no key from the environment", async () => {
        env.testing.set("ELEVENLABS_API_KEY", FIXTURE_KEY);

        await expect(resolveCredential(account(), elevenLabsPlugin.credential)).rejects.toThrow(
            CredentialUnavailableError
        );
    });

    test("binding: speech and transcription exist, and chat says why it cannot", async () => {
        env.testing.set("ELEVENLABS_API_KEY", FIXTURE_KEY);

        const binding = await elevenLabsPlugin.bind({ account: account({ useEnvApiKey: true }) });

        expect(binding.providerId).toBe("elevenlabs");
        expect(binding.accountId).toBe("acc_voice");
        expect(binding.billed).toBe(true);
        expect(asSpeechV3(binding.speech?.("eleven_multilingual_v2")).provider).toBe("elevenlabs");
        expect(asTranscriptionV3(binding.transcription?.("scribe_v1")).modelId).toBe("scribe_v1");
        expect(() => binding.language("gpt-4o")).toThrow(/no chat models/);
    });

    test("the binding's speech model carries the account's key, not a second lookup", async () => {
        stub = stubElevenLabs();
        env.testing.set("ELEVENLABS_API_KEY", FIXTURE_KEY);

        const binding = await elevenLabsPlugin.bind({ account: account({ useEnvApiKey: true }) });
        const model = asSpeechV3(binding.speech?.("eleven_multilingual_v2"));
        await model.doGenerate({ text: "bound", voice: VOICE_ALPHA });

        const speech = stub.calls.find((call) => call.url.includes("/v1/text-to-speech/"));
        expect(headerOf(speech?.init, "xi-api-key")).toBe(FIXTURE_KEY);
    });
});
