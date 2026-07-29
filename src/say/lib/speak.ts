import { ai } from "@genesiscz/utils/ai/tasks/facade";
import { SayConfigManager } from "@genesiscz/utils/macos/SayConfigManager";
import { normalizeVolume } from "@genesiscz/utils/macos/tts";

export interface SpeakWithProfileOptions {
    text: string;
    app?: string;
    wait?: boolean;
}

/**
 * Resolve the per-app `say` profile (mute, voice, rate, volume), then speak via the
 * macOS TTS provider. Used by callers that want the same profile-aware behaviour as
 * the `tools say` CLI without re-implementing config resolution.
 *
 * Mute precedence:
 *   - global.mute → silence
 *   - apps[<app>|default].mute === true → silence
 */
export async function speakWithProfile(options: SpeakWithProfileOptions): Promise<void> {
    const { text, app, wait } = options;
    const mgr = new SayConfigManager();

    if (await mgr.isMuted(app)) {
        process.stderr.write("[say] muted\n");
        return;
    }

    const profile = await mgr.resolveApp(app);
    const volume = profile.volume != null ? normalizeVolume(profile.volume) : undefined;

    // `provider` stays "local", NOT "macos": it is a KIND, meaning "the first
    // available local speaker", and naming macos outright would silently stop
    // honouring anything else that registers as one. `app: "say"` is what lets
    // `defaults.app.say.tts` override that without this file knowing about it.
    await ai.speak(text, {
        provider: "local",
        app: "say",
        voice: profile.voice ?? undefined,
        rate: profile.rate ?? undefined,
        volume,
        wait,
    });
}
