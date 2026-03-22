import { toFloat32Audio } from "@app/utils/audio/converter";

// ============================================
// Types
// ============================================

export interface LanguageDetectionResult {
    /** ISO 639-1 code (e.g. "cs", "en", "de") or ISO 639-3 for MMS (e.g. "ces") */
    language: string;
    /** 0–1 confidence score */
    confidence: number;
    /** Which driver produced this result */
    driver: string;
    /** Top-k alternative languages with probabilities (if available from the driver) */
    alternatives?: Array<{ language: string; confidence: number }>;
}

export interface LanguageDetectionDriver {
    readonly name: string;
    detectFromAudio(audio: Float32Array): Promise<LanguageDetectionResult>;
    isAvailable(): Promise<boolean>;
    dispose?(): void;
}

export interface TextLanguageDetectionDriver {
    readonly name: string;
    detectFromText(text: string): Promise<LanguageDetectionResult>;
    isAvailable(): Promise<boolean>;
}

// ============================================
// LanguageDetector
// ============================================

export class LanguageDetector {
    private audioDrivers: LanguageDetectionDriver[] = [];
    private textDrivers: TextLanguageDetectionDriver[] = [];

    registerAudioDriver(driver: LanguageDetectionDriver): this {
        this.audioDrivers.push(driver);
        return this;
    }

    registerTextDriver(driver: TextLanguageDetectionDriver): this {
        this.textDrivers.push(driver);
        return this;
    }

    async detectFromAudio(input: Buffer | Float32Array): Promise<LanguageDetectionResult> {
        const audio = input instanceof Float32Array ? input : await toFloat32Audio(input);

        for (const driver of this.audioDrivers) {
            if (!(await driver.isAvailable())) {
                continue;
            }

            try {
                return await driver.detectFromAudio(audio);
            } catch {
                // Try next driver
            }
        }

        return { language: "en", confidence: 0, driver: "fallback" };
    }

    async detectFromText(text: string): Promise<LanguageDetectionResult> {
        for (const driver of this.textDrivers) {
            if (!(await driver.isAvailable())) {
                continue;
            }

            try {
                return await driver.detectFromText(text);
            } catch {
                // Try next driver
            }
        }

        return { language: "en", confidence: 0, driver: "fallback" };
    }

    dispose(): void {
        for (const driver of this.audioDrivers) {
            driver.dispose?.();
        }
    }
}

// ============================================
// Drivers
// ============================================

/**
 * Whisper 1-token decode: uses Whisper's encoder to predict the language token.
 * Reuses the same model architecture, no extra download if using whisper-small.
 * For faster detection, use whisper-tiny (8.6 MB encoder).
 */
export class WhisperLanguageDriver implements LanguageDetectionDriver {
    readonly name = "whisper";
    private model: string;
    private whisperModel: {
        generate: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
        generation_config: Record<string, unknown>;
    } | null = null;
    private processor: ((audio: Float32Array) => Promise<Record<string, unknown>>) | null = null;

    constructor(model = "onnx-community/whisper-tiny") {
        this.model = model;
    }

    async isAvailable(): Promise<boolean> {
        return true;
    }

    async detectFromAudio(audio: Float32Array): Promise<LanguageDetectionResult> {
        await this.ensureLoaded();

        // Use first 30s max
        const clip = audio.length > 480_000 ? audio.slice(0, 480_000) : audio;
        const inputs = await this.processor!(clip);

        const genConfig = this.whisperModel!.generation_config;
        const sotId = genConfig.decoder_start_token_id as number;
        const langToId = genConfig.lang_to_id as Record<string, number> | undefined;

        const output = await this.whisperModel!.generate({
            ...inputs,
            decoder_input_ids: [[sotId]],
            max_new_tokens: 1,
            output_scores: true,
            return_dict_in_generate: true,
        });

        // Extract top-k language probabilities from scores (logits)
        const alternatives = this.extractTopKLanguages(output, langToId);

        if (alternatives && alternatives.length > 0) {
            return {
                language: alternatives[0].language,
                confidence: alternatives[0].confidence,
                driver: this.name,
                alternatives,
            };
        }

        // Fallback: use the generated token ID directly
        const sequences = output.sequences ?? output;
        const rawData = (sequences as { data: ArrayLike<number | bigint> }).data;
        const langTokenId = Number(rawData[rawData.length - 1]);

        if (langToId) {
            for (const [token, id] of Object.entries(langToId)) {
                if (id === langTokenId) {
                    const code = token.replace(/<\||\|>/g, "");
                    return { language: code, confidence: 0.8, driver: this.name };
                }
            }
        }

        return { language: "en", confidence: 0.5, driver: this.name };
    }

