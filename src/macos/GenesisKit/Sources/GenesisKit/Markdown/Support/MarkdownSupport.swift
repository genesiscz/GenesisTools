//
//  MarkdownSupport.swift
//  GenesisKit
//
//  The renderer choice and the companion palette the markdown chat style uses.
//

import SwiftUI

/// The markdown renderer a pane uses. The raw values are stored in UserDefaults (`markdownWindow.renderer`), so
/// they never change.
public enum MarkdownRenderer: String, CaseIterable, Identifiable, Sendable {
    /// WKWebView: markdown-it, highlight.js and mermaid, offline.
    case web
    /// Native Swift baseline: flat code, no diagrams.
    case native
    /// Native with BeautifulMermaid diagrams and highlighted code.
    case nativeRich

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .web: "Web"
        case .native: "Native"
        case .nativeRich: "Native+"
        }
    }

    public var icon: String {
        switch self {
        case .web: "globe"
        case .native: "swift"
        case .nativeRich: "sparkles"
        }
    }

    public var detail: String {
        switch self {
        case .web: "Web: diagrams and highlighted code, works offline"
        case .native: "Native: plain code, no diagrams"
        case .nativeRich: "Native+: diagrams and highlighted code, drawn natively"
        }
    }

    /// The toolbar cycles web → native → nativeRich → web.
    public var next: MarkdownRenderer {
        switch self {
        case .web: .native
        case .native: .nativeRich
        case .nativeRich: .web
        }
    }
}

extension Color {
    static let companionTeal = Color(red: 0x35 / 255.0, green: 0xE5 / 255.0, blue: 0xCC / 255.0)
    static let companionTealDim = Color(red: 0x7F / 255.0, green: 0xE8 / 255.0, blue: 0xD6 / 255.0)
    static let companionInk = Color(red: 0xEA / 255.0, green: 0xF7 / 255.0, blue: 0xFF / 255.0)
    static let companionDim = Color(red: 0x8F / 255.0, green: 0xB0 / 255.0, blue: 0xAC / 255.0)
    static let companionAssistInk = Color(red: 0xE2 / 255.0, green: 0xFF / 255.0, blue: 0xF9 / 255.0)
}
