import CoreGraphics
import Foundation

/// What a screen recording does when the display configuration changes under it.
public enum DisplayChangeAction: Equatable {
    case ignore
    /// `--follow-focus`: record the display that now holds focus.
    case switchToFocus
    /// The recorded display is gone: stop and print every frame kept so far.
    case end
}

/// The decision for one `CGDisplayRegisterReconfigurationCallback` call. Only the removal (or disabling, as when it
/// joins a mirror set) of the display being recorded matters; the `beginConfiguration` pass carries no outcome yet.
public func displayChangeAction(changed: CGDirectDisplayID, flags: CGDisplayChangeSummaryFlags,
                                recorded: CGDirectDisplayID, followFocus: Bool) -> DisplayChangeAction {
    guard changed == recorded, !flags.contains(.beginConfigurationFlag),
          flags.contains(.removeFlag) || flags.contains(.disabledFlag) else {
        return .ignore
    }

    return followFocus ? .switchToFocus : .end
}

/// Why a recording ended before its duration, as `endedEarly` names it.
public enum CaptureEarlyEnd: String {
    case displayRemoved = "display-removed"
    case streamError = "stream-error"
    case stopped
}

/// A missing display explains a stream error, so it wins; a stream error wins over a stop request that came after it.
public func captureEarlyEnd(cancelled: Bool, displayRemoved: Bool, streamFailed: Bool) -> CaptureEarlyEnd? {
    if displayRemoved {
        return .displayRemoved
    }

    if streamFailed {
        return .streamError
    }

    return cancelled ? .stopped : nil
}

public struct DisplayFrame: Equatable {
    public let id: CGDirectDisplayID
    public let bounds: CGRect

    public init(id: CGDirectDisplayID, bounds: CGRect) {
        self.id = id
        self.bounds = bounds
    }
}

/// The display `--follow-focus` records: the one holding most of the focused window, else the one under the mouse,
/// else the first display. All rectangles and points are global CoreGraphics coordinates.
public func focusDisplay(window: CGRect?, mouse: CGPoint?, displays: [DisplayFrame]) -> CGDirectDisplayID? {
    if let window, !window.isEmpty {
        let best = displays
            .map { display -> (id: CGDirectDisplayID, area: CGFloat) in
                let overlap = display.bounds.intersection(window)
                return (display.id, overlap.isNull ? 0 : overlap.width * overlap.height)
            }
            .max { $0.area < $1.area }
        if let best, best.area > 0 {
            return best.id
        }
    }

    if let mouse, let under = displays.first(where: { $0.bounds.contains(mouse) }) {
        return under.id
    }

    return displays.first?.id
}

/// Scales `size` down so its longer side is at most `maxLongSide` pixels, keeping the aspect ratio; `even` rounds both
/// sides down to even numbers, as H.264 needs.
public func capLongSide(_ size: CGSize, maxLongSide: Int?, even: Bool) -> CGSize {
    var width = size.width
    var height = size.height
    if let maxLongSide, maxLongSide > 0, max(width, height) > CGFloat(maxLongSide) {
        let scale = CGFloat(maxLongSide) / max(width, height)
        width = max(2, (width * scale).rounded(.down))
        height = max(2, (height * scale).rounded(.down))
    }

    guard even else { return CGSize(width: width, height: height) }

    return CGSize(width: CGFloat(Int(width) & ~1), height: CGFloat(Int(height) & ~1))
}

/// `--max-mb` as bytes.
public func maxBytes(megabytes: Double?) -> Int? {
    guard let megabytes, megabytes > 0 else { return nil }

    return Int((megabytes * 1_048_576).rounded())
}

/// Backing pixels per point of a display, 1 when the width is unknown.
public func displayScale(pixelWidth: CGFloat, pointWidth: CGFloat) -> CGFloat {
    guard pixelWidth > 0, pointWidth > 0 else { return 1 }

    return pixelWidth / pointWidth
}

/// One `--control-stdin` command line.
public enum CaptureCommand: Equatable {
    case switchDisplay(CGDirectDisplayID)
    case pause
    case resume
    case stop
    case status
    case mute(CaptureAudioSource)
    case unmute(CaptureAudioSource)
    case setMic(String)
    case setFps(active: Double?, idle: Double?)
    case setThreshold(Double)
    /// nil removes the cap.
    case setMaxLongSide(Int?)
}

public struct CaptureCommandError: Error, Equatable {
    public let message: String
}

