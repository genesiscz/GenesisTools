import AppKit
import SwiftUI

/// The colours both apps draw these components in: GenesisTools' hub palette (`ReviewPalette`),
/// which Genesis's session screens match. Dark only.
public enum KitPalette {
    public static let background = NSColor(srgbRed: 0.075, green: 0.075, blue: 0.08, alpha: 1)
    public static let hairline = Color.white.opacity(0.08)
    public static let added = Color(red: 0.36, green: 0.80, blue: 0.47)
    public static let removed = Color(red: 0.96, green: 0.38, blue: 0.40)
    public static let modified = Color(red: 0.98, green: 0.66, blue: 0.25)
    public static let renamed = Color(red: 0.45, green: 0.62, blue: 0.98)
    public static let dim = Color.white.opacity(0.5)
    /// Hints and secondary labels in dense rows ("new tab", "window").
    public static let faint = Color.white.opacity(0.32)
    public static let text = Color.white.opacity(0.9)
}

/// The hover styles' tokens (Genesis's `Theme.swift` values), kept apart from the apps' own
/// `Color.genAccent` / `GenRadius` so the two never collide.
public enum KitTheme {
    public static let accent = Color(red: 1.0, green: 0.76, blue: 0.28)
    public static let radiusSmall: CGFloat = 6
    public static let radiusMedium: CGFloat = 10
    public static let quick = Animation.easeOut(duration: 0.15)
}
