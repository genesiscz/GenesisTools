// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Focus/AppIconService.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import AppKit
import SwiftUI

/// App icons for the focus surfaces, cached by bundle id.
///
/// Adapted from Rewind's `AppIconService`
/// (`/Users/Martin/Tresors/Projects/Rewind/apps/timetravel-app/TimeTravel/TimeTravel/App/AppIconService.swift`),
/// with the same two lessons it learned the hard way: cache the resized copies, and cache the
/// fallback per size too, or every body pass of every row re-runs `lockFocus` and a draw.
///
/// Resolution is disk work the first time (`urlForApplication` + `icon(forFile:)`), so the
/// studio preloads the bundles it is about to draw rather than discovering them inside a body.
@MainActor
public final class AppIconService {
    public static let shared = AppIconService()

    private var cache: [String: NSImage] = [:]
    private var fallbackCache: [Int: NSImage] = [:]
    /// Bundle ids that resolved to nothing, so a missing app is not re-probed on every row.
    private var unresolved: Set<String> = []

    private lazy var fallback: NSImage = {
        NSImage(systemSymbolName: "app.dashed", accessibilityDescription: "Unknown app") ?? NSImage()
    }()

    private init() {}

    public func icon(for bundleId: String?, size: CGFloat = 16) -> NSImage {
        guard let bundleId, !bundleId.isEmpty, !unresolved.contains(bundleId) else {
            return fallbackIcon(size: size)
        }
        let key = "\(bundleId)@\(Int(size))"
        if let cached = cache[key] { return cached }

        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
            unresolved.insert(bundleId)
            return fallbackIcon(size: size)
        }
        let resized = resize(NSWorkspace.shared.icon(forFile: url.path), to: size)
        cache[key] = resized
        return resized
    }

    /// Resolve ahead of drawing, so the first frame of a reloaded Studio is not doing disk work
    /// inside a view body.
    public func preload(_ bundleIds: [String?], sizes: [CGFloat] = [14, 16]) {
        for bundleId in bundleIds {
            for size in sizes { _ = icon(for: bundleId, size: size) }
        }
    }

    public func clear() {
        cache.removeAll()
        fallbackCache.removeAll()
        unresolved.removeAll()
    }

    private func fallbackIcon(size: CGFloat) -> NSImage {
        let key = Int(size)
        if let cached = fallbackCache[key] { return cached }
        let resized = resize(fallback, to: size)
        fallbackCache[key] = resized
        return resized
    }

    private func resize(_ image: NSImage, to size: CGFloat) -> NSImage {
        let target = NSSize(width: size, height: size)
        let resized = NSImage(size: target)
        resized.lockFocus()
        image.draw(in: NSRect(origin: .zero, size: target),
                   from: NSRect(origin: .zero, size: image.size),
                   operation: .sourceOver, fraction: 1)
        resized.unlockFocus()
        return resized
    }
}

/// The icon of one app, at one of three sizes. Decorative by default: the app name is always
/// written next to it, so VoiceOver reads the name once rather than twice.
public struct AppIcon: View {
    public let bundleId: String?
    public var size: CGFloat = 14
    public var cornerRadius: CGFloat = 3

    public var body: some View {
        Image(nsImage: AppIconService.shared.icon(for: bundleId, size: size))
            .resizable()
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .accessibilityHidden(true)
    }
}