private func number(_ value: Any?) -> Double? {
    guard let raw = value as? NSNumber, CFGetTypeID(raw) != CFBooleanGetTypeID() else { return nil }
    let double = raw.doubleValue
    return double.isFinite ? double : nil
}

/// Parses one command line. A blank line is nil. Ranges match the flags: active fps 0.5–120, idle fps 0.1–5,
/// threshold 0–100, max long side 16–16384 (0 or null removes it).
public func parseCaptureCommand(_ line: String) -> Result<CaptureCommand, CaptureCommandError>? {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    guard let data = trimmed.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let cmd = object["cmd"] as? String else {
        return .failure(CaptureCommandError(message: "a command is one JSON object with a \"cmd\" string"))
    }
    func fail(_ message: String) -> Result<CaptureCommand, CaptureCommandError> {
        .failure(CaptureCommandError(message: message))
    }

    switch cmd {
    case "switch":
        guard let id = number(object["displayId"]), id == id.rounded(), id > 0, id <= Double(UInt32.max) else {
            return fail("switch needs a positive integer displayId")
        }
        return .success(.switchDisplay(CGDirectDisplayID(id)))
    case "pause":
        return .success(.pause)
    case "resume":
        return .success(.resume)
    case "stop":
        return .success(.stop)
    case "status":
        return .success(.status)
    case "mute", "unmute":
        guard let raw = object["source"] as? String, let source = CaptureAudioSource(rawValue: raw) else {
            return fail("\(cmd) needs source \"mic\" or \"system\"")
        }
        return .success(cmd == "mute" ? .mute(source) : .unmute(source))
    case "set-mic":
        guard let id = object["deviceId"] as? String, !id.isEmpty else {
            return fail("set-mic needs a deviceId string from `ax-tool audio-devices`")
        }
        return .success(.setMic(id))
    case "set-fps":
        let active = number(object["active"])
        let idle = number(object["idle"])
        guard active != nil || idle != nil else { return fail("set-fps needs active and/or idle") }
        if let active, !(0.5...120).contains(active) { return fail("set-fps active must be between 0.5 and 120") }
        if let idle, !(0.1...5).contains(idle) { return fail("set-fps idle must be between 0.1 and 5") }
        return .success(.setFps(active: active, idle: idle))
    case "set-threshold":
        guard let percent = number(object["percent"]), (0...100).contains(percent) else {
            return fail("set-threshold needs percent between 0 and 100")
        }
        return .success(.setThreshold(percent))
    case "set-max-long-side":
        if object["px"] is NSNull {
            return .success(.setMaxLongSide(nil))
        }
        guard let px = number(object["px"]), px == px.rounded(), px == 0 || (16...16384).contains(px) else {
            return fail("set-max-long-side needs integer px between 16 and 16384, or 0 to remove the cap")
        }
        return .success(.setMaxLongSide(px == 0 ? nil : Int(px)))
    default:
        return fail("unknown cmd \"\(cmd)\"; use switch, pause, resume, stop, status, mute, unmute, set-mic, set-fps, set-threshold or set-max-long-side")
    }
}

/// An audio source `--audio` records.
public enum CaptureAudioSource: String, CaseIterable {
    case system
    case mic
}

/// `--audio system,mic`: one or both, no repeats.
public func parseAudioSources(_ raw: String) -> Result<[CaptureAudioSource], CaptureCommandError> {
    let parts = raw.split(separator: ",", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
    var sources: [CaptureAudioSource] = []
    for part in parts {
        guard let source = CaptureAudioSource(rawValue: part) else {
            return .failure(CaptureCommandError(message: "--audio takes system, mic or system,mic"))
        }
        if !sources.contains(source) {
            sources.append(source)
        }
    }
    return .success(sources)
}

/// The largest absolute sample of float PCM.
public func peakAmplitude(float32 samples: UnsafeBufferPointer<Float>) -> Float {
    var peak: Float = 0
    for sample in samples where sample.isFinite {
        peak = max(peak, abs(sample))
    }
    return peak
}

/// The largest absolute sample of 16-bit PCM, as a fraction of full scale.
public func peakAmplitude(int16 samples: UnsafeBufferPointer<Int16>) -> Float {
    var peak: Int32 = 0
    for sample in samples {
        peak = max(peak, abs(Int32(sample)))
    }
    return Float(peak) / 32768
}

/// A peak in dBFS, rounded to 0.1 dB; nil for digital silence.
public func peakDbfs(_ peak: Float) -> Double? {
    guard peak > 0 else { return nil }

    return (20 * log10(Double(peak)) * 10).rounded() / 10
}
