export interface Cue {
    start: number;
    end: number;
    speaker?: string;
    text: string;
}

function tc(s: string): number {
    const m = s.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);

    if (!m) {
        return 0;
    }

    return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
}

export function parseSrt(srt: string): Cue[] {
    const blocks = srt.replace(/\r/g, "").split(/\n\n+/);
    const cues: Cue[] = [];

    for (const b of blocks) {
        const lines = b.split("\n").filter((l) => l.trim() !== "");

        if (lines.length < 2) {
            continue;
        }

        const tl = lines.find((l) => l.includes("-->"));

        if (!tl) {
            continue;
        }

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

    for (let j = 0; j <= b.length; j++) {
        d[0][j] = j;
    }

    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            d[i][j] = Math.min(
                d[i - 1][j] + 1,
                d[i][j - 1] + 1,
                d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
        }
    }

    return d[a.length][b.length];
}

function overlap(a: Cue, b: Cue): number {
    return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

export function scoreAgainstReference(
    candSrt: string,
    refSrt: string,
): { werProxy: number; speakerAgreement: number } {
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

        if (!best || bestOv <= 0) {
            continue;
        }

        werSum += lev(c.text, best.text) / Math.max(1, best.text.length);
        werN++;

        if (c.speaker && best.speaker) {
            spkBoth++;

            if (c.speaker === best.speaker) {
                spkMatch++;
            }
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
    console.log(
        `${cand.split("/").pop()}: WER-proxy ${s.werProxy.toFixed(3)}, speaker-agreement ${s.speakerAgreement.toFixed(2)}`,
    );
}
