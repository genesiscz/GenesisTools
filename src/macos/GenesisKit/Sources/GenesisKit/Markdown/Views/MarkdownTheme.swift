//
//  MarkdownTheme.swift
//  GenesisKit
//
//  One palette for the whole standalone markdown window: the native chrome
//  (toolbar, find bar, tabs, outline, status bar) and the rendered page share
//  it, so the frame and the document never disagree on what "dark" is. The
//  page side is a set of CSS variables the web renderer already reads
//  (`--dd-*`), which is why a theme is a dictionary and not a second stylesheet.
//
//  A theme is a palette at a contrast (`GenesisKitMarkdownConfiguration.contrast`). The model hands the
//  configured contrast to the theme, so every view keeps reading `model.theme.textSecondary` and gets the
//  brighter text without knowing the setting exists.
//

import SwiftUI

struct MarkdownTheme: Hashable, Identifiable {
    enum Palette: String, CaseIterable {
        /// Neutral dark, the dev-dashboard palette the renderer was written for.
        case genesis
        /// Obsidian's default dark theme: warmer greys, purple accent.
        case obsidian
        /// Paper: white page, dark code blocks kept as they are.
        case light
    }

    var palette: Palette
    var contrast: MarkdownContrast = .high

    static let genesis = MarkdownTheme(palette: .genesis)
    static let obsidian = MarkdownTheme(palette: .obsidian)
    static let light = MarkdownTheme(palette: .light)

    /// Every palette at the default contrast, in the order the status bar cycles them.
    static var allCases: [MarkdownTheme] { Palette.allCases.map { MarkdownTheme(palette: $0) } }

    init(palette: Palette, contrast: MarkdownContrast = .high) {
        self.palette = palette
        self.contrast = contrast
    }

    /// The palette a stored name names (`markdownWindow.theme`); nil for an unknown one.
    init?(rawValue: String, contrast: MarkdownContrast = .high) {
        guard let palette = Palette(rawValue: rawValue) else { return nil }
        self.init(palette: palette, contrast: contrast)
    }

    /// The palette's stored name. The contrast is a setting of its own, never part of the name.
    var rawValue: String { palette.rawValue }
    var id: String { rawValue }

    var label: String {
        switch palette {
        case .genesis: "Genesis"
        case .obsidian: "Obsidian"
        case .light: "Light"
        }
    }

    var icon: String {
        switch palette {
        case .genesis: "circle.lefthalf.filled"
        case .obsidian: "moon.fill"
        case .light: "sun.max.fill"
        }
    }

    /// The next palette, at the same contrast.
    var next: MarkdownTheme {
        switch palette {
        case .genesis: MarkdownTheme(palette: .obsidian, contrast: contrast)
        case .obsidian: MarkdownTheme(palette: .light, contrast: contrast)
        case .light: MarkdownTheme(palette: .genesis, contrast: contrast)
        }
    }

    var isDark: Bool { palette != .light }

    // MARK: - Colour values

    // One 0xRRGGBB value per colour, read by both the native chrome (`Color`) and the page (`--dd-*`), so the
    // two sides cannot drift apart. The tests compute the contrast ratios from these.

    var pageHex: UInt32 {
        switch palette {
        case .genesis: 0x0c0e10
        case .obsidian: 0x1e1e1e
        case .light: 0xffffff
        }
    }

    var chromeHex: UInt32 {
        switch palette {
        case .genesis: 0x101316
        case .obsidian: 0x262626
        case .light: 0xf5f5f7
        }
    }

    var textHex: UInt32 {
        switch palette {
        case .genesis: 0xe6edf3
        case .obsidian: 0xdcddde
        case .light: 0x1f2328
        }
    }

    /// `.high` is at least 7:1 on the chrome (the status bar, toolbar labels, tree rows), and whiter: Martin
    /// read the old greys as "bad contrast, too gray" (2026-10-13). The light theme stays dark on light.
    var textSecondaryHex: UInt32 {
        switch (palette, contrast) {
        case (.genesis, .standard): 0x8b96a0
        case (.genesis, .high): 0xb6c0ca
        case (.obsidian, .standard): 0x999999
        case (.obsidian, .high): 0xc0c0c0
        case (.light, .standard): 0x57606a
        case (.light, .high): 0x424a53
        }
    }

    /// `.high` is at least 4.5:1 on the chrome and still a step below `textSecondary`, so the order of
    /// importance survives. In `.standard` the light theme's 4.8:1 is the floor: the status bar and the
    /// folder path are readable information in this colour, and #8b949e was 2.8:1.
    var textMutedHex: UInt32 {
        switch (palette, contrast) {
        case (.genesis, .standard): 0x5b6670
        case (.genesis, .high): 0x939fab
        case (.obsidian, .standard): 0x6f6f6f
        case (.obsidian, .high): 0x9a9a9a
        case (.light, .standard): 0x656d76
        case (.light, .high): 0x5c6570
        }
    }

