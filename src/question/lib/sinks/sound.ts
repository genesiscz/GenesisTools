import { playDing, type SoundChoice } from "@app/utils/audio/runner.server";
import { registerSink, type Sink } from "./registry-exports";

export const soundSink: Sink = {
    name: "sound",
    isEnabled: (c) => c.sinks.sound,
    emit: async (_entry, c) => {
        const choice: SoundChoice = c.sound ?? { kind: "synth", preset: "soft-chime" };
        await playDing(choice, c.soundVolume ?? 0.6);
    },
};

registerSink(soundSink);
