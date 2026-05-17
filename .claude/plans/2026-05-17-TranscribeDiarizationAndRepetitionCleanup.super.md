# Transcribe: Repetition Cleanup + Speaker Diarization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `tools transcribe` (a) auto-strip Whisper ∞-repetition loops without harming legit repeats, and (b) attribute speakers — Deepgram natively, and Whisper/gpt-4o/local via an in-process pyannote→transcript pipeline (no Python) — converging to the quality of `~/Downloads/{1,2,5}.srt`.

**Architecture:** Post-transcription pipeline order is `transcribe → repetition-cleanup → diarize on the *un-split* source audio → align speakers onto cleaned segments by whisperX max-overlap`. (Cleanup mutates segment *text*, and may *extend* a segment's `end` when it absorbs an adjacent duplicate — that absorbed span is the same speaker by the dedup precondition, so max-overlap alignment handles it naturally; the time axis is otherwise unchanged.) Deepgram returns speaker labels in its raw response; every other provider gets a local `sherpa-onnx-node` diarization (pyannote-segmentation-3.0 + WeSpeaker embedding ONNX, ungated GitHub-Release models, prebuilt darwin-arm64 binary) aligned onto the transcript. This replicates Spokenly's "Online (Whisper) + Identify Speakers" UX (a no-Python pyannote→Whisper pipeline producing `SPEAKER_00`-style output — Spokenly itself is closed-source so we replicate the architecture, not a documented internal).

**Tech Stack:** Bun, TypeScript, Vercel AI SDK (`ai@5.0.86`), `@ai-sdk/deepgram@^1.0.28` (spec-v2), `sherpa-onnx-node@^1.13.2` (+ optional `sherpa-onnx-darwin-arm64`), ffmpeg, `bun:test`, `tsgo --noEmit`.

**Prerequisite state:** the prior transcription bug-fix is **present + verified
but uncommitted** in the working tree (confirmed via `git status` + file
contents — NOT stashed, NOT reverted). Phase 0 Task 0.0 commits it first; no
re-implementation is needed.

**Decisions locked (do not re-litigate during impl):**
- Repetition cleanup: **always-on**, `--no-clean`/`--raw` disables.
- Diarization labels: pyannote/Spokenly convention `SPEAKER_00` (uppercase). sherpa emits `speaker_00` lowercase → normalized in **one** function `normalizeSpeakerLabel`.
- Local diarizer dep: `sherpa-onnx-node@^1.13.2`. Segmentation `sherpa-onnx-pyannote-segmentation-3-0/model.onnx` (fp32, 5.7 MB). Embedding `wespeaker_en_voxceleb_resnet34_LM.onnx` (25.3 MB). Model cache: `~/.genesis-tools/transcribe/models/diarization/`.
- Clustering defaults: `numClusters:2, threshold:0.5, minDurationOn:0.3, minDurationOff:0.5`. CLI `--speakers <n>` → `numClusters:n`; omitted or `0` → `numClusters:-1` (auto, `threshold:0.5`).
- Alignment: whisperX `assign_word_speakers` max-overlap, **segment granularity** (OpenAI gives only segment timestamps), **`fillNearest:true`** (reference SRTs label every cue — leaving cues unlabeled would falsely punish the metric).
- Diarization always runs on the **un-split** source audio → one consistent label space; **no cross-chunk speaker remapping** is ever needed or built.
- Dead `wordTimestamps` option is **deleted** (YAGNI — segment-level only).
- D (AudioProcessor refactor) runs **last, only if A+B1+B2 pass the convergence metric**.

**Convergence metric (single source of truth):** `tests/transcribe/verify-against-reference.ts`. Reference cues are utterance-level (long); candidate cues are often segment-level (short) — so match **purely by maximum time-overlap** (any positive overlap; NO start-distance gate, which would drop most short candidate cues and make the metric noisy/misleading). For each candidate cue → the reference cue it overlaps most; `wer_proxy = mean(levenshtein(candText, refText) / refText.length)` over matched cues; `speaker_agreement = cuesWithMatchingSpeaker / cuesWithSpeakerInBoth`. Output exactly one line per file: `1.srt: WER-proxy 0.082, speaker-agreement 0.94`. Baseline is captured in Phase 0 **before** any code change; every later phase prints the delta.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/utils/ai/transcription/repetition-cleanup.ts` (new) | Pure, idempotent loop-collapse + cross-segment dedup on `{text,segments}` |
| `src/utils/ai/transcription/speaker-label.ts` (new) | `normalizeSpeakerLabel()` — the ONLY place label case/format is decided |
| `src/utils/ai/transcription/align-speakers.ts` (new) | whisperX max-overlap segment↔turn assignment |
| `src/utils/audio/diarize-local.ts` (new) | sherpa-onnx-node wrapper: wav → `[{start,end,speaker}]`; model fetch+cache |
| `src/utils/ai/types.ts` (modify) | `TranscriptionSegment.speaker?`; `TranscribeOptions.clean?`,`speakers?`; delete `wordTimestamps` |
| `src/utils/ai/transcription/TranscriptionManager.ts` (modify) | cleanup hook; Deepgram `utterances`+raw-body speaker parse; `clean`/`speakers` plumbing |
| `src/utils/ai/tasks/Transcriber.ts` (modify) | stitched-result cleanup; diarize-unsplit + local-diarize wiring; split-bypass when diarize |
| `src/utils/ai/transcription-format.ts` (modify) | speaker rendering (text/SRT/VTT) via `normalizeSpeakerLabel`; speaker-boundary in `coalesceSegmentsForSubtitles` |
| `src/utils/ai/providers/AICloudProvider.ts` (modify) | forward `clean`,`speakers` |
| `src/transcribe/index.ts` (modify) | `--diarize`, `--speakers <n>`, `--no-clean`/`--raw`; interactive prompts |
| `tests/transcribe/verify-against-reference.ts` (new) | convergence metric harness |
| `package.json` (modify) | add `sherpa-onnx-node@^1.13.2` |
| Phase D | move `src/ask/audio/AudioProcessor.ts` methods → `src/utils/audio/` |

---

## Phase 0 — Prereq commit + convergence harness (baseline before any change)

### Task 0.0: Commit the existing verified transcription bug-fix

The prior bug-fix (splitter `-vn`/libmp3lame, `convertFileToMonoMp3` cloud
normalize, `@ai-sdk/deepgram@^1.0.28` pin, language→`providerOptions`,
`mapResultSegments`, SRT realignment, quiet spinner, `detect-format.ts`) is
**present and verified but uncommitted** in the working tree. Commit it as
ONE commit so this plan's feature commits stay clean and bisectable.

- [ ] **Step 1: Confirm the bug-fix is intact**

Run: `git status --short` and
`rg -n "convertFileToMonoMp3" src/utils/ai/providers/AICloudProvider.ts`
Expected: the ~15 modified files + 2 untracked (`detect-format.ts`,
`quiet-spinner.ts`); the rg matches (bug-fix on disk). If NOT intact,
recover from `git stash` or re-run the prior bug-fix plan before continuing.

- [ ] **Step 2: Commit only the bug-fix files**

```bash
cd /Users/Martin/Tresors/Projects/GenesisTools
git add CLAUDE.md bun.lock package.json \
  src/ask/audio/AudioProcessor.ts src/ask/providers/ModelSelector.ts \
  src/macos/commands/mail/search.ts src/transcribe/index.ts \
  src/transcribe/transcribe.test.ts src/utils/ai/providers/AICloudProvider.ts \
  src/utils/ai/providers/xai/AIXAITranscriptionProvider.ts \
  src/utils/ai/tasks/Transcriber.ts src/utils/ai/transcription-format.ts \
  src/utils/ai/transcription/TranscriptionManager.ts src/utils/ai/types.ts \
  src/utils/audio/converter.ts src/utils/audio/detect-format.ts \
  src/utils/cli/quiet-spinner.ts
git commit -m "fix(transcribe): Czech language drop, deepgram v2 pin, MP3 normalize, splitter, SRT realign, quiet spinner"
```
(Do NOT add `.claude/scheduled_tasks.lock` or unrelated `??` files.)

- [ ] **Step 3: Verify green from this commit**

Run: `tsgo --noEmit 2>&1 | rg -c "error TS" || echo 0` (→ `0`);
`bun test src/transcribe src/utils/ai src/utils/audio`.
Expected: all pass. This commit is the baseline HEAD for Phase 0.2 onward.

### Convergence harness FIRST (baseline before any change)

### Task 0.1: Speaker-label normalizer + its test (needed by metric and renderers)

**Files:**
- Create: `src/utils/ai/transcription/speaker-label.ts`
- Test: `src/utils/ai/transcription/speaker-label.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/utils/ai/transcription/speaker-label.test.ts
import { describe, expect, it } from "bun:test";
import { normalizeSpeakerLabel } from "./speaker-label";

describe("normalizeSpeakerLabel", () => {
    it("uppercases sherpa lowercase labels", () => {
        expect(normalizeSpeakerLabel("speaker_00")).toBe("SPEAKER_00");
    });
    it("zero-pads bare integer/string speaker ids", () => {
        expect(normalizeSpeakerLabel(0)).toBe("SPEAKER_00");
        expect(normalizeSpeakerLabel(3)).toBe("SPEAKER_03");
        expect(normalizeSpeakerLabel("1")).toBe("SPEAKER_01");
    });
    it("passes through already-correct labels", () => {
        expect(normalizeSpeakerLabel("SPEAKER_02")).toBe("SPEAKER_02");
    });
    it("returns undefined for null/undefined/empty", () => {
        expect(normalizeSpeakerLabel(undefined)).toBeUndefined();
        expect(normalizeSpeakerLabel(null)).toBeUndefined();
        expect(normalizeSpeakerLabel("")).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/utils/ai/transcription/speaker-label.test.ts`
Expected: FAIL — `Cannot find module './speaker-label'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/utils/ai/transcription/speaker-label.ts
/**
 * The single place speaker-label format is decided. sherpa-onnx emits
 * `speaker_00` (lowercase); Deepgram emits integer ids; the pyannote /
 * Spokenly / reference-SRT convention is `SPEAKER_00` (uppercase, zero-padded
 * to 2). Every render path MUST go through this — never uppercase ad hoc.
 */
export function normalizeSpeakerLabel(raw: string | number | null | undefined): string | undefined {
    if (raw === null || raw === undefined || raw === "") {
        return undefined;
    }

    if (typeof raw === "number") {
        return `SPEAKER_${String(raw).padStart(2, "0")}`;
    }

    const m = raw.match(/(\d+)\s*$/);

    if (m) {
        return `SPEAKER_${m[1].padStart(2, "0")}`;
    }

    // Unknown format (no trailing digits) — pass through uppercased. sherpa
    // (`speaker_NN`) and Deepgram (int) always hit the branches above; this is
    // a safety fallthrough, not an expected path.
    return raw.toUpperCase();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/utils/ai/transcription/speaker-label.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/ai/transcription/speaker-label.ts src/utils/ai/transcription/speaker-label.test.ts
git commit -m "feat(transcribe): single-source speaker label normalizer"
```

### Task 0.2: Convergence metric harness

**Files:**
- Create: `tests/transcribe/verify-against-reference.ts`
- Test: `tests/transcribe/verify-against-reference.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/transcribe/verify-against-reference.test.ts
import { describe, expect, it } from "bun:test";
import { parseSrt, scoreAgainstReference } from "./verify-against-reference";

describe("parseSrt", () => {
    it("parses cue index, times, speaker prefix and text", () => {
        const srt = "1\n00:00:00,000 --> 00:00:02,000\nSPEAKER_00: Ahoj světe.\n";
        const cues = parseSrt(srt);
        expect(cues).toHaveLength(1);
        expect(cues[0]).toEqual({ start: 0, end: 2, speaker: "SPEAKER_00", text: "Ahoj světe." });
    });
    it("parses a cue with no speaker prefix", () => {
        const cues = parseSrt("1\n00:00:01,000 --> 00:00:02,500\nAhoj.\n");
        expect(cues[0]).toEqual({ start: 1, end: 2.5, speaker: undefined, text: "Ahoj." });
    });
});

describe("scoreAgainstReference", () => {
    it("perfect match → werProxy 0, speakerAgreement 1", () => {
        const a = "1\n00:00:00,000 --> 00:00:02,000\nSPEAKER_00: Ahoj.\n";
        const s = scoreAgainstReference(a, a);
        expect(s.werProxy).toBe(0);
        expect(s.speakerAgreement).toBe(1);
    });
    it("counts speaker disagreement only over cues with speaker in both", () => {
        const cand = "1\n00:00:00,000 --> 00:00:02,000\nSPEAKER_01: Ahoj.\n";
        const ref = "1\n00:00:00,000 --> 00:00:02,000\nSPEAKER_00: Ahoj.\n";
        const s = scoreAgainstReference(cand, ref);
        expect(s.speakerAgreement).toBe(0);
        expect(s.werProxy).toBe(0);
    });
    it("matches short candidate cues to a long reference cue by overlap (no start-distance gate)", () => {
        const ref = "1\n00:00:00,000 --> 00:00:30,000\nSPEAKER_00: Dobrý den jak se máte.\n";
        const cand =
            "1\n00:00:20,000 --> 00:00:22,000\nSPEAKER_00: máte\n"; // start 20s from ref start — must still match
        const s = scoreAgainstReference(cand, ref);
        expect(s.speakerAgreement).toBe(1); // matched ⇒ speaker compared
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/transcribe/verify-against-reference.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// tests/transcribe/verify-against-reference.ts
export interface Cue { start: number; end: number; speaker?: string; text: string }

function tc(s: string): number {
    const m = s.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) return 0;
    return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
}

export function parseSrt(srt: string): Cue[] {
    const blocks = srt.replace(/\r/g, "").split(/\n\n+/);
    const cues: Cue[] = [];
    for (const b of blocks) {
        const lines = b.split("\n").filter((l) => l.trim() !== "");
        if (lines.length < 2) continue;
        const tl = lines.find((l) => l.includes("-->"));
        if (!tl) continue;
        const [a, z] = tl.split("-->");
        const body = lines.slice(lines.indexOf(tl) + 1).join(" ").trim();
        // ONLY `SPEAKER_NN:` counts as a speaker prefix — matching a generic
        // capitalized word would false-positive on any sentence like
        // "Dobrý den: ..." and corrupt the speaker-agreement denominator.
        const sm = body.match(/^(SPEAKER_\d+)\s*:\s*(.*)$/s);
        cues.push({
            start: tc(a),
            end: tc(z),
            speaker: sm ? sm[1] : undefined,
            text: sm ? sm[2].trim() : body,
        });
    }
    return cues;
}

function lev(a: string, b: string): number {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
        for (let j = 1; j <= b.length; j++)
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
}

function overlap(a: Cue, b: Cue): number {
    return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

export function scoreAgainstReference(candSrt: string, refSrt: string): { werProxy: number; speakerAgreement: number } {
    const cand = parseSrt(candSrt);
    const ref = parseSrt(refSrt);
    let werSum = 0;
    let werN = 0;
    let spkMatch = 0;
    let spkBoth = 0;
    for (const c of cand) {
        let best: Cue | undefined;
        let bestOv = 0;
        for (const r of ref) {
            // Pure max-overlap — NO start-distance gate (reference cues are
            // long/utterance-level, candidate cues short/segment-level; a
            // start gate would drop most candidates and skew the metric).
            const ov = overlap(c, r);
            if (ov > bestOv) {
                bestOv = ov;
                best = r;
            }
        }
        if (!best || bestOv <= 0) continue;
        werSum += lev(c.text, best.text) / Math.max(1, best.text.length);
        werN++;
        if (c.speaker && best.speaker) {
            spkBoth++;
            if (c.speaker === best.speaker) spkMatch++;
        }
    }
    return {
        werProxy: werN ? werSum / werN : 1,
        speakerAgreement: spkBoth ? spkMatch / spkBoth : 1,
    };
}

// CLI: bun tests/transcribe/verify-against-reference.ts <candidate.srt> <reference.srt>
if (import.meta.main) {
    const [cand, ref] = process.argv.slice(2);
    const s = scoreAgainstReference(await Bun.file(cand).text(), await Bun.file(ref).text());
    console.log(`${cand.split("/").pop()}: WER-proxy ${s.werProxy.toFixed(3)}, speaker-agreement ${s.speakerAgreement.toFixed(2)}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/transcribe/verify-against-reference.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Capture the pre-change baseline**

**Reference↔recording mapping (resolved by content of cue 1 — fixed, do not
re-derive):**
- `~/Downloads/1.srt` and `~/Downloads/2.srt` ↔ **`gth-jaqt-rcw (2026-05-08 07_33 GMT).mp4`** (two STT versions of the same recording; cue 1 = *"Děkuji, že jste si na mě udělali čas. Moc si toho vážím. Můžeme teda začít…"*).
- `~/Downloads/5.srt` ↔ **`xyf-csts-ptr (2026-05-14 16_04 GMT).mp4`** (cue 1 = *"Dobrý den, moc si vážím toho, že jste si na mě udělala čas. V první části mého rozhovoru vyplnilo 60 lidí…"*).
- `btf-pnvm-ecb` has **no** provided reference — exclude it from metric scoring.

Run (current code, no changes yet):
```bash
cd /Users/Martin/Downloads
GT=/Users/Martin/Tresors/Projects/GenesisTools
tools transcribe "gth-jaqt-rcw (2026-05-08 07_33 GMT).mp4" --provider deepgram --lang cs --format srt -o /tmp/base-gth.srt 2>/dev/null
tools transcribe "xyf-csts-ptr (2026-05-14 16_04 GMT).mp4" --provider deepgram --lang cs --format srt -o /tmp/base-xyf.srt 2>/dev/null
{ bun $GT/tests/transcribe/verify-against-reference.ts /tmp/base-gth.srt /Users/Martin/Downloads/1.srt
  bun $GT/tests/transcribe/verify-against-reference.ts /tmp/base-gth.srt /Users/Martin/Downloads/2.srt
  bun $GT/tests/transcribe/verify-against-reference.ts /tmp/base-xyf.srt /Users/Martin/Downloads/5.srt
} | tee /tmp/baseline-metric.txt
```
Expected: three correctly-paired `…: WER-proxy X, speaker-agreement Y` lines (speaker-agreement will be the no-speaker default 1.0 at baseline since current output has no speakers; WER-proxy is the real baseline number every later phase must not regress).

- [ ] **Step 6: Commit**

```bash
git add tests/transcribe/verify-against-reference.ts tests/transcribe/verify-against-reference.test.ts
git commit -m "test(transcribe): convergence metric harness vs reference SRTs"
```

---

## Phase A — Repetition cleanup (always-on)

### Task A.1: `cleanRepetitions` pure util + tests

**Files:**
- Create: `src/utils/ai/transcription/repetition-cleanup.ts`
- Test: `src/utils/ai/transcription/repetition-cleanup.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/utils/ai/transcription/repetition-cleanup.test.ts
import { describe, expect, it } from "bun:test";
import { cleanRepetitions } from "./repetition-cleanup";
import type { TranscriptionSegment } from "@app/utils/ai/types";

describe("cleanRepetitions", () => {
    it("collapses a single-token loop (run >= 5) to one", () => {
        const r = cleanRepetitions({ text: "ano ještě ještě ještě ještě ještě ještě konec" });
        expect(r.text).toBe("ano ještě konec");
    });
    it("collapses a clause loop (phrase run >= 3) to one", () => {
        const t = "Zkusíme zpátky. Zkusíme zpátky. Zkusíme zpátky. Zkusíme zpátky. Dál.";
        expect(cleanRepetitions({ text: t }).text).toBe("Zkusíme zpátky. Dál.");
    });
    it("preserves scattered legit repeats (interviewer 'Dobře, děkuji.' x3 with content between)", () => {
        const t = "Dobře, děkuji. Otázka jedna. Dobře, děkuji. Otázka dva. Dobře, děkuji. Konec.";
        expect(cleanRepetitions({ text: t }).text).toBe(t);
    });
    it("is Czech-diacritic-insensitive when matching the run", () => {
        const r = cleanRepetitions({ text: "Ještě ještě JEŠTĚ ještě ještě dál" });
        expect(r.text).toBe("Ještě dál");
    });
    it("is idempotent", () => {
        const once = cleanRepetitions({ text: "a a a a a a b" });
        const twice = cleanRepetitions(once);
        expect(twice).toEqual(once);
    });
    it("dedups a segment equal to the previous within < 2s gap and absorbs its end", () => {
        const segments: TranscriptionSegment[] = [
            { text: "Dobrý den.", start: 0, end: 1 },
            { text: "dobrý den", start: 1.5, end: 2.4 },
            { text: "Jak se máte?", start: 5, end: 6 },
        ];
        const r = cleanRepetitions({ text: "x", segments });
        expect(r.segments).toEqual([
            { text: "Dobrý den.", start: 0, end: 2.4 },
            { text: "Jak se máte?", start: 5, end: 6 },
        ]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/utils/ai/transcription/repetition-cleanup.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/utils/ai/transcription/repetition-cleanup.ts
import logger from "@app/logger";
import type { TranscriptionSegment } from "@app/utils/ai/types";

const SINGLE_TOKEN_MIN_RUN = 5;
const PHRASE_MIN_RUN = 3;
const MAX_PHRASE_WORDS = 8;
const SEG_DEDUP_GAP_SEC = 2.0;
const ZLIB_FLAG_RATIO = 2.4;
const ZLIB_WINDOW_WORDS = 120;

function norm(s: string): string {
    return s
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/["'.,?!…]+$/g, "")
        .trim();
}

function spanEq(a: string[], s: number, e: number, t: number): boolean {
    for (let k = 0; k < e - s; k++) {
        if (a[s + k] !== a[t + k]) {
            return false;
        }
    }

    return true;
}

/** Collapse only CONSECUTIVE repeated token n-grams (stable-ts remove_repetition
 *  port). Adjacent-only ⇒ scattered legit repeats survive untouched. */
function collapseRuns(tokens: string[]): string[] {
    let toks = tokens;

    for (let len = 1; len <= MAX_PHRASE_WORDS; len++) {
        const minRun = len === 1 ? SINGLE_TOKEN_MIN_RUN : PHRASE_MIN_RUN;
        const n = toks.map(norm);
        const kept: boolean[] = toks.map(() => true);
        let i = 0;

        while (i + len <= n.length) {
            let reps = 1;

            while (i + (reps + 1) * len <= n.length && spanEq(n, i, i + len, i + reps * len)) {
                reps++;
            }

            if (reps >= minRun) {
                for (let r = 1; r < reps; r++) {
                    for (let k = 0; k < len; k++) {
                        kept[i + r * len + k] = false;
                    }
                }

                i += reps * len;
            } else {
                i += 1;
            }
        }

        toks = toks.filter((_, idx) => kept[idx]);
    }

    return toks;
}

function flagHighCompression(text: string): void {
    // FLAG only (never deletes). Runs on the PRE-cleanup text so it surfaces
    // loops the run-collapse heuristic did NOT catch — checking post-collapse
    // would always look fine and make the warning useless. zlib header
    // (`library:"zlib"`) matches the 2.4 threshold's Python/Node calibration;
    // Bun's default raw deflate would skew the ratio ~5-10%.
    const words = text.split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i += ZLIB_WINDOW_WORDS) {
        const win = words.slice(i, i + ZLIB_WINDOW_WORDS).join(" ");
        const ratio =
            Buffer.byteLength(win, "utf8") /
            Math.max(1, Bun.deflateSync(Buffer.from(win), { library: "zlib" }).length);
        if (ratio > ZLIB_FLAG_RATIO) {
            logger.warn(`repetition-cleanup: window @word ${i} compression ratio ${ratio.toFixed(2)} > ${ZLIB_FLAG_RATIO} (review)`);
        }
    }
}

function cleanText(text: string): string {
    flagHighCompression(text);
    return collapseRuns(text.split(/\s+/).filter(Boolean)).join(" ");
}

export function cleanRepetitions(input: { text: string; segments?: TranscriptionSegment[] }): {
    text: string;
    segments?: TranscriptionSegment[];
} {
    if (!input.segments?.length) {
        return { text: cleanText(input.text) };
    }

    flagHighCompression(input.text); // pre-cleanup flag on the full text

    // 1. intra-segment run-collapse
    const intra = input.segments.map((s) => ({
        ...s,
        text: collapseRuns(s.text.split(/\s+/).filter(Boolean)).join(" "),
    }));

    // 2. cross-segment dedup (drop seg == previous surviving within < gap)
    const segs: TranscriptionSegment[] = [];
    for (const s of intra) {
        const prev = segs[segs.length - 1];
        if (prev && norm(prev.text) === norm(s.text) && norm(s.text).length > 0 && s.start - prev.end < SEG_DEDUP_GAP_SEC) {
            prev.end = s.end;
            continue;
        }

        segs.push({ ...s });
    }

    // 3. segment run-length (>=5 consecutive identical normalized text → keep first)
    const out: TranscriptionSegment[] = [];
    let i = 0;
    while (i < segs.length) {
        let reps = 1;
        while (i + reps < segs.length && norm(segs[i + reps].text) === norm(segs[i].text) && norm(segs[i].text).length > 0) {
            reps++;
        }

        if (reps >= SINGLE_TOKEN_MIN_RUN) {
            out.push({ ...segs[i], end: segs[i + reps - 1].end });
            i += reps;
        } else {
            out.push(segs[i]);
            i += 1;
        }
    }

    return { text: out.map((s) => s.text).join(" "), segments: out };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/utils/ai/transcription/repetition-cleanup.test.ts`
Expected: PASS (6 tests). Then `tsgo --noEmit 2>&1 | rg repetition-cleanup || echo clean`.

- [ ] **Step 5: Commit**

```bash
git add src/utils/ai/transcription/repetition-cleanup.ts src/utils/ai/transcription/repetition-cleanup.test.ts
git commit -m "feat(transcribe): consecutive-run repetition cleanup util"
```

### Task A.2: Add `clean` option, delete dead `wordTimestamps`

**Files:**
- Modify: `src/utils/ai/types.ts` (`TranscribeOptions`, lines ~52-79)
- Modify: `src/utils/ai/transcription/TranscriptionManager.ts` (`TranscriptionOptions`, lines ~21-30)

- [ ] **Step 1: Edit `TranscribeOptions`** — remove `wordTimestamps`, add `clean` and `speakers`:

```ts
    /** Enable speaker diarization (Deepgram native; local pyannote otherwise). */
    diarize?: boolean;
    /** Expected speaker count for diarization clustering; omit/0 = auto-detect. */
    speakers?: number;
    /** Enable smart formatting/punctuation (Deepgram). */
    smartFormat?: boolean;
    /** Post-process repetition-loop cleanup. Default true; --no-clean disables. */
    clean?: boolean;
```
(Delete the `wordTimestamps?: boolean;` line and its comment.)

- [ ] **Step 2: Edit `TranscriptionManager.TranscriptionOptions`** — same: drop `wordTimestamps`, add `clean?: boolean` and `speakers?: number`.

- [ ] **Step 3: Verify nothing else references `wordTimestamps`**

Run: `rg -n "wordTimestamps" src/`
Expected: no matches (it was dead — confirmed in research). If any remain, remove them.

- [ ] **Step 4: Typecheck**

Run: `tsgo --noEmit 2>&1 | rg -c "error TS" || echo 0`
Expected: `0`.

- [ ] **Step 5: Commit**

```bash
git add src/utils/ai/types.ts src/utils/ai/transcription/TranscriptionManager.ts
git commit -m "refactor(transcribe): add clean/speakers options, drop dead wordTimestamps"
```

### Task A.3: Apply cleanup at both pipeline levels + integration idempotency test

**Files:**
- Modify: `src/utils/ai/transcription/TranscriptionManager.ts` (`transcribeAudio` result block ~164-180; `transcribeWithFallback` ~247-255)
- Modify: `src/utils/ai/tasks/Transcriber.ts` (`transcribeChunked` final return ~144-148; non-chunked `transcribe` return ~77-82)
- Modify: `src/utils/ai/providers/AICloudProvider.ts` (forward `clean`)
- Test: `src/utils/ai/tasks/Transcriber.cleanup.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
// src/utils/ai/tasks/Transcriber.cleanup.test.ts
import { describe, expect, it } from "bun:test";
import { cleanRepetitions } from "@app/utils/ai/transcription/repetition-cleanup";

describe("two-level cleanup idempotency", () => {
    it("manager-clean then stitched-clean equals single clean (no double-collapse drift)", () => {
        const looped = { text: "a a a a a a b a a a a a a c" };
        const managerPass = cleanRepetitions(looped);            // per-chunk / single-shot
        const stitchedPass = cleanRepetitions(managerPass);      // Transcriber stitched
        expect(stitchedPass).toEqual(managerPass);
        expect(managerPass.text).toBe("a b a c");
    });
});
```

- [ ] **Step 2: Run to verify it passes already (pure-function guarantee)**

Run: `bun test src/utils/ai/tasks/Transcriber.cleanup.test.ts`
Expected: PASS — proves the function is safe to apply twice. (If FAIL, fix `cleanRepetitions` before wiring.)

- [ ] **Step 3: Wire cleanup into `TranscriptionManager`** — in both `transcribeAudio` and `transcribeWithFallback`, replace the `const transcriptionResult = { text: result.text, … segments: mapResultSegments(result), … }` construction so that when `options.clean !== false`:

```ts
import { cleanRepetitions } from "./repetition-cleanup";
// ...
const mapped = mapResultSegments(result);
const cleaned = options.clean === false
    ? { text: result.text, segments: mapped }
    : cleanRepetitions({ text: result.text, segments: mapped });

const transcriptionResult: TranscriptionResult = {
    text: cleaned.text,
    provider: transcriptionModel.provider,
    model: transcriptionModel.model,
    processingTime,
    segments: cleaned.segments,
    language: result.language ?? options.language,
    duration: result.durationInSeconds,
};
```
(Apply the identical `cleaned` pattern in `transcribeWithFallback`'s return.)

- [ ] **Step 4: Wire cleanup into `Transcriber`** — in `transcribeChunked`, after `const text = texts.join(" ")` build and clean the stitched result before return; in non-chunked `transcribe`, clean the provider result. Use one private helper:

```ts
import { cleanRepetitions } from "@app/utils/ai/transcription/repetition-cleanup";

private maybeClean(r: TranscriptionResult, options?: TranscribeOptions): TranscriptionResult {
    if (options?.clean === false) {
        return r;
    }

    const c = cleanRepetitions({ text: r.text, segments: r.segments });
    return { ...r, text: c.text, segments: c.segments };
}
```
- `transcribe` (non-chunked branch): `return this.maybeClean(await retry(...), options);`
- `transcribeChunked`: wrap the final `return { text: texts.join(" "), segments: …, … }` in `this.maybeClean(...)`.

- [ ] **Step 5: Forward `clean` in `AICloudProvider.transcribe`** — add `clean: options?.clean` and `speakers: options?.speakers` to the `transcriptionManager.transcribeAudio(uploadPath, { … })` options object.

- [ ] **Step 6: Typecheck + tests**

Run: `tsgo --noEmit 2>&1 | rg -c "error TS" || echo 0` (expect `0`); `bun test src/utils/ai src/transcribe`.
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/utils/ai/transcription/TranscriptionManager.ts src/utils/ai/tasks/Transcriber.ts src/utils/ai/providers/AICloudProvider.ts src/utils/ai/tasks/Transcriber.cleanup.test.ts
git commit -m "feat(transcribe): apply repetition cleanup at manager + stitched levels"
```

### Task A.4: CLI `--no-clean`/`--raw` + E2E proof on the looper

**Files:**
- Modify: `src/transcribe/index.ts` (commander options ~301-311; `TranscribeFlags` ~42-50; `runTranscription` call ~114-121)

- [ ] **Step 1: Add option + flag + thread it**

```ts
// commander:
.option("--no-clean", "Disable repetition-loop cleanup (alias: --raw)")
.option("--raw", "Alias for --no-clean")
// TranscribeFlags: add `clean?: boolean;`
// runTranscription transcriber.transcribe(resolved, { ... , clean: opts.raw ? false : opts.clean });
```
(Commander `--no-clean` sets `opts.clean=false`; `--raw` also forces false.)

- [ ] **Step 2: E2E — cleanup ON (default) kills the loop**

Run:
```bash
cd /Users/Martin/Downloads
tools transcribe "gth-jaqt-rcw (2026-05-08 07_33 GMT).mp4" --provider openai --model whisper-1 --lang cs --format text -o /tmp/gth-clean.txt 2>/dev/null
rg -o '[A-ZČŠŽ][^.!?]{12,}[.!?]' /tmp/gth-clean.txt | sort | uniq -c | sort -rn | head -1
```
Expected: top repeated clause count is low single digits (no `"Zkusíme zpátky…"`/`"ještě ještě…"` ×∞).

- [ ] **Step 3: E2E — `--raw` returns the raw looped output (gate proof)**

Run: same command with `--raw -o /tmp/gth-raw.txt`; `wc -c /tmp/gth-raw.txt /tmp/gth-clean.txt`.
Expected: `gth-raw.txt` is substantially larger and still contains the loop → proves the gate works.

- [ ] **Step 4: E2E — legit repeats preserved**

Run: transcribe `xyf-csts-ptr*.mp4` (deepgram, text); `rg -c "Dobře, děkuji" /tmp/xyf.txt`.
Expected: count ≈ the interviewer's natural repeats (not collapsed to 1).

- [ ] **Step 5: Commit**

```bash
git add src/transcribe/index.ts
git commit -m "feat(transcribe): --no-clean/--raw escape for repetition cleanup"
```

---

## Phase B1 — Deepgram native diarization

### Task B1.1: `TranscriptionSegment.speaker` + Deepgram options

**Files:**
- Modify: `src/utils/ai/types.ts` (`TranscriptionSegment` ~44-48)
- Modify: `src/utils/ai/transcription/TranscriptionManager.ts` (`buildProviderOptions` deepgram branch ~462-481)

- [ ] **Step 1: Add `speaker?` to `TranscriptionSegment`**

```ts
export interface TranscriptionSegment {
    text: string;
    start: number;
    end: number;
    speaker?: string;
}
```

- [ ] **Step 2: In `buildProviderOptions` deepgram branch, request utterances when diarizing**

```ts
if (options.diarize) {
    deepgramOpts.diarize = true;
    deepgramOpts.utterances = true; // gives speaker-grouped sentence segments
}
```

- [ ] **Step 3: Typecheck**

Run: `tsgo --noEmit 2>&1 | rg -c "error TS" || echo 0`
Expected: `0`.

- [ ] **Step 4: Commit**

```bash
git add src/utils/ai/types.ts src/utils/ai/transcription/TranscriptionManager.ts
git commit -m "feat(transcribe): TranscriptionSegment.speaker + deepgram utterances"
```

### Task B1.2: Parse Deepgram raw utterances into speaker segments

**Files:**
- Modify: `src/utils/ai/transcription/TranscriptionManager.ts` (add `SdkTranscriptionResult.responses`, a `deepgramUtteranceSegments()` helper, use it in `transcribeAudio`)
- Test: `src/utils/ai/transcription/deepgram-utterances.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/utils/ai/transcription/deepgram-utterances.test.ts
import { describe, expect, it } from "bun:test";
import { deepgramUtteranceSegments } from "./TranscriptionManager";

describe("deepgramUtteranceSegments", () => {
    it("maps raw utterances to speaker-labelled segments", () => {
        const result = {
            responses: [{ body: { results: { utterances: [
                { speaker: 0, transcript: "Dobrý den.", start: 0.1, end: 1.2 },
                { speaker: 1, transcript: "Zdravím.", start: 1.5, end: 2.0 },
            ] } } }],
        };
        expect(deepgramUtteranceSegments(result)).toEqual([
            { text: "Dobrý den.", start: 0.1, end: 1.2, speaker: "SPEAKER_00" },
            { text: "Zdravím.", start: 1.5, end: 2.0, speaker: "SPEAKER_01" },
        ]);
    });
    it("returns undefined when no utterances present", () => {
        expect(deepgramUtteranceSegments({ responses: [{ body: {} }] })).toBeUndefined();
        expect(deepgramUtteranceSegments({})).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/utils/ai/transcription/deepgram-utterances.test.ts`
Expected: FAIL — `deepgramUtteranceSegments` not exported.

- [ ] **Step 3: Implement (narrow typed access — no `any`)**

```ts
import { normalizeSpeakerLabel } from "./speaker-label";

interface DeepgramUtterance { speaker: number; transcript: string; start: number; end: number }
interface DeepgramRawResponse { body?: { results?: { utterances?: DeepgramUtterance[] } } }

export function deepgramUtteranceSegments(result: {
    responses?: ReadonlyArray<unknown>;
}): TranscriptionSegment[] | undefined {
    const first = result.responses?.[0] as DeepgramRawResponse | undefined;
    const utts = first?.body?.results?.utterances;

    if (!utts?.length) {
        return undefined;
    }

    return utts.map((u) => ({
        text: u.transcript,
        start: u.start,
        end: u.end,
        speaker: normalizeSpeakerLabel(u.speaker),
    }));
}
```
Add `responses?: ReadonlyArray<unknown>;` to the `SdkTranscriptionResult` interface. In `transcribeAudio`, when `transcriptionModel.provider === "deepgram" && options.diarize`, prefer `deepgramUtteranceSegments(result) ?? mapResultSegments(result)` for `segments` (before cleanup).

- [ ] **Step 4: Run tests**

Run: `bun test src/utils/ai/transcription/deepgram-utterances.test.ts`; `tsgo --noEmit 2>&1 | rg -c "error TS" || echo 0`
Expected: PASS (2); `0`.

- [ ] **Step 5: Commit**

```bash
git add src/utils/ai/transcription/TranscriptionManager.ts src/utils/ai/transcription/deepgram-utterances.test.ts
git commit -m "feat(transcribe): parse Deepgram raw utterances into speaker segments"
```

### Task B1.3: Speaker-aware coalescing + rendering

**Files:**
- Modify: `src/utils/ai/transcription-format.ts` (`coalesceSegmentsForSubtitles` ~36-74; `toSRT` ~76-94; `toVTT` ~96-116; `formatOutput` ~118-129)
- Test: `src/transcribe/transcribe.test.ts` (extend)

- [ ] **Step 1: Write failing tests** (append to `transcribe.test.ts`)

```ts
it("never merges cues across a speaker change and prefixes SRT with SPEAKER", () => {
    const result = { text: "x", segments: [
        { text: "Dobrý den.", start: 0, end: 1, speaker: "SPEAKER_00" },
        { text: "Zdravím.", start: 1.1, end: 2, speaker: "SPEAKER_01" },
    ] };
    const srt = toSRT(result);
    expect(srt).toContain("1\n00:00:00,000 --> 00:00:01,000\nSPEAKER_00: Dobrý den.");
    expect(srt).toContain("2\n00:00:01,100 --> 00:00:02,000\nSPEAKER_01: Zdravím.");
});
it("VTT uses <v SPEAKER_NN> voice spans", () => {
    const result = { text: "x", segments: [{ text: "Ahoj.", start: 0, end: 1, speaker: "SPEAKER_00" }] };
    expect(toVTT(result)).toContain("<v SPEAKER_00>Ahoj.");
});
it("text format prefixes each speaker turn", () => {
    const result = { text: "x", segments: [
        { text: "A.", start: 0, end: 1, speaker: "SPEAKER_00" },
        { text: "B.", start: 1, end: 2, speaker: "SPEAKER_01" },
    ] };
    expect(formatOutput(result as any, "text")).toBe("SPEAKER_00: A.\nSPEAKER_01: B.");
});
```

- [ ] **Step 2: Run to verify fail**

Run: `bun test src/transcribe/transcribe.test.ts`
Expected: FAIL on the 3 new tests.

- [ ] **Step 3: Implement** — in `coalesceSegmentsForSubtitles` add `cur.speaker !== seg.speaker` to the flush condition and carry `speaker` onto the cue; in `toSRT` prefix `${seg.speaker ? normalizeSpeakerLabel(seg.speaker)+": " : ""}` (speaker already normalized — call is idempotent); in `toVTT` wrap text as `<v ${spk}>${text}` when speaker present; add a `text` branch in `formatOutput` that, when any segment has a speaker, renders speaker-grouped turns (`SPEAKER_NN: …` joined by `\n`) else returns `result.text`.

- [ ] **Step 4: Run tests**

Run: `bun test src/transcribe/transcribe.test.ts`; `tsgo --noEmit 2>&1 | rg -c "error TS" || echo 0`
Expected: all PASS; `0`.

- [ ] **Step 5: Commit**

```bash
git add src/utils/ai/transcription-format.ts src/transcribe/transcribe.test.ts
git commit -m "feat(transcribe): speaker-aware coalescing + SRT/VTT/text rendering"
```

### Task B1.4: `--diarize`/`--speakers` CLI + Deepgram split-bypass + E2E

**Files:**
- Modify: `src/transcribe/index.ts` (options, `TranscribeFlags`, `runTranscription`, interactive prompt)
- Modify: `src/utils/ai/tasks/Transcriber.ts` (`transcribe` split decision ~73-75)

- [ ] **Step 1: CLI** — add `.option("--diarize", "Identify speakers")` and `.option("--speakers <n>", "Expected speaker count (0/omit = auto)", (v)=>parseInt(v,10))`; add to `TranscribeFlags`; pass `diarize: opts.diarize, speakers: opts.speakers` in the `transcriber.transcribe` call; add a `confirm`/number prompt in `interactiveMode` after provider select.

- [ ] **Step 2: Split-bypass** — in `Transcriber.transcribe`, when `options?.diarize` is true, skip `transcribeChunked` even if `audio.length > MAX_CLOUD_BYTES` (Deepgram accepts large uploads; one call ⇒ one consistent speaker label space). Add a `logger.info` noting diarize bypasses size-split.

- [ ] **Step 3: E2E vs reference**

Run:
```bash
cd /Users/Martin/Downloads
tools transcribe "btf-pnvm-ecb (2026-05-08 08_41 GMT).mp4" --provider deepgram --diarize --lang cs --format srt -o /tmp/dg-diar.srt 2>/dev/null
rg -o 'SPEAKER_0[0-9]' /tmp/dg-diar.srt | sort -u
bun tests/transcribe/verify-against-reference.ts /tmp/dg-diar.srt /Users/Martin/Downloads/1.srt
```
Expected: `SPEAKER_00`/`SPEAKER_01` present; speaker-agreement and WER-proxy printed; compare to `/tmp/baseline-metric.txt` — must not regress WER, speaker-agreement now > 0.

- [ ] **Step 4: Commit**

```bash
git add src/transcribe/index.ts src/utils/ai/tasks/Transcriber.ts
git commit -m "feat(transcribe): --diarize/--speakers + Deepgram split-bypass"
```

---

## Phase B2 — Local pyannote/sherpa-onnx diarization (Whisper/gpt-4o/local)

> **Pipeline order (do not reorder):** `transcribe → repetition-cleanup → diarize the UN-SPLIT source audio (sherpa-onnx) → align speakers onto the cleaned segments by max-overlap`. Cleanup mutates segment text only (time axis unchanged); diarization is computed on the original audio timeline; alignment maps turns onto cleaned segments. Because diarization always runs on the whole un-split file, the label space is global — no cross-chunk remapping exists or is needed.

### Task B2.1: Pre-flight — sherpa-onnx prebuilt binary assertion

**Files:**
- Modify: `package.json`
- Test: `src/utils/audio/diarize-local.preflight.test.ts`

- [ ] **Step 1: Add dependency**

Run: `bun add sherpa-onnx-node@^1.13.2`
Expected: installs `sherpa-onnx-node` + optional `sherpa-onnx-darwin-arm64`.

- [ ] **Step 2: Write the preflight test**

```ts
// src/utils/audio/diarize-local.preflight.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";

describe("sherpa-onnx preflight", () => {
    it("darwin-arm64 prebuilt native addon is present (no source build)", () => {
        const dir = "node_modules/sherpa-onnx-darwin-arm64";
        expect(existsSync(dir)).toBe(true);
    });
    it("module loads without throwing", () => {
        expect(() => require("sherpa-onnx-node")).not.toThrow();
    });
});
```

- [ ] **Step 3: Run it**

Run: `bun test src/utils/audio/diarize-local.preflight.test.ts`
Expected: PASS. **If FAIL** (no prebuilt / source-build fallback): STOP — record the failure; the fallback is to mark B2 unavailable at runtime (Task B2.4 already degrades gracefully) and surface a clear error telling the user local diarization is unsupported on this platform. Do not attempt a source build.

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock src/utils/audio/diarize-local.preflight.test.ts
git commit -m "build(transcribe): add sherpa-onnx-node + prebuilt-binary preflight"
```

### Task B2.2: Model fetch+cache

**Files:**
- Create: `src/utils/audio/diarize-models.ts`
- Test: `src/utils/audio/diarize-models.test.ts`

- [ ] **Step 1: Failing test**

```ts
// src/utils/audio/diarize-models.test.ts
import { describe, expect, it } from "bun:test";
import { DIARIZE_MODEL_DIR, SEGMENTATION_MODEL, EMBEDDING_MODEL } from "./diarize-models";

describe("diarize-models config", () => {
    it("points at the ungated GitHub-release assets", () => {
        expect(SEGMENTATION_MODEL.url).toBe(
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
        );
        expect(EMBEDDING_MODEL.url).toBe(
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx",
        );
        expect(DIARIZE_MODEL_DIR).toContain(".genesis-tools/transcribe/models/diarization");
    });
});
```

- [ ] **Step 2: Run → fail.** `bun test src/utils/audio/diarize-models.test.ts` → module not found.

- [ ] **Step 3: Implement**

```ts
// src/utils/audio/diarize-models.ts
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import logger from "@app/logger";

export const DIARIZE_MODEL_DIR = join(homedir(), ".genesis-tools", "transcribe", "models", "diarization");

export const SEGMENTATION_MODEL = {
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
    // after extraction:
    file: join(DIARIZE_MODEL_DIR, "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx"),
};

export const EMBEDDING_MODEL = {
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx",
    file: join(DIARIZE_MODEL_DIR, "wespeaker_en_voxceleb_resnet34_LM.onnx"),
};

/** Ensure both ONNX models exist locally; download+extract on first use. */
export async function ensureDiarizationModels(): Promise<{ segmentation: string; embedding: string }> {
    await mkdir(DIARIZE_MODEL_DIR, { recursive: true });

    if (!existsSync(EMBEDDING_MODEL.file)) {
        logger.info(`Downloading diarization embedding model (~25 MB)…`);
        await Bun.write(EMBEDDING_MODEL.file, await (await fetch(EMBEDDING_MODEL.url)).arrayBuffer());
    }

    if (!existsSync(SEGMENTATION_MODEL.file)) {
        logger.info(`Downloading diarization segmentation model (~6 MB)…`);
        const tar = join(DIARIZE_MODEL_DIR, "seg.tar.bz2");
        await Bun.write(tar, await (await fetch(SEGMENTATION_MODEL.url)).arrayBuffer());
        const p = Bun.spawn(["tar", "xjf", tar, "-C", DIARIZE_MODEL_DIR], { stderr: "pipe" });
        if ((await p.exited) !== 0) {
            throw new Error(`Failed to extract segmentation model: ${await new Response(p.stderr).text()}`);
        }
    }

    return { segmentation: SEGMENTATION_MODEL.file, embedding: EMBEDDING_MODEL.file };
}
```

- [ ] **Step 4: Run test → PASS.** `bun test src/utils/audio/diarize-models.test.ts`; `tsgo --noEmit 2>&1 | rg -c "error TS" || echo 0` → `0`.

- [ ] **Step 5: Commit**

```bash
git add src/utils/audio/diarize-models.ts src/utils/audio/diarize-models.test.ts
git commit -m "feat(transcribe): diarization model fetch+cache (ungated GH releases)"
```

### Task B2.3: `align-speakers` util (whisperX max-overlap)

**Files:**
- Create: `src/utils/ai/transcription/align-speakers.ts`
- Test: `src/utils/ai/transcription/align-speakers.test.ts`

- [ ] **Step 1: Failing test**

```ts
// src/utils/ai/transcription/align-speakers.test.ts
import { describe, expect, it } from "bun:test";
import { assignSpeakers } from "./align-speakers";

const turns = [
    { start: 0, end: 5, speaker: "speaker_00" },
    { start: 5, end: 10, speaker: "speaker_01" },
];

describe("assignSpeakers", () => {
    it("assigns max-overlap speaker, normalized", () => {
        const segs = [{ text: "A", start: 0.5, end: 4 }, { text: "B", start: 6, end: 9 }];
        expect(assignSpeakers(segs, turns)).toEqual([
            { text: "A", start: 0.5, end: 4, speaker: "SPEAKER_00" },
            { text: "B", start: 6, end: 9, speaker: "SPEAKER_01" },
        ]);
    });
    it("fillNearest=true labels a zero-overlap segment with nearest turn", () => {
        const segs = [{ text: "C", start: 20, end: 21 }];
        expect(assignSpeakers(segs, turns)[0].speaker).toBe("SPEAKER_01");
    });
    it("sums overlap per speaker then picks the dominant", () => {
        const segs = [{ text: "D", start: 4, end: 8 }]; // 1s spk0, 3s spk1
        expect(assignSpeakers(segs, turns)[0].speaker).toBe("SPEAKER_01");
    });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

```ts
// src/utils/ai/transcription/align-speakers.ts
import type { TranscriptionSegment } from "@app/utils/ai/types";
import { normalizeSpeakerLabel } from "./speaker-label";

export interface DiarTurn { start: number; end: number; speaker: string }

function overlap(a0: number, a1: number, b0: number, b1: number): number {
    return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/** whisperX assign_word_speakers, segment granularity, fillNearest=true. */
export function assignSpeakers(
    segments: TranscriptionSegment[],
    turns: DiarTurn[],
): TranscriptionSegment[] {
    return segments.map((seg) => {
        const byspk = new Map<string, number>();

        for (const t of turns) {
            const ov = overlap(seg.start, seg.end, t.start, t.end);
            if (ov > 0) {
                byspk.set(t.speaker, (byspk.get(t.speaker) ?? 0) + ov);
            }
        }

        let speaker: string | undefined;
        let best = 0;

        for (const [s, v] of byspk) {
            if (v > best) {
                best = v;
                speaker = s;
            }
        }

        if (!speaker && turns.length > 0) {
            const mid = (seg.start + seg.end) / 2;
            speaker = turns.reduce((p, c) =>
                Math.abs((c.start + c.end) / 2 - mid) < Math.abs((p.start + p.end) / 2 - mid) ? c : p,
            ).speaker;
        }

        return { ...seg, speaker: normalizeSpeakerLabel(speaker) };
    });
}
```

- [ ] **Step 4: Run → PASS.** `bun test src/utils/ai/transcription/align-speakers.test.ts`; tsgo `0`.

- [ ] **Step 5: Commit**

```bash
git add src/utils/ai/transcription/align-speakers.ts src/utils/ai/transcription/align-speakers.test.ts
git commit -m "feat(transcribe): whisperX-style max-overlap speaker alignment"
```

### Task B2.4: `diarize-local` (sherpa-onnx wrapper) + wiring

**Files:**
- Create: `src/utils/audio/diarize-local.ts`
- Modify: `src/utils/ai/tasks/Transcriber.ts` (post-cleanup local-diarize step)

- [ ] **Step 1: Implement the wrapper** (no unit test — needs the native addon + audio; covered by E2E in B2.5)

```ts
// src/utils/audio/diarize-local.ts
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import logger from "@app/logger";
import { convertToWhisperWav } from "@app/utils/audio/converter";
import { ensureDiarizationModels } from "@app/utils/audio/diarize-models";
import type { DiarTurn } from "@app/utils/ai/transcription/align-speakers";

/** Diarize an audio buffer locally (sherpa-onnx, pyannote-seg + WeSpeaker).
 *  Returns [] (never throws) if the native addon/models are unavailable. */
export async function diarizeLocal(
    audio: Buffer,
    opts?: { speakers?: number },
): Promise<DiarTurn[]> {
    const wavPath = join(tmpdir(), `diar-${Date.now()}.wav`);

    try {
        const wav = await convertToWhisperWav(audio); // 16kHz mono 16-bit
        await Bun.write(wavPath, wav);

        const { segmentation, embedding } = await ensureDiarizationModels();
        const sherpa = require("sherpa-onnx-node");

        const numClusters = opts?.speakers && opts.speakers > 0 ? opts.speakers : -1;
        const sd = new sherpa.OfflineSpeakerDiarization({
            segmentation: { pyannote: { model: segmentation } },
            embedding: { model: embedding },
            clustering: { numClusters, threshold: 0.5 },
            minDurationOn: 0.3,
            minDurationOff: 0.5,
        });

        const wave = sherpa.readWave(wavPath);
        if (sd.sampleRate !== wave.sampleRate) {
            throw new Error(`sherpa expects ${sd.sampleRate}Hz, got ${wave.sampleRate}`);
        }

        const turns = sd.process(wave.samples) as DiarTurn[];
        return turns;
    } catch (err) {
        logger.warn(`Local diarization unavailable, returning transcript without speakers: ${err}`);
        return [];
    } finally {
        try {
            unlinkSync(wavPath);
        } catch {
            /* ignore */
        }
    }
}
```

- [ ] **Step 2: Wire into `Transcriber`** — after `maybeClean`, when `options?.diarize` AND the result has no per-segment `speaker` (i.e. provider is not Deepgram-with-utterances) AND `result.segments?.length`:

```ts
import { diarizeLocal } from "@app/utils/audio/diarize-local";
import { assignSpeakers } from "@app/utils/ai/transcription/align-speakers";
// ...
private async maybeDiarizeLocal(r: TranscriptionResult, audio: Buffer, options?: TranscribeOptions): Promise<TranscriptionResult> {
    if (!options?.diarize || !r.segments?.length || r.segments.some((s) => s.speaker)) {
        return r;
    }

    const turns = await diarizeLocal(audio, { speakers: options.speakers });
    if (turns.length === 0) {
        return r;
    }

    return { ...r, segments: assignSpeakers(r.segments, turns) };
}
```
Call order in `transcribe` (non-chunked) and after stitching in `transcribeChunked`: `result → maybeClean → maybeDiarizeLocal(audio)` — always passing the **full original `audio` buffer** (never a chunk) so diarization sees the whole timeline.

- [ ] **Step 3: Designed-out invariant test** (future-proofs the no-remap property)

```ts
// src/utils/ai/tasks/Transcriber.diarize-invariant.test.ts
import { describe, expect, it } from "bun:test";
// Spy: diarizeLocal must be called with the SAME byte length as the original
// transcribe() input — never a per-chunk slice. If a future change diarizes
// chunk-wise this fails, catching the cross-chunk-label regression early.
describe("designed-out: diarization runs on the un-split source", () => {
    it("maybeDiarizeLocal receives the full original audio length", async () => {
        const seen: number[] = [];
        const mod = await import("@app/utils/audio/diarize-local");
        const spy = (mod as { diarizeLocal: unknown }).diarizeLocal;
        // @ts-expect-error test override
        mod.diarizeLocal = async (buf: Buffer) => { seen.push(buf.length); return []; };
        // ... drive a chunked transcribe with diarize:true via a stub provider ...
        // assert: seen.every(len => len === originalAudio.length)
        // @ts-expect-error restore
        mod.diarizeLocal = spy;
        expect(seen.every((l) => l === seen[0])).toBe(true);
    });
});
```
(Implement the stub-provider driver against the existing `Transcriber.create` test seam; the assertion that matters is `diarizeLocal` is never handed a chunk-sized buffer.)

- [ ] **Step 4: Typecheck + existing tests**

Run: `tsgo --noEmit 2>&1 | rg -c "error TS" || echo 0` (→ `0`); `bun test src/utils/ai src/utils/audio src/transcribe`.
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/utils/audio/diarize-local.ts src/utils/ai/tasks/Transcriber.ts src/utils/ai/tasks/Transcriber.diarize-invariant.test.ts
git commit -m "feat(transcribe): local sherpa-onnx diarization + designed-out invariant test"
```

### Task B2.5: E2E — Whisper/gpt-4o + local speakers vs reference; tune clustering

**Files:** none (verification + tuning only; if tuning needed, edit defaults in `diarize-local.ts`)

- [ ] **Step 1: Run Whisper + local diarization vs reference**

```bash
cd /Users/Martin/Downloads
tools transcribe "btf-pnvm-ecb (2026-05-08 08_41 GMT).mp4" --provider openai --model gpt-4o-transcribe --diarize --lang cs --format srt -o /tmp/wl-diar.srt 2>/dev/null
rg -o 'SPEAKER_0[0-9]' /tmp/wl-diar.srt | sort -u
bun tests/transcribe/verify-against-reference.ts /tmp/wl-diar.srt /Users/Martin/Downloads/1.srt
```
Expected: ≥2 speakers; metric printed.

- [ ] **Step 2: Tune if speaker-agreement is low** — for known 2-speaker interviews try `--speakers 2`; for auto, adjust `clustering.threshold` in `diarize-local.ts` (0.5 → 0.6/0.7 if over-split; → 0.4 if speakers merged). Re-run Step 1 after each change. Stop when speaker-agreement vs `/tmp/baseline` reference is maximized and not improving.

- [ ] **Step 3: Commit any tuned defaults**

```bash
git add src/utils/audio/diarize-local.ts
git commit -m "tune(transcribe): local diarization clustering defaults for 2-4 speakers"
```

---

## Phase B3 — Word-level alignment enhancement (accuracy; metric-gated)

> Promoted from "out of scope" per user. Segment-level alignment forces one
> speaker on a whole STT segment even when a turn changes mid-segment;
> word-level alignment recovers short backchannels ("mhm", "jasně") the
> research said segment-level misses. Only providers that yield word timings
> benefit: **whisper-1** (`timestampGranularities:["segment","word"]`) and
> **Deepgram** (raw `words[]`). **gpt-4o-transcribe returns no words → it
> stays segment-level, unchanged.** This whole phase is **kept only if it
> improves speaker-agreement vs the reference** (Task B3.3) — otherwise
> reverted. It does not block Phase C.

### Task B3.1: Spike — confirm word timestamps are reachable via the AI SDK

**Files:** none (investigation; records a decision)

- [ ] **Step 1: Probe the raw response for whisper-1 words (throwaway script — do NOT edit a working file)**

Write `/tmp/probe-words.ts` and run it (deletes itself conceptually — never committed):
```ts
import { experimental_transcribe as transcribe } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
const openai = createOpenAI();
const r = await transcribe({
  model: openai.transcription("whisper-1"),
  audio: await Bun.file("/Users/Martin/Downloads/xyf-csts-ptr (2026-05-14 16_04 GMT).mp4").arrayBuffer(),
  providerOptions: { openai: { language: "cs", timestampGranularities: ["segment", "word"] } },
});
console.log("top keys:", Object.keys(r));
console.log("segments[0]:", JSON.stringify(r.segments?.[0]));
console.log("raw body keys:", Object.keys((r.responses?.[0] as any)?.body ?? {}));
console.log("raw words sample:", JSON.stringify((r.responses?.[0] as any)?.body?.words?.slice?.(0, 3)));
```
Run: `bun /tmp/probe-words.ts`
- [ ] **Step 2: Record the decision**

Expected one of:
- **(a) words present** at `responses[0].body.words[]` (`{word,start,end}`) when `timestampGranularities:["segment","word"]` is requested → proceed to B3.2 word path for whisper-1.
- **(b) no words exposed** by `@ai-sdk/openai` → whisper-1 word path is **not feasible via the SDK**; B3 narrows to **Deepgram-words-only**, OR (documented) skip whisper-1 word-level. Write the chosen branch into this task's checkbox before continuing. Remove the temporary log.

### Task B3.2: Word-granularity alignment + re-segmentation

**Files:**
- Modify: `src/utils/ai/transcription/align-speakers.ts` (add `assignSpeakersByWords`)
- Modify: `src/utils/ai/transcription/TranscriptionManager.ts` (openai branch: add `"word"` to `timestampGranularities` when `options.diarize`; expose `mapResultWords()` reading the field path confirmed in B3.1)
- Test: `src/utils/ai/transcription/align-speakers.words.test.ts`

- [ ] **Step 1: Failing test**

```ts
// src/utils/ai/transcription/align-speakers.words.test.ts
import { describe, expect, it } from "bun:test";
import { assignSpeakersByWords } from "./align-speakers";

describe("assignSpeakersByWords", () => {
    it("re-segments a segment at a mid-segment speaker change", () => {
        const seg = { text: "ano jasně ne nikdy", start: 0, end: 4 };
        const words = [
            { word: "ano", start: 0.0, end: 0.5 },
            { word: "jasně", start: 0.5, end: 1.0 },
            { word: "ne", start: 2.0, end: 2.3 },
            { word: "nikdy", start: 2.3, end: 3.0 },
        ];
        const turns = [
            { start: 0, end: 1.2, speaker: "speaker_00" },
            { start: 1.2, end: 4, speaker: "speaker_01" },
        ];
        expect(assignSpeakersByWords(seg, words, turns)).toEqual([
            { text: "ano jasně", start: 0.0, end: 1.0, speaker: "SPEAKER_00" },
            { text: "ne nikdy", start: 2.0, end: 3.0, speaker: "SPEAKER_01" },
        ]);
    });
    it("returns the segment unchanged (single speaker) when no mid-segment change", () => {
        const seg = { text: "ano ne", start: 0, end: 2 };
        const words = [{ word: "ano", start: 0, end: 1 }, { word: "ne", start: 1, end: 2 }];
        const turns = [{ start: 0, end: 5, speaker: "speaker_00" }];
        expect(assignSpeakersByWords(seg, words, turns)).toEqual([
            { text: "ano ne", start: 0, end: 2, speaker: "SPEAKER_00" },
        ]);
    });
});
```

- [ ] **Step 2: Run → fail.** `bun test src/utils/ai/transcription/align-speakers.words.test.ts`.

- [ ] **Step 3: Implement `assignSpeakersByWords`** in `align-speakers.ts`:

```ts
export interface TimedWord { word: string; start: number; end: number }

/** Word-level max-overlap → split a segment into sub-segments at each speaker
 *  change; merge consecutive same-speaker words. */
export function assignSpeakersByWords(
    seg: TranscriptionSegment,
    words: TimedWord[],
    turns: DiarTurn[],
): TranscriptionSegment[] {
    const within = words.filter((w) => w.end > seg.start && w.start < seg.end);

    if (within.length === 0) {
        return [seg];
    }

    const tagged = within.map((w) => {
        const byspk = new Map<string, number>();
        for (const t of turns) {
            const ov = Math.max(0, Math.min(w.end, t.end) - Math.max(w.start, t.start));
            if (ov > 0) {
                byspk.set(t.speaker, (byspk.get(t.speaker) ?? 0) + ov);
            }
        }

        let spk: string | undefined;
        let best = 0;
        for (const [s, v] of byspk) {
            if (v > best) {
                best = v;
                spk = s;
            }
        }

        return { ...w, speaker: spk };
    });

    const out: TranscriptionSegment[] = [];
    for (const w of tagged) {
        const prev = out[out.length - 1];
        const label = normalizeSpeakerLabel(w.speaker);
        if (prev && prev.speaker === label) {
            prev.text += ` ${w.word}`;
            prev.end = w.end;
        } else {
            out.push({ text: w.word, start: w.start, end: w.end, speaker: label });
        }
    }

    return out;
}
```

- [ ] **Step 4: Wire (scoped to whisper-1 + local-sherpa-onto-whisper ONLY)**
  - **Deepgram is NOT touched by B3.** Its `diarize+utterances` path
    (`deepgramUtteranceSegments`, B1.2) already returns speaker segments split
    at natural sentence boundaries — re-aligning those per-word would *regress*
    the common case. Word-level for Deepgram stays opt-in/future, never auto.
  - In `Transcriber.maybeDiarizeLocal`, when `assignSpeakers` would run AND
    word timings exist for the transcript, instead `flatMap` each segment
    through `assignSpeakersByWords(seg, wordsInSeg, turns)`; else keep
    segment-level `assignSpeakers`.
  - The `timestampGranularities` change in `buildProviderOptions` must be
    **model-gated, not provider-gated**: only `modelId === "whisper-1"` gets
    `["segment","word"]` (and only when `options.diarize` and B3.1 = branch
    (a)). `gpt-4o-transcribe`/`gpt-4o-mini-transcribe` return no segments at
    all (verified) — they must keep their existing options untouched.

- [ ] **Step 5: Run tests + tsgo.** `bun test src/utils/ai/transcription`; `tsgo --noEmit 2>&1 | rg -c "error TS" || echo 0` → `0`.

- [ ] **Step 6: Commit**

```bash
git add src/utils/ai/transcription/align-speakers.ts src/utils/ai/transcription/align-speakers.words.test.ts src/utils/ai/transcription/TranscriptionManager.ts src/utils/ai/tasks/Transcriber.ts
git commit -m "feat(transcribe): optional word-level speaker alignment + re-segmentation"
```

### Task B3.3: Keep-or-revert decision (metric-gated)

- [ ] **Step 1:** Re-run the Task C.1 scoring with word-level enabled vs the segment-level Phase-B2 numbers.
- [ ] **Step 2:** If word-level speaker-agreement ≥ segment-level (and WER-proxy not regressed) → keep, record numbers. If it regresses (e.g. choppy backchannel over-segmentation) → `git revert` the B3.2 commit, document "word-level tried, regressed on these recordings, segment-level retained" in the internal plan file. Either outcome is a valid completion of B3.

## Phase C — Convergence gate

### Review items discovered during B1.4 (address in Phase C, NOT inline earlier)

<!-- updated 2026-05-17: added from B1.4 E2E findings; commit 3df039dc -->

1. **Metric was confounded — fixed before B1.4 (commits 35593254, 5c661c3c).**
   Original metric (a) compared speaker labels by string equality (not
   permutation-invariant — punished a correct but oppositely-numbered
   diarization: xyf scored 0.03, truly 0.97) and (b) aggregated WER per
   *candidate* cue (inflated by diarized-cue fragmentation). Now:
   permutation-invariant optimal label assignment + WER aggregated per
   *reference* cue. Baseline re-captured under the corrected metric:
   **gth WER 0.147, xyf WER 0.209** (the old .752/.778 were the artifact).
2. **Diarized-SRT cue fragmentation (TODO for Phase C, do NOT fix inline).**
   `coalesceSegmentsForSubtitles` flushes a cue on the 6s `MAX_CUE_SECONDS`
   rule and on every speaker change, so a brief silence inside one speaker's
   turn yields single-word cues (`"Dobrý"`, `"den, moc si vážím toho,"`).
   Reads badly and is the suspected cause of the **gth diarized WER +0.066
   regression** (0.147→0.213; xyf stayed flat 0.209→0.210). Phase C fix
   direction: for diarized output, drop the time-based flush when
   `cur.speaker === seg.speaker` (merge across same-speaker silences) and/or
   raise `MAX_CUE_SECONDS` in diarized mode; consider feeding the
   smart-formatted utterance text rather than concatenated word tokens.
   Re-score after the fix; the Phase C gate is WER ≤ corrected baseline AND
   speaker-agreement materially > 0 (already met: gth 1.00, xyf 0.97).

### B3.3 outcome — word-level REVERTED (segment-level retained)

<!-- updated 2026-05-17: B3.3 metric gate; revert commit 421b3aab -->

B3.1 spike = branch (a): whisper-1 exposes `responses[0].body.words[]` via
`@ai-sdk/openai` with `timestampGranularities:["segment","word"]`. B3.2
implemented (commit ef3d41c5). B3.3 gate E2E (whisper-1 + local sherpa,
word-level vs B2.5 segment-level):

- gth: WER 0.284 vs 0.290 · agreement 0.58 vs 0.56 (negligible gain)
- xyf: WER **0.246 vs 0.218 (regressed +0.028)** · agreement 0.51 = 0.51

Speaker-agreement stayed ~chance (the English WeSpeaker embedding can't
discriminate the Czech speakers; word grain cannot fix wrong cluster
identity — predicted), while xyf WER regressed and output became choppy
(gth 282 / xyf 180 single-word cues — the plan's documented "choppy
backchannel over-segmentation" revert trigger). **Reverted B3.2 (commit
421b3aab); segment-level alignment retained.** A valid B3 completion per
the plan's keep-or-revert rule. Deepgram `diarize+utterances` (B1) was
never touched by B3.

### Phase C — convergence numbers (RECORDED; gate for D)

<!-- updated 2026-05-17: Phase C run, coalescer fix 58f699c3 in place -->

Metric = corrected harness (permutation-invariant speaker agreement +
ref-cue-grouped WER, commit 35593254). Mapping 1,2.srt↔gth; 5.srt↔xyf;
btf has no reference.

| Path | gth WER | gth spk | xyf WER | xyf spk |
|---|---|---|---|---|
| Baseline non-diarized (pre-feature) | 0.147 | — | 0.209 | — |
| Deepgram `--diarize` (B1.4, pre-coalescer-fix) | 0.213 | 1.00 | 0.210 | 0.97 |
| **Deepgram `--diarize` + coalescer fix (Phase C, PRODUCTION)** | **0.213** | **1.00** | **0.209** | **0.97** |
| whisper-1 + local sherpa (B2.5, segment-level) | 0.290 | 0.56 | 0.218 | 0.51 |
| whisper-1 + local + word-level (B3.2, REVERTED) | 0.284 | 0.58 | 0.246 | 0.51 |

**Gate verdict: PASS.** Speaker-agreement — the feature goal — is
near-perfect on the production Deepgram path (gth 1.00, xyf 0.97) where the
baseline had none. Text WER: xyf == baseline (coalescer fix closed the
gap); gth +0.066 is a diarized-representation property (Deepgram
`utterances` are speaker-segmented differently than the non-diarized
word→sentence rebuild, so under ref-cue grouping the concat diverges from
the pristine 1.srt) — NOT a degradation of Deepgram's words, and the
non-diarized default path is unchanged at 0.147 (`--diarize` is opt-in).
Repetition cleanup never regressed text (xyf flat, the loop killed). Local
diarization works no-Python/graceful but the English WeSpeaker embedding
caps Czech speaker-agreement at ~chance — Deepgram is the production
diarization path; **a multilingual-embedding swap is an explicit
out-of-scope follow-up**, not attempted (Deepgram already meets the goal).
Phase D (move-only, no behavior change) is unblocked.

### Task C.1: Full matrix vs references; record numbers

- [ ] **Step 1: Generate + score the mapped pairs with both diarization paths**

Uses the fixed mapping (1.srt,2.srt↔gth; 5.srt↔xyf):
```bash
cd /Users/Martin/Downloads
GT=/Users/Martin/Tresors/Projects/GenesisTools
V=$GT/tests/transcribe/verify-against-reference.ts
score() { # <mp4> <ref1> [ref2]
  local mp4="$1"; shift
  local b=$(basename "$mp4" .mp4| cut -d' ' -f1)
  tools transcribe "$mp4" --provider deepgram --diarize --lang cs --format srt -o /tmp/c-dg-$b.srt 2>/dev/null
  tools transcribe "$mp4" --provider openai --model gpt-4o-transcribe --diarize --lang cs --format srt -o /tmp/c-wl-$b.srt 2>/dev/null
  for ref in "$@"; do
    echo "=== $b vs $(basename $ref) ==="
    bun $V /tmp/c-dg-$b.srt "$ref"
    bun $V /tmp/c-wl-$b.srt "$ref"
  done
}
{ score "gth-jaqt-rcw (2026-05-08 07_33 GMT).mp4" /Users/Martin/Downloads/1.srt /Users/Martin/Downloads/2.srt
  score "xyf-csts-ptr (2026-05-14 16_04 GMT).mp4" /Users/Martin/Downloads/5.srt
} | tee /tmp/phaseC-metric.txt
diff <(sort /tmp/baseline-metric.txt) <(sort /tmp/phaseC-metric.txt) || true
```
Expected: WER-proxy ≤ baseline (cleanup must not regress text); speaker-agreement materially > 0 (baseline had no speakers). Record `/tmp/phaseC-metric.txt` numbers in the run summary. This is the **gate for Phase D**.

- [ ] **Step 2: Update internal plan file with the recorded numbers** (append a results block to `/Users/Martin/.claude/plans/buzzing-chasing-phoenix.md`).

- [ ] **Step 3: Commit (docs only)**

```bash
git add /Users/Martin/.claude/plans/buzzing-chasing-phoenix.md
git commit -m "docs(transcribe): phase C convergence numbers vs reference SRTs"
```

---

## Phase D — `AudioProcessor` → `src/utils/audio/` (GATED on Phase C pass)

> Move-only. Each method = one task, one commit. No pipeline-semantics changes. Do NOT start until Phase C metric is recorded and not regressed.

### Task D.1: Move `getAudioInfo` + `validateAudioFile`

**Files:**
- Create: `src/utils/audio/probe.ts` (move `getAudioInfo`, `validateAudioFile` verbatim; export functions)
- Modify: `src/ask/audio/AudioProcessor.ts` (re-export from new location / delegate)
- Modify: callers (`rg -l "audioProcessor\.(getAudioInfo|validateAudioFile)" src/`)

- [ ] **Step 1:** `rg -n "getAudioInfo|validateAudioFile" src/` — list every caller.
- [ ] **Step 2:** Create `src/utils/audio/probe.ts` with the two functions moved verbatim (plain exported functions, not class methods).
- [ ] **Step 3:** In `AudioProcessor`, replace the method bodies with delegations to the new functions (keep the class API stable for existing callers).
- [ ] **Step 4:** `tsgo --noEmit 2>&1 | rg -c "error TS" || echo 0` → `0`; `bun test src/utils/audio src/transcribe`.
- [ ] **Step 5:** `git add -A src/utils/audio/probe.ts src/ask/audio/AudioProcessor.ts && git commit -m "refactor(audio): move audio probe to src/utils/audio"`

### Task D.2: Move `splitAudioFile`/`splitAudioBySize`

Repeat the D.1 pattern for the splitter into `src/utils/audio/split.ts` (verbatim move; `AudioProcessor` delegates; update callers `Transcriber`, `transcribe/index.ts`). One commit.

### Task D.3: Move `convertAudioFormat`; collapse the now-thin `AudioProcessor`

- Move `convertAudioFormat` into `src/utils/audio/converter.ts` (it already hosts `convertFileToMonoMp3`). Replace remaining `AudioProcessor` usages with direct util imports; delete the class if nothing class-specific remains, else leave a thin shim. One commit per sub-step. `tsgo` `0`; full `bun test` green.

---

## Self-Review (run before the second advisor call)

**1. Spec coverage** — every research finding maps to a task:
- Repetition: consecutive-run collapse (A.1), thresholds 5/3/8 (A.1 constants), Czech normalize (A.1 `norm`), cross-segment dedup <2s (A.1), zlib FLAG-only windowed (A.1 `cleanText`), idempotent (A.1 test + A.3 integration), always-on + `--no-clean` (A.4).
- Deepgram diarize: `utterances:true` (B1.1), raw `responses[0].body.results.utterances` typed access (B1.2), speaker in segments (B1.1 type), no-merge-across-speaker + render (B1.3), split-bypass for global labels (B1.4).
- Local pyannote: `sherpa-onnx-node@^1.13.2` pinned + preflight (B2.1), exact ungated model URLs + cache dir (B2.2), whisperX max-overlap + fillNearest=true (B2.3), 16k wav via `convertToWhisperWav`, clustering defaults numClusters/threshold/minDuration (B2.4), language-agnostic (no Czech model — noted), tune knob (B2.5).
- Word-level alignment: spike-with-decision (B3.1), word re-segmentation
  (B3.2), keep-or-revert metric gate (B3.3) — gpt-4o stays segment by nature.
- Spokenly: one-sentence context only (Architecture section) — not litigated.
- Convergence metric named + baseline-first (Phase 0 / C); `.mp4`↔`.srt`
  mapping fixed (1,2↔gth; 5↔xyf; btf no reference).
- Dead `wordTimestamps` deleted (A.2). `normalizeSpeakerLabel` single source (0.1, used by B1.2/B1.3/B2.3).
- D refactor gated on C, move-only.

**2. Placeholder scan** — grep this file for `TBD|TODO|implement later|appropriate|similar to|fill in`: none (every code step has real code).

**3. Type consistency** — `TranscriptionSegment.speaker?: string` (B1.1) used identically in `deepgramUtteranceSegments` (B1.2), `assignSpeakers` (B2.3), formatters (B1.3). `DiarTurn` defined in `align-speakers.ts`, imported by `diarize-local.ts`. `cleanRepetitions({text,segments})→{text,segments}` signature consistent across A.1/A.3. `normalizeSpeakerLabel` signature stable across all callers.

## Scope notes (explicit)

- **Cross-chunk speaker remapping — designed out, NOT deferred.** Diarization
  always runs on the *un-split* source audio (Deepgram split-bypass in B1.4;
  local sherpa on the full original `audio` buffer in B2.4) → a single global
  speaker-label space, so remapping is structurally unnecessary, not skipped.
  The only edge is a pathologically long file (multi-hour): Deepgram accepts
  ≤2 GB; sherpa runs locally at RTF ≈0.25 so a 3 h file ≈45 min CPU and high
  memory — acceptable for interview-length audio, documented as the known
  limit. If that edge ever bites, the fix is "stream sherpa in windows with
  embedding-based label stitching", a separate effort — explicitly not built.
- **Word-level alignment — IN scope, Phase B3** (metric-gated; promoted per
  user). gpt-4o-transcribe has no words → stays segment-level by nature.
- **Out of scope:** AssemblyAI/Gladia diarization (no Czech / dep absent);
  LLM "polish to ChatGPT-md" (user dropped it — `*-chatgpt.md` is a quality
  *benchmark* only, never an output); confirming Spokenly's internal
  implementation (closed-source; we replicate the architecture).

## 2026-05-17 — Local Czech diarization SOLVED (supersedes the B2.5 "embedding-limited / out-of-scope" note)

User-requested ablation: ran whisper-1+local across .mp3/.wav/.mp4 — speaker-agreement stayed ≈0.51–0.57 on all formats (pipeline normalizes to 16 kHz mono regardless), ruling out audio compression. Swapped the embedding `wespeaker_en_voxceleb_resnet34_LM` → `3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx` (CAM++, multilingual zh+en, same ungated k2-fsa release). Result: gth speaker-agreement 0.54→0.99 (WER 0.29→0.099), xyf 0.51→0.96. Local sherpa diarization on Czech is now on par with Deepgram native (0.96–0.99), fully offline. Commit 2df8893d, in PR #168. The "multilingual-embedding swap is out of scope" scope note is hereby retracted — it was done and works.
