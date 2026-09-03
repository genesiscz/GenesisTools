#!/usr/bin/env swift
//
// build-icon.swift — render the GenesisTools mark into AppIcon.iconset next to this script,
// then iconutil it into AppIcon.icns. `tools macos permissions build` copies that .icns into
// the bundle, so a notification or a Finder tile shows the mark instead of a blank page.
//
// Ported from GenesisPlayground/Genesis/apps/Genesis/scripts/build-icon.swift: same dark
// rounded square and the same amber `sparkles` mark, so the two apps read as one family.
// The difference that says "tools", not "Genesis", is a golden ring around the mark.
//
// Re-run after changing anything here:  swift src/macos/GenesisTools/scripts/build-icon.swift
//

import AppKit
import Foundation

let scriptDir = (CommandLine.arguments[0] as NSString).deletingLastPathComponent
let outDir = scriptDir + "/AppIcon.iconset"
try? FileManager.default.removeItem(atPath: outDir)
try FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

let sizes: [(name: String, px: Int)] = [
    ("icon_16x16",      16),  ("icon_16x16@2x",   32),
    ("icon_32x32",      32),  ("icon_32x32@2x",   64),
    ("icon_128x128",   128),  ("icon_128x128@2x", 256),
    ("icon_256x256",   256),  ("icon_256x256@2x", 512),
    ("icon_512x512",   512),  ("icon_512x512@2x",1024),
]

// Genesis's palette, unchanged: the family resemblance is the point.
let symbolName = "sparkles"
let bgColor    = NSColor(red: 0.06, green: 0.07, blue: 0.10, alpha: 1)
let strokeTop  = NSColor(red: 1.00, green: 0.74, blue: 0.20, alpha: 1)
let strokeBot  = NSColor(red: 1.00, green: 0.46, blue: 0.10, alpha: 1)
let glowColor  = NSColor(red: 1.00, green: 0.60, blue: 0.20, alpha: 0.6)

// The GenesisTools difference: a golden ring around the mark.
let ringOuter  = NSColor(red: 1.00, green: 0.84, blue: 0.42, alpha: 1)
let ringInner  = NSColor(red: 0.85, green: 0.58, blue: 0.13, alpha: 1)

func render(px: Int) -> Data? {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil,
                                     pixelsWide: px, pixelsHigh: px,
                                     bitsPerSample: 8, samplesPerPixel: 4,
                                     hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB,
                                     bytesPerRow: 0, bitsPerPixel: 0)
    else { return nil }
    rep.size = NSSize(width: px, height: px)

    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }
    guard let gctx = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
    NSGraphicsContext.current = gctx
    gctx.imageInterpolation = .high

    let side = CGFloat(px)
    let radius = side * 0.225
    let rect = NSRect(x: 0, y: 0, width: side, height: side).insetBy(dx: side * 0.08, dy: side * 0.08)
    let bgPath = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
    bgColor.set()
    bgPath.fill()
    NSColor(white: 1, alpha: 0.08).set()
    bgPath.lineWidth = max(1, side * 0.005)
    bgPath.stroke()

    // Ring first, so the sparkles sit on top of it and stay the brightest thing in the tile.
    //
    // 16px gets NO ring: at that size a 1px circle plus a mark inside it is a blob, and the
    // Finder/Spotlight tile reads as a smudge (verified against a magnified render). There the
    // icon falls back to Genesis's plain mark, which is the right family look anyway.
    // 32/64px thin the ring and hug the edge so the mark keeps its room.
    let drawsRing = side >= 32
    let small = side <= 64
    let ringWidth = max(1, side * (small ? 0.035 : 0.045))
    let ringInset = side * (small ? 0.025 : 0.045)
    let ringRect = rect.insetBy(dx: ringInset + ringWidth / 2, dy: ringInset + ringWidth / 2)

    if drawsRing {
        let ringPath = NSBezierPath(ovalIn: ringRect)
        ringPath.lineWidth = ringWidth

        let ringShadow = NSShadow()
        ringShadow.shadowColor = glowColor.withAlphaComponent(0.45)
        ringShadow.shadowBlurRadius = side * 0.04
        ringShadow.shadowOffset = .zero
        NSGraphicsContext.saveGraphicsState()
        ringShadow.set()
        ringInner.set()
        ringPath.stroke()
        NSGraphicsContext.restoreGraphicsState()

        // Top-lit gradient on the ring: clip to the stroked band, then fill it with a gradient.
        NSGraphicsContext.saveGraphicsState()
        let outline = CGPath(__byStroking: ringPath.cgPath, transform: nil,
                             lineWidth: ringWidth, lineCap: .round, lineJoin: .round, miterLimit: 10)
        if let outline {
            NSBezierPath(cgPath: outline).addClip()
            let gradient = NSGradient(starting: ringOuter, ending: ringInner)
            gradient?.draw(in: ringRect.insetBy(dx: -ringWidth, dy: -ringWidth), angle: -90)
        }
        NSGraphicsContext.restoreGraphicsState()
    }

    // Mark sized to sit inside the ring; without a ring it takes Genesis's full 0.62.
    let pointSize = side * (drawsRing ? (small ? 0.58 : 0.54) : 0.62)
    var cfg = NSImage.SymbolConfiguration(pointSize: pointSize, weight: .bold)
    cfg = cfg.applying(NSImage.SymbolConfiguration(paletteColors: [strokeTop, strokeBot]))
    guard let raw = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil),
          let symbol = raw.withSymbolConfiguration(cfg) else { return nil }

    let s = symbol.size
    let symbolRect = NSRect(x: (side - s.width) / 2,
                            y: (side - s.height) / 2,
                            width: s.width, height: s.height)

    let shadow = NSShadow()
    shadow.shadowColor = glowColor
    shadow.shadowBlurRadius = side * 0.06
    shadow.shadowOffset = NSSize(width: 0, height: -side * 0.01)
    shadow.set()

    symbol.draw(in: symbolRect)

    gctx.flushGraphics()
    return rep.representation(using: .png, properties: [:])
}

for (name, px) in sizes {
    if let png = render(px: px) {
        try png.write(to: URL(fileURLWithPath: "\(outDir)/\(name).png"))
    } else {
        FileHandle.standardError.write(Data("× failed to render \(name) at \(px)x\(px)\n".utf8))
        exit(1)
    }
}

let proc = Process()
proc.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
proc.arguments = ["-c", "icns", outDir, "-o", scriptDir + "/AppIcon.icns"]
try proc.run()
proc.waitUntilExit()
if proc.terminationStatus == 0 {
    FileHandle.standardOutput.write(Data("✓ AppIcon.icns generated\n".utf8))
} else {
    FileHandle.standardError.write(Data("× iconutil failed: \(proc.terminationStatus)\n".utf8))
    exit(1)
}
