import { DING_PRESETS } from "./ding-presets";

/** Browser: same preset math via Web Audio so terminal & UI match. */
export function playDingInBrowser(preset: string, volume = 0.6): void {
    const p = DING_PRESETS[preset] ?? DING_PRESETS["soft-chime"];
    const Ctx = (globalThis as unknown as { AudioContext: typeof AudioContext }).AudioContext;
    const ac = new Ctx();
    const now = ac.currentTime;
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + p.attackMs / 1000);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + p.durationMs / 1000);
    gain.connect(ac.destination);
    for (const f of p.freqs) {
        const o = ac.createOscillator();
        o.frequency.value = f;
        o.connect(gain);
        o.start(now);
        o.stop(now + p.durationMs / 1000);
    }
}
