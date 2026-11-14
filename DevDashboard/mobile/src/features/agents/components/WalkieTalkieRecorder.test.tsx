import { afterEach, expect, it, mock } from "bun:test";
import { createElement } from "react";

mock.module("react-native", () => ({
    View: "View",
    Text: "Text",
    Pressable: "View",
    Alert: { alert: () => {} },
    StyleSheet: { flatten: (style: unknown) => style ?? {} },
}));
mock.module("@/theme/colors", () => ({ useThemeColors: () => ({}) }));
mock.module("@/api/client-provider", () => ({ useDashboardClient: () => ({}) }));
const transcribed: string[] = [];
mock.module("@/features/agents/queries", () => ({
    transcribeClip: async (_client: unknown, input: { idempotencyKey: string }) => {
        transcribed.push(input.idempotencyKey);
        return { text: "check the build log" };
    },
}));
let state = { isRecording: false, durationMillis: 0 };
const recorder = {
    isRecording: false,
    uri: "file:///clip.m4a",
    prepareToRecordAsync: async () => {},
    record: () => {
        recorder.isRecording = true;
    },
    stop: async () => {
        recorder.isRecording = false;
    },
};
mock.module("expo-audio", () => ({
    RecordingPresets: { HIGH_QUALITY: {} },
    requestRecordingPermissionsAsync: async () => ({ granted: true }),
    setAudioModeAsync: async () => {},
    useAudioRecorder: () => recorder,
    useAudioRecorderState: () => state,
}));
globalThis.fetch = (async () => new Response("clip")) as unknown as typeof fetch;

const { act, cleanup, fireEvent, render, waitFor } = await import("@testing-library/react-native/pure");
const { default: WalkieTalkieRecorder } = await import("./WalkieTalkieRecorder");
afterEach(cleanup);

it("transcribes a clip the recorder stopped at its limit, once, without a tap on Stop", async () => {
    const heard: string[] = [];
    const element = () => createElement(WalkieTalkieRecorder, { onText: (text: string) => heard.push(text) });
    const view = await render(element());
    await fireEvent.press(view.getByTestId("btn-walkie-talkie"));
    state = { isRecording: true, durationMillis: 1_000 };
    await view.rerender(element());
    recorder.isRecording = false;
    state = { isRecording: false, durationMillis: 90_000 };
    await view.rerender(element());
    await waitFor(() => expect(heard).toEqual(["check the build log"]));
    await act(async () => {
        await view.rerender(element());
    });
    expect(transcribed).toHaveLength(1);
});
