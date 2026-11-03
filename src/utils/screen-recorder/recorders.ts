import { NativeFrameRecorder } from "./native";
import { PeekabooFrameRecorder } from "./peekaboo";
import type { FrameRecorder, FrameRecorderContext, FrameRecorderId } from "./types";

/** One factory per recorder. A new recorder is one class and one line here. */
export const FRAME_RECORDERS: Record<FrameRecorderId, (context: FrameRecorderContext) => FrameRecorder> = {
    native: (context) => new NativeFrameRecorder(context),
    peekaboo: () => new PeekabooFrameRecorder(),
};
