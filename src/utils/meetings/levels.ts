import type { AudioLevelBlock } from "../screen-recorder/audio-levels";
import { calibrateChannels, ENERGY_BLOCKS_PER_SEC, energyShare } from "./energy";

const BLOCK_MS = 1000 / ENERGY_BLOCKS_PER_SEC;
const WINDOW_BLOCKS = 60 * ENERGY_BLOCKS_PER_SEC;
const PCM_SCALE = 32768;

function channel(rms: number | null, device: string | null, muted: boolean) {
    return { dbfs: rms !== null && rms > 0 ? 20 * Math.log10(rms) : null, sampled: rms !== null, device, muted };
}

/** Both inputs have known provenance. There are no speaker tags on a live PCM stream. */
export class MeetingLevels {
    private readonly blocks = new Array<AudioLevelBlock | undefined>(WINDOW_BLOCKS);
    private latest?: AudioLevelBlock;

    constructor(private readonly minSeparation?: number) {}

    observe(block: AudioLevelBlock): void {
        if (this.latest && (this.latest.input !== block.input || this.latest.output !== block.output)) {
            this.blocks.fill(undefined);
        }
        this.blocks[Math.round(block.atMs / BLOCK_MS) % WINDOW_BLOCKS] = block;
        this.latest = block;
    }

    snapshot(atMs: number, state = { muted: { mic: false, system: false }, paused: false }) {
        const left = new Float32Array(WINDOW_BLOCKS);
        const right = new Float32Array(WINDOW_BLOCKS);
        const end = Math.round(atMs / BLOCK_MS);
        for (const block of this.blocks) {
            if (!block || block.mic === null || block.system === null) {
                continue;
            }
            const index = Math.round(block.atMs / BLOCK_MS) - end + WINDOW_BLOCKS - 1;
            if (index >= 0 && index < WINDOW_BLOCKS) {
                left[index] = block.mic * PCM_SCALE;
                right[index] = block.system * PCM_SCALE;
            }
        }
        const latest = this.latest;
        const fresh = latest && Math.abs(atMs - latest.atMs) <= 500 && !state.paused;
        const mic = fresh ? latest.mic : null;
        const system = fresh ? latest.system : null;
        const energy = { left, right };
        const calibration = calibrateChannels(energy, [], {
            sourceLayout: "left-mic",
            minSeparation: this.minSeparation,
            reportSourceShare: true,
        });
        const current = {
            left: Float32Array.of((mic ?? 0) * PCM_SCALE),
            right: Float32Array.of((system ?? 0) * PCM_SCALE),
        };
        return {
            at: new Date(atMs).toISOString(),
            mic: channel(mic, latest?.input ?? null, state.muted.mic),
            system: channel(system, latest?.output ?? null, state.muted.system),
            paused: state.paused,
            micShare: mic !== null && system !== null ? (energyShare(current, 0, 0.1).share ?? null) : null,
            calibration,
            voiceMicShare: calibration.layout === "unknown" ? null : (calibration.sourceMicShare ?? null),
        };
    }
}
export type MeetingLevelRow = ReturnType<MeetingLevels["snapshot"]>;
