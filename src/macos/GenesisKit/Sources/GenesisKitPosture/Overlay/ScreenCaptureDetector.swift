import Darwin
import Foundation
import GenesisKit

/// Tells whether something captures the screen right now: a screen share (Zoom, Meet, Teams, FaceTime), a recording
/// (QuickTime, the screenshot toolbar's recorder, OBS) or an always-on recorder.
///
/// Why it exists: on macOS 15 and later, ScreenCaptureKit ignores `NSWindow.sharingType = .none`, and Apple's own
/// documentation calls that value a legacy constant that must not be used to keep content out of a capture. No public
/// API keeps a window out of another app's capture, and none reports that a capture runs. So the overlay asks
/// WindowServer instead and hides what must not be seen while a capture runs (see `ScreenCaptureBehavior`).
///
/// What it reads: WindowServer's "screen watcher present" flag (`SLSIsScreenWatcherPresent` in the private SkyLight
/// framework, `CGSIsScreenWatcherPresent` in CoreGraphics as a fallback), looked up at run time with `dlsym`, so the
/// kit links against no private symbol.
///
/// Measured on macOS 26.3 (2026-10-13): false at rest; true within 0.1 s after a ScreenCaptureKit stream starts (a
/// 16 by 16 pixel display stream) and while `screencapture -v` records; false again within a second after either
/// stops. One call costs about 5 ns.
///
/// What it does not guarantee:
/// - It is private API. A later macOS can remove or change the symbol; then `current()` returns nil and
///   `isAvailable` is false. `ScreenEffectsController` treats that "unknown" as "capturing".
/// - It is not checked against Zoom, Meet, Teams or FaceTime themselves, only against ScreenCaptureKit and
///   `screencapture`, which those apps use on macOS 15 and later.
/// - Any capture counts, not only a share: a screenshot tool, an always-on recorder, this app's own capture.
/// - It is a flag, not an event: callers poll it. Between two polls a capture can start, so a frame or two of a
///   share can still show what was on screen when it started.
/// - A capture outside this Mac (a camera pointed at the screen, a capture card on a display cable) is invisible to it.
public enum ScreenCaptureDetector {
    /// True when this macOS still has the check.
    public static var isAvailable: Bool { check != nil }

    /// True while a screen capture runs, false when none does, nil when this macOS has no way to tell.
    public static func current() -> Bool? {
        guard let check else { return nil }
        // Read as one byte: the flag is a C `bool`, whatever register width the caller assumes.
        return check() != 0
    }

    private typealias Check = @convention(c) () -> UInt8

    private static let check: Check? = {
        let candidates = [
            ("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", "SLSIsScreenWatcherPresent"),
            ("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", "CGSIsScreenWatcherPresent"),
        ]
        for (path, name) in candidates {
            guard let handle = dlopen(path, RTLD_LAZY | RTLD_NOLOAD) ?? dlopen(path, RTLD_LAZY),
                  let symbol = dlsym(handle, name)
            else { continue }
            return unsafeBitCast(symbol, to: Check.self)
        }
        return nil
    }()
}
