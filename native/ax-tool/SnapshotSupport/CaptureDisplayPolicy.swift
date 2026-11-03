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
