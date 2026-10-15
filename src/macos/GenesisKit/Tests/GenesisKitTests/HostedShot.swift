import AppKit
@testable import GenesisKit
import SwiftUI
import XCTest

/// A SwiftUI view drawn into a PNG from a borderless window that never comes to the front.
@MainActor
enum HostedShot {
    static func host(_ view: some View, size: CGSize) -> (NSWindow, NSView) {
        _ = NSApplication.shared
        let host = NSHostingView(rootView: AnyView(view.frame(width: size.width, height: size.height)))
        let window = NSWindow(contentRect: CGRect(x: -10000, y: -10000, width: size.width, height: size.height),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.contentView = host
        window.order(.below, relativeTo: 0)
        host.layoutSubtreeIfNeeded()
        return (window, host)
    }

    static func bitmap(_ view: NSView) -> NSBitmapImageRep? {
        view.layoutSubtreeIfNeeded()
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return nil }
        view.cacheDisplay(in: view.bounds, to: rep)
        return rep
    }

    /// Frames one under another, a hairline between them.
    static func writeStrip(_ frames: [NSBitmapImageRep], to url: URL) throws {
        guard let first = frames.first else { return }
        let width = first.pixelsWide
        let gap = 2
        let height = frames.reduce(0) { $0 + $1.pixelsHigh } + gap * (frames.count - 1)
        let strip = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
                                                   samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                                   bytesPerRow: 0, bitsPerPixel: 0))
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: strip)
        NSColor(white: 0.45, alpha: 1).setFill()
        NSRect(x: 0, y: 0, width: width, height: height).fill()
        var top = height
        for frame in frames {
            top -= frame.pixelsHigh
            frame.draw(in: NSRect(x: 0, y: top, width: width, height: frame.pixelsHigh))
            top -= gap
        }
        NSGraphicsContext.restoreGraphicsState()
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try XCTUnwrap(strip.representation(using: .png, properties: [:])).write(to: url)
        print("shot \(url.path) \(width)x\(height)")
    }

    static func write(_ view: some View, size: CGSize, settle: TimeInterval = 0.4, to url: URL) throws {
        let (window, host) = host(view, size: size)
        defer { window.close() }
        RunLoop.main.run(until: Date().addingTimeInterval(settle))
        let rep = try XCTUnwrap(bitmap(host))
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: url)
        print("shot \(url.path) \(rep.pixelsWide)x\(rep.pixelsHigh)")
    }
}
