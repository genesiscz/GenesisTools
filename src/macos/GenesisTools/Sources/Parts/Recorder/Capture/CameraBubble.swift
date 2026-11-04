import AppKit

/// The camera bubble beside a recording (item 2 of the capture work fills this in): its preview window ids, which the
/// movie leaves out, and the hooks the picker and the live recordings call.
@MainActor
final class CameraBubble {
    static let shared = CameraBubble()

    var windowIDs: [Int] { [] }

    func optionChanged(_ on: Bool) {}

    func pickerClosed(started: Bool) {}

    func liveRecordingsChanged(_ recordings: [LiveRecording]) {}
}
