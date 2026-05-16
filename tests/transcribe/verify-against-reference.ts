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

function permutations<T>(arr: T[]): T[][] {
    if (arr.length <= 1) {
        return [arr.slice()];
    }

    const out: T[][] = [];

    for (let i = 0; i < arr.length; i++) {
        const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];

        for (const p of permutations(rest)) {
            out.push([arr[i], ...p]);
        }
    }

    return out;
}

/**
 * Diarization speaker labels are arbitrary identifiers — `SPEAKER_00` from one
 * tool is not meant to equal `SPEAKER_00` from another. The only honest
 * agreement score is invariant under any bijection candidate-label →
 * reference-label, so brute-force every relabeling and take the best (speaker
 * counts are tiny — ≤3 in practice; cap at 7 to keep n! bounded). This is the
 * standard DER-style optimal label assignment.
 */
function bestSpeakerAgreement(pairs: Array<{ cand: string; ref: string }>): number {
    if (pairs.length === 0) {
        return 1;
    }

    const candSpk = [...new Set(pairs.map((p) => p.cand))];
    const refSpk = [...new Set(pairs.map((p) => p.ref))];

    if (candSpk.length > 7 || refSpk.length > 7) {
        const direct = pairs.filter((p) => p.cand === p.ref).length;

        return direct / pairs.length;
    }

    let best = 0;

    for (const perm of permutations(refSpk)) {
        const map = new Map<string, string>();
        candSpk.forEach((c, i) => {
            if (i < perm.length) {
                map.set(c, perm[i]);
            }
        });

        let matched = 0;

        for (const p of pairs) {
            if (map.get(p.cand) === p.ref) {
                matched++;
            }
        }

        if (matched > best) {
            best = matched;
        }
    }

    return best / pairs.length;
}

export function scoreAgainstReference(
    candSrt: string,
    refSrt: string,
): { werProxy: number; speakerAgreement: number } {
    const cand = parseSrt(candSrt);
    const ref = parseSrt(refSrt);

    // Each candidate cue → the reference cue it overlaps most (pure
    // max-overlap, NO start-distance gate: reference cues are long/
    // utterance-level, candidate cues short/segment-level; a start gate would
    // drop most candidates and skew the metric).
    const grouped = new Map<number, Cue[]>();
    const pairs: Array<{ cand: string; ref: string }> = [];

    for (const c of cand) {
        let bestIdx = -1;
        let bestOv = 0;

        for (let ri = 0; ri < ref.length; ri++) {
            const ov = overlap(c, ref[ri]);

            if (ov > bestOv) {
                bestOv = ov;
                bestIdx = ri;
            }
        }

        if (bestIdx < 0 || bestOv <= 0) {
            continue;
        }

        const list = grouped.get(bestIdx) ?? [];
        list.push(c);
        grouped.set(bestIdx, list);

        const r = ref[bestIdx];

        if (c.speaker && r.speaker) {
            pairs.push({ cand: c.speaker, ref: r.speaker });
        }
    }

    // WER-proxy aggregated PER REFERENCE CUE, not per candidate cue: collect
    // every candidate cue that matched this ref cue, concatenate in time
    // order, score the concatenation against the ref text. This decouples the
    // score from candidate cue granularity — one long cue and five short cues
    // over the same span with the same words now score identically.
    let werSum = 0;
    let werN = 0;

    for (const [refIdx, list] of grouped) {
        const r = ref[refIdx];
        const concat = list
            .slice()
            .sort((a, b) => a.start - b.start)
            .map((x) => x.text)
            .join(" ")
            .trim();
        werSum += lev(concat, r.text) / Math.max(1, r.text.length);
        werN++;
    }

    return {
        werProxy: werN ? werSum / werN : 1,
        speakerAgreement: bestSpeakerAgreement(pairs),
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
