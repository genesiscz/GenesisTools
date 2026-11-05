import { requireOptionalNativeModule } from "expo";
import { lazy, Suspense } from "react";

/**
 * The walkie-talkie (F12). expo-audio's native module is required when its package is imported, and expo-router loads
 * every route at start, so a build made before the module was added would crash at launch. The recorder is loaded
 * only when the module is in this build; without it the button is absent until the next native build.
 */
const Recorder = lazy(() => import("./WalkieTalkieRecorder"));

const HAS_AUDIO = requireOptionalNativeModule("ExpoAudio") !== null;

export function WalkieTalkie({ onText }: { onText: (text: string) => void }) {
    if (!HAS_AUDIO) {
        return null;
    }

    return (
        <Suspense fallback={null}>
            <Recorder onText={onText} />
        </Suspense>
    );
}