    private extractTopKLanguages(
        output: Record<string, unknown>,
        langToId: Record<string, number> | undefined,
        topK = 5,
    ): Array<{ language: string; confidence: number }> | null {
        if (!langToId) {
            return null;
        }

        // output.scores is an array of logit tensors, one per generated token
        const scores = output.scores as Array<{ data: Float32Array }> | undefined;

        if (!scores || scores.length === 0) {
            return null;
        }

        const logits = scores[0].data;

        if (!logits) {
            return null;
        }

        // Build language entries with their logit values
        const entries: Array<{ language: string; logit: number }> = [];

        for (const [token, id] of Object.entries(langToId)) {
            const code = token.replace(/<\||\|>/g, "");

            if (id < logits.length) {
                entries.push({ language: code, logit: logits[id] });
            }
        }

        if (entries.length === 0) {
            return null;
        }

        // Softmax over language logits only
        const maxLogit = Math.max(...entries.map((e) => e.logit));
        const exps = entries.map((e) => ({ language: e.language, exp: Math.exp(e.logit - maxLogit) }));
        const sumExp = exps.reduce((sum, e) => sum + e.exp, 0);

        const probabilities = exps
            .map((e) => ({ language: e.language, confidence: e.exp / sumExp }))
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, topK);

        return probabilities;
    }

    private async ensureLoaded(): Promise<void> {
        if (this.whisperModel && this.processor) {
            return;
        }

        const { AutoProcessor, WhisperForConditionalGeneration } = await import("@huggingface/transformers");
        this.processor = (await AutoProcessor.from_pretrained(this.model)) as unknown as typeof this.processor;
        this.whisperModel = (await WhisperForConditionalGeneration.from_pretrained(this.model, {
            dtype: "q4",
        })) as unknown as typeof this.whisperModel;
    }

    dispose(): void {
        this.whisperModel = null;
        this.processor = null;
    }
}

/**
 * MMS-LID: Facebook's Massively Multilingual Speech Language Identification.
 * 126 languages, high accuracy. Uses ISO 639-3 codes (ces, deu, eng, slk).
 * Warning: ~580 MB model download.
 */
export class MmsLidDriver implements LanguageDetectionDriver {
    readonly name = "mms-lid";
    private model: string;
    private pipeline:
        | ((audio: Float32Array, opts?: Record<string, unknown>) => Promise<Array<{ label: string; score: number }>>)
        | null = null;

    constructor(model = "Xenova/mms-lid-126") {
        this.model = model;
    }

    async isAvailable(): Promise<boolean> {
        return true;
    }

    async detectFromAudio(audio: Float32Array): Promise<LanguageDetectionResult> {
        await this.ensureLoaded();

        // Use first 10s for speed
        const clip = audio.length > 160_000 ? audio.slice(0, 160_000) : audio;
        const results = await this.pipeline!(clip, { topk: 1 });

        if (results.length > 0) {
            return {
                language: iso3toIso1(results[0].label),
                confidence: results[0].score,
                driver: this.name,
            };
        }

        return { language: "en", confidence: 0, driver: this.name };
    }

    private async ensureLoaded(): Promise<void> {
        if (this.pipeline) {
            return;
        }

        const { pipeline } = await import("@huggingface/transformers");
        this.pipeline = (await pipeline("audio-classification", this.model, {
            dtype: "fp32",
        })) as unknown as typeof this.pipeline;
    }

    dispose(): void {
        this.pipeline = null;
    }
}

/**
 * Hybrid: transcribe a short clip with a candidate language,
 * then verify with text-based language detection.
 * Requires a transcribe function and a text detection driver.
 */
export class HybridDriver implements LanguageDetectionDriver {
    readonly name = "hybrid";
    private candidateLanguages: string[];
    private transcribeFn: (audio: Float32Array, lang: string) => Promise<string>;
    private textDetector: TextLanguageDetectionDriver;

    constructor(opts: {
        candidates: string[];
        transcribe: (audio: Float32Array, lang: string) => Promise<string>;
        textDetector: TextLanguageDetectionDriver;
    }) {
        this.candidateLanguages = opts.candidates;
        this.transcribeFn = opts.transcribe;
        this.textDetector = opts.textDetector;
    }

    async isAvailable(): Promise<boolean> {
        return this.textDetector.isAvailable();
    }

