import AppKit
import ScreenCaptureKit

/// Draws a window for a `--snapshot` run as the window server composes it, Liquid Glass included.
///
/// `cacheDisplay` draws the layer tree on the CPU (`CALayer.render(in:)`), and that renderer skips the backdrop and
/// portal layers a `.glassEffect` is made of. SwiftUI routes the content a glass view samples through those portals
/// too, so a settings page holding glass came out transparent: one glass search field blanked its card, two (Projects /
/// Sessions since 2026-10-10) blanked the whole page, and under the Glass theme every card is glass, so every page was
/// blank. The live window was never affected: the window server draws the same layers.
///
/// ScreenCaptureKit captures that composite, but it also applies the window's alpha, so the alpha-0 snapshot window
/// would come out empty. The window is therefore lowered to the minimum level, and only once an opaque desktop picture
/// covers all of it does it become opaque for the capture. It never shows on screen. Without a Screen Recording grant,
/// or with nothing covering it, the snapshot falls back to `cacheDisplay` and says so.
@MainActor
public enum WindowSnapshot {
    public struct Capture {
        public let image: NSBitmapImageRep
        /// "window server", or "cacheDisplay (<why>; Liquid Glass and what it covers stay transparent)".
        public let method: String
    }

    /// A row of `CGWindowListCopyWindowInfo`, reduced to what decides whether a window is hidden.
    public struct ListedWindow: Equatable {
        public var number: Int
        public var layer: Int
        public var alpha: Double
        public var bounds: CGRect

        public init(number: Int, layer: Int, alpha: Double, bounds: CGRect) {
            self.number = number
            self.layer = layer
            self.alpha = alpha
            self.bounds = bounds
        }

        init?(_ info: [String: Any]) {
            guard let number = info[kCGWindowNumber as String] as? Int,
                  let layer = info[kCGWindowLayer as String] as? Int,
                  let bounds = info[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary)
            else { return nil }
            self.init(number: number, layer: layer, alpha: info[kCGWindowAlpha as String] as? Double ?? 1, bounds: rect)
        }
    }

    /// The window `capture` draws `window` with.
    public static func capture(_ window: NSWindow) async -> Capture? {
        let reason: String
        if CGPreflightScreenCaptureAccess() {
            do {
                return Capture(image: try await windowServerImage(window), method: "window server")
            } catch {
                reason = (error as? Failure)?.description ?? error.localizedDescription
            }
        } else {
            reason = "no Screen Recording grant"
        }

        guard let view = window.contentView, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
            return nil
        }

        view.cacheDisplay(in: view.bounds, to: rep)
        return Capture(image: rep, method: "cacheDisplay (\(reason); Liquid Glass and what it covers stay transparent)")
    }

    /// Whether a desktop picture (a window at or below the desktop level, opaque) covers all of `bounds`. Desktop icons
    /// sit above the desktop level and are transparent between the icons, so they never count.
    public static func coveredByDesktopPicture(_ bounds: CGRect, above: [ListedWindow], desktopLevel: Int) -> Bool {
        above.contains { $0.layer <= desktopLevel && $0.alpha >= 1 && $0.bounds.contains(bounds) }
    }

    private enum Failure: Error, CustomStringConvertible {
        case notHidden, notListed, noAnswer
        case screenCaptureKit(String)

        var description: String {
            switch self {
            case .notHidden: return "no desktop picture covers the window"
            case .notListed: return "ScreenCaptureKit does not list the window"
            case .noAnswer: return "the window server did not answer within \(WindowSnapshot.windowServerDeadline)"
            case .screenCaptureKit(let message): return message
            }
        }
    }

    /// How long the window server may take to list the window and draw it before the capture falls back.
    nonisolated static let windowServerDeadline: Duration = .seconds(10)

    private static func listed(_ window: NSWindow, _ option: CGWindowListOption) -> [ListedWindow] {
        (CGWindowListCopyWindowInfo(option, CGWindowID(window.windowNumber)) as? [[String: Any]] ?? [])
            .compactMap(ListedWindow.init)
    }

    /// The window's own row once `done` holds, or nil after 2 s. The window server applies a level or alpha change
    /// asynchronously: right after `window.level = …` the window still lists at its old layer.
    private static func settled(_ window: NSWindow, until done: (ListedWindow) -> Bool) async throws -> ListedWindow? {
        let deadline = ContinuousClock.now + .seconds(2)
        while true {
            if let own = listed(window, .optionIncludingWindow).first(where: { $0.number == window.windowNumber }),
               done(own)
            {
                return own
            }

            guard ContinuousClock.now < deadline else { return nil }
            try await Task.sleep(for: .milliseconds(100))
        }
    }

    private static func windowServerImage(_ window: NSWindow) async throws -> NSBitmapImageRep {
        let level = window.level
        let alpha = window.alphaValue
        defer {
            window.alphaValue = alpha
            window.level = level
        }

        let minimum = Int(CGWindowLevelForKey(.minimumWindow))
        window.level = NSWindow.Level(rawValue: minimum)
        guard let own = try await settled(window, until: { $0.layer == minimum }),
              coveredByDesktopPicture(own.bounds, above: listed(window, .optionOnScreenAboveWindow),
                                      desktopLevel: Int(CGWindowLevelForKey(.desktopWindow)))
        else { throw Failure.notHidden }

        window.alphaValue = 1
        guard try await settled(window, until: { $0.alpha >= 1 }) != nil else { throw Failure.notHidden }
        let number = CGWindowID(window.windowNumber)
        // The window server can stop answering, and ScreenCaptureKit ignores cancellation: past the deadline the capture
        // falls back to `cacheDisplay` and the late answer is dropped.
        let capture = Task { () -> Result<CGImage, Failure> in
            do {
                return .success(try await serverImage(number))
            } catch {
                return .failure(error as? Failure ?? .screenCaptureKit(error.localizedDescription))
            }
        }
        guard let answer = await MediaThumbnailCache.firstResult(of: capture, within: windowServerDeadline) else {
            throw Failure.noAnswer
        }

        return NSBitmapImageRep(cgImage: try answer.get())
    }

    private static func serverImage(_ number: CGWindowID) async throws -> CGImage {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let target = content.windows.first(where: { $0.windowID == number }) else { throw Failure.notListed }
        let filter = SCContentFilter(desktopIndependentWindow: target)
        let info = SCShareableContent.info(for: filter)
        let configuration = SCStreamConfiguration()
        configuration.width = Int((info.contentRect.width * CGFloat(info.pointPixelScale)).rounded())
        configuration.height = Int((info.contentRect.height * CGFloat(info.pointPixelScale)).rounded())
        configuration.showsCursor = false
        configuration.ignoreShadowsSingleWindow = true
        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    }
}
