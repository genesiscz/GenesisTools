import {
    RecordingPresets,
    requestRecordingPermissionsAsync,
    setAudioModeAsync,
    useAudioRecorder,
    useAudioRecorderState,
} from "expo-audio";
import { useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { useDashboardClient } from "@/api/client-provider";
import { transcribeClip } from "@/features/agents/queries";
import { idempotencyKey } from "@/features/answer-queue/units";
import { useThemeColors } from "@/theme/colors";

/** The longest clip; a spoken instruction is short, and the Mac refuses a body over 8 MB. */
const MAX_CLIP_MS = 90_000;

/**
 * The walkie-talkie (F12): tap to record, tap again to stop. The clip goes to the Mac, which transcribes it and sends
 * nothing; the text lands in the composer for one check, and the composer's Send is the one tap that sends it.
 * Recording uses expo-audio (D20: Expo first), AAC in an M4A container, foreground only.
 */
export function WalkieTalkie({ onText }: { onText: (text: string) => void }) {
    const c = useThemeColors();
    const client = useDashboardClient();
    const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
    const state = useAudioRecorderState(recorder, 250);
    const [busy, setBusy] = useState<"idle" | "starting" | "transcribing">("idle");
    const [error, setError] = useState<string | null>(null);

    const start = async () => {
        setError(null);
        setBusy("starting");

        try {
            const permission = await requestRecordingPermissionsAsync();

            if (!permission.granted) {
                Alert.alert("Microphone is off", "Allow the microphone in Settings to talk to an agent.");
                return;
            }

            await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
            await recorder.prepareToRecordAsync();
            recorder.record({ forDuration: MAX_CLIP_MS / 1000 });
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy("idle");
        }
    };

    const stop = async () => {
        setBusy("transcribing");

        try {
            await recorder.stop();
            await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
            const uri = recorder.uri;

            if (!uri) {
                setError("the recording has no file");
                return;
            }

            const clip = await (await fetch(uri)).blob();
            const receipt = await transcribeClip(client, {
                clip,
                contentType: "audio/m4a",
                idempotencyKey: idempotencyKey(),
            });

            if (!receipt.text) {
                setError("the Mac heard nothing in the clip");
                return;
            }

            onText(receipt.text);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy("idle");
        }
    };

    const recording = state.isRecording;
    const seconds = Math.round(state.durationMillis / 1000);

    return (
        <View className="gap-1">
            <Pressable
                testID="btn-walkie-talkie"
                accessibilityRole="button"
                accessibilityLabel={recording ? "Stop recording" : "Record a voice message"}
                accessibilityHint="The Mac turns it into text in the composer; nothing is sent until you tap Send"
                disabled={busy !== "idle"}
                onPress={() => void (recording ? stop() : start())}
                className="items-center justify-center rounded-xl px-3 py-2"
                style={{
                    borderWidth: 1,
                    borderColor: recording ? c.danger : c.accentGlow,
                    backgroundColor: recording ? "rgba(248, 113, 113, 0.12)" : "transparent",
                }}
            >
                <Text style={{ color: recording ? c.danger : c.accent, fontWeight: "700" }}>
                    {busy === "transcribing"
                        ? "Listening…"
                        : recording
                          ? `Stop ${seconds}s`
                          : busy === "starting"
                            ? "…"
                            : "Talk"}
                </Text>
            </Pressable>
            {error ? (
                <Text testID="walkie-error" style={{ color: c.danger, fontSize: 11 }}>
                    {error}
                </Text>
            ) : null}
        </View>
    );
}