    async detectFromAudio(audio: Float32Array): Promise<LanguageDetectionResult> {
        // Use first 5s
        const clip = audio.length > 80_000 ? audio.slice(0, 80_000) : audio;

        let best: LanguageDetectionResult = { language: "en", confidence: 0, driver: this.name };

        for (const lang of this.candidateLanguages) {
            try {
                const text = await this.transcribeFn(clip, lang);

                // Skip garbage output
                if (text.includes("(speaking") || text.length < 10) {
                    continue;
                }

                const detected = await this.textDetector.detectFromText(text);

                // Language of transcription matches the candidate → strong signal
                if (detected.language === lang && detected.confidence > best.confidence) {
                    best = { language: lang, confidence: detected.confidence, driver: this.name };
                }
            } catch {
                // Try next candidate
            }
        }

        return best;
    }
}

/**
 * DarwinKit NLLanguageRecognizer: text-based language detection via macOS native API.
 */
export class DarwinKitTextDriver implements TextLanguageDetectionDriver {
    readonly name = "darwinkit";

    async isAvailable(): Promise<boolean> {
        try {
            const { getDarwinKit } = await import("@app/utils/macos/darwinkit");
            const dk = getDarwinKit();
            return dk !== null;
        } catch {
            return false;
        }
    }

    async detectFromText(text: string): Promise<LanguageDetectionResult> {
        const { detectLanguage } = await import("@app/utils/macos/nlp");
        const result = await detectLanguage(text);
        return { language: result.language, confidence: result.confidence, driver: this.name };
    }
}

// ============================================
// Factory
// ============================================

export interface LanguageDetectorOptions {
    /** Audio drivers in priority order. Default: ["whisper"] */
    audioDrivers?: Array<"whisper" | "mms-lid" | LanguageDetectionDriver>;
    /** Text drivers in priority order. Default: ["darwinkit"] */
    textDrivers?: Array<"darwinkit" | TextLanguageDetectionDriver>;
    /** Whisper model for detection. Default: "onnx-community/whisper-tiny" */
    whisperModel?: string;
    /** MMS-LID model. Default: "Xenova/mms-lid-126" */
    mmsModel?: string;
}

/**
 * Create a pre-configured LanguageDetector with all available drivers.
 * Audio drivers: whisper-tiny (default)
 * Text drivers: darwinkit (default)
 */
export function createLanguageDetector(options?: LanguageDetectorOptions): LanguageDetector {
    const detector = new LanguageDetector();

    const audioDriverNames = options?.audioDrivers ?? ["whisper"];
    const textDriverNames = options?.textDrivers ?? ["darwinkit"];
    const whisperModel = options?.whisperModel ?? "onnx-community/whisper-tiny";
    const mmsModel = options?.mmsModel ?? "Xenova/mms-lid-126";

    for (const driver of audioDriverNames) {
        if (typeof driver === "string") {
            switch (driver) {
                case "whisper":
                    detector.registerAudioDriver(new WhisperLanguageDriver(whisperModel));
                    break;
                case "mms-lid":
                    detector.registerAudioDriver(new MmsLidDriver(mmsModel));
                    break;
            }
        } else {
            detector.registerAudioDriver(driver);
        }
    }

    for (const driver of textDriverNames) {
        if (typeof driver === "string") {
            switch (driver) {
                case "darwinkit":
                    detector.registerTextDriver(new DarwinKitTextDriver());
                    break;
            }
        } else {
            detector.registerTextDriver(driver);
        }
    }

    return detector;
}

// ============================================
// ISO 639-3 → ISO 639-1 mapping (common languages)
// ============================================

const ISO3_TO_ISO1: Record<string, string> = {
    ces: "cs",
    slk: "sk",
    deu: "de",
    eng: "en",
    fra: "fr",
    spa: "es",
    ita: "it",
    pol: "pl",
    por: "pt",
    nld: "nl",
    rus: "ru",
    ukr: "uk",
    hun: "hu",
    ron: "ro",
    bul: "bg",
    hrv: "hr",
    srp: "sr",
    slv: "sl",
    tur: "tr",
    ara: "ar",
    zho: "zh",
    jpn: "ja",
    kor: "ko",
    hin: "hi",
    vie: "vi",
    tha: "th",
    ind: "id",
    swe: "sv",
    nor: "no",
    dan: "da",
    fin: "fi",
    ell: "el",
    heb: "he",
    kat: "ka",
    lit: "lt",
    lav: "lv",
    est: "et",
};

function iso3toIso1(code: string): string {
    return ISO3_TO_ISO1[code] ?? code;
}