    // MARK: - Native chrome

    /// Behind the document.
    var page: Color { Color(hex: pageHex) }

    /// Toolbar, find bar, tab bar, outline, status bar.
    var chrome: Color { Color(hex: chromeHex) }

    var border: Color {
        switch palette {
        case .genesis: Color(hex: 0x1e2428)
        case .obsidian: Color(hex: 0x363636)
        case .light: Color(hex: 0xe2e4e8)
        }
    }

    /// A frame that has to read against the window behind it: the floating hover preview.
    var borderStrong: Color {
        switch palette {
        case .genesis: Color(hex: 0x2a3439)
        case .obsidian: Color(hex: 0x4a4a4a)
        case .light: Color(hex: 0xc9ced4)
        }
    }

    var text: Color { Color(hex: textHex) }

    var textSecondary: Color { Color(hex: textSecondaryHex) }

    var textMuted: Color { Color(hex: textMutedHex) }

    /// Active outline row, on-state of toolbar toggles.
    var accent: Color {
        switch palette {
        case .genesis: .neonAmber
        case .obsidian: Color(hex: 0xa78bfa)
        case .light: Color(hex: 0x0969da)
        }
    }

    /// Hover and selected-tab fill; a tint of the text colour, so it reads on
    /// both a dark and a light chrome.
    var fill: Color {
        isDark ? Color.white.opacity(0.08) : Color.black.opacity(0.06)
    }

    // MARK: - Page (web renderer)

    /// The `--dd-*` variables the renderer's stylesheet reads, plus
    /// `color-scheme` so the scrollbars and form controls follow.
    var cssVariables: [String: String] {
        var vars: [String: String]
        switch palette {
        case .genesis:
            vars = [
                "color-scheme": "dark",
                "--dd-bg-elevated": "#161b20",
                "--dd-border": "#1e2428", "--dd-border-strong": "#2a3439",
                "--dd-text-strong": "#f4f8fb",
                "--dd-accent": "#34d399", "--dd-accent-2": "#2dd4bf", "--dd-link": "#5eead4",
                "--dd-link-underline": "rgba(94,234,212,0.3)",
                "--dd-tag-bg": "rgba(52,211,153,0.1)", "--dd-tag-text": "#5eead4",
                "--dd-code-bg": "#0a0c0f", "--dd-code-text": "#e6edf3",
            ]
        case .obsidian:
            vars = [
                "color-scheme": "dark",
                "--dd-bg-elevated": "#2a2a2a",
                "--dd-border": "#363636", "--dd-border-strong": "#4a4a4a",
                "--dd-text-strong": "#ffffff",
                "--dd-accent": "#a78bfa", "--dd-accent-2": "#8b5cf6", "--dd-link": "#a78bfa",
                "--dd-link-underline": "rgba(167,139,250,0.35)",
                "--dd-tag-bg": "rgba(167,139,250,0.12)", "--dd-tag-text": "#c4b5fd",
                "--dd-code-bg": "#161616", "--dd-code-text": "#dcddde",
            ]
        case .light:
            vars = [
                "color-scheme": "light",
                "--dd-bg-elevated": "#eef0f3",
                "--dd-border": "#e2e4e8", "--dd-border-strong": "#c9ced4",
                "--dd-text-strong": "#0b0f14",
                "--dd-accent": "#0969da", "--dd-accent-2": "#0a7ea4", "--dd-link": "#0969da",
                "--dd-link-underline": "rgba(9,105,218,0.3)",
                "--dd-tag-bg": "rgba(9,105,218,0.08)", "--dd-tag-text": "#0969da",
                "--dd-code-bg": "#0a0c0f", "--dd-code-text": "#e6edf3",
            ]
        }
        vars["--dd-bg"] = Self.css(pageHex)
        vars["--dd-bg-panel"] = Self.css(chromeHex)
        vars["--dd-text"] = Self.css(textHex)
        vars["--dd-text-dim"] = Self.css(textSecondaryHex)
        vars["--dd-text-faint"] = Self.css(textMutedHex)
        return vars
    }

    /// `#rrggbb`.
    static func css(_ hex: UInt32) -> String {
        "#" + String(format: "%06x", hex & 0xffffff)
    }

    // MARK: - Contrast

    /// The WCAG 2 contrast ratio of two sRGB colours, 1 (none) to 21 (black on white).
    static func contrastRatio(_ a: UInt32, _ b: UInt32) -> Double {
        let la = luminance(a)
        let lb = luminance(b)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    /// WCAG relative luminance of a 0xRRGGBB colour.
    static func luminance(_ hex: UInt32) -> Double {
        func linear(_ channel: UInt32) -> Double {
            let s = Double(channel & 0xff) / 255
            return s <= 0.04045 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(hex >> 16) + 0.7152 * linear(hex >> 8) + 0.0722 * linear(hex)
    }
}

private extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue: Double(hex & 0xff) / 255
        )
    }
}
