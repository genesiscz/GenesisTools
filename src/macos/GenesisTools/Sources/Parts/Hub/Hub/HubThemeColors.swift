import SwiftUI

// The five Genesis theme colours the hub's overlays use (palette, find, prompts, rules, digest). They
// came with a 900-line copy of Genesis's Theme.swift, of which nothing else was used (2026-09-30).
extension Color {
    static let settingsBackground = Color(red: 0.012, green: 0.012, blue: 0.031)
    static let settingsText = Color.white.opacity(0.92)
    static let settingsTextMuted = Color.white.opacity(0.35)
    static let jarvisTeal = Color(red: 0.0, green: 0.85, blue: 0.72) // #00d9b8
    static let jarvisBorder = Color(red: 0.0, green: 0.85, blue: 1.0).opacity(0.15)
}
