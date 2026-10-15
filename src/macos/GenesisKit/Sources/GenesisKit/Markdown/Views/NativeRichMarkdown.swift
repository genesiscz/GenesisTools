//
//  NativeRichMarkdown.swift
//  GenesisKit
//
//  Engine 3 — the fully-native vault reading pane. No WKWebView, no CDN, no JS
//  runtime for layout: mermaid diagrams render through BeautifulMermaid (an
//  all-Swift ELK-layout port → NSImage) and code blocks through Highlighter
//  (hljs atom-one-dark in JavaScriptCore → NSAttributedString). Everything else
//  reuses the shared MarkdownBlockView.
//
//  This is `RichBlockView`: a thin decorator over MarkdownBlockView that only
//  special-cases fenced code — `mermaid` fences become diagrams, other fences
//  get real syntax highlighting. MarkdownPreviewView(rich: true) swaps its
//  per-block renderer to this, keeping its scroll-to-heading + search-blink.
//

import SwiftUI
import AppKit
import BeautifulMermaid
import Highlighter

// MARK: - Highlighter engine (cached; JSC context is expensive to build)

/// Wraps a single Highlighter instance configured for atom-one-dark. Creating a
/// Highlighter spins up a JavaScriptCore context + loads highlight.js, so we
/// build it once, lazily, and reuse it. Not thread-safe — only touched from the
/// main actor (SwiftUI rendering).
@MainActor
public enum NativeCodeHighlighter {
    private static let shared: Highlighter? = {
        guard let hl = Highlighter() else { return nil }
        _ = hl.setTheme("atom-one-dark", withFont: "Menlo", ofSize: 11)
        return hl
    }()

    /// hljs language ids for the aliases vault notes actually use.
    private static let alias: [String: String] = [
        "ts": "typescript", "tsx": "typescript", "js": "javascript", "jsx": "javascript",
        "sh": "bash", "shell": "bash", "zsh": "bash", "yml": "yaml",
        "rb": "ruby", "py": "python", "rs": "rust",
    ]

    /// Highlighted attributed string, or nil if the engine/lang is unavailable
    /// (caller falls back to plain text).
    public static func highlight(_ code: String, language: String?) -> AttributedString? {
        guard let hl = shared else { return nil }
        let lang = language.map { alias[$0.lowercased()] ?? $0.lowercased() }
        guard let ns = hl.highlight(code, as: lang) else { return nil }
        return AttributedString(ns)
    }
}

// MARK: - Mermaid theme (dark, blends with the near-black vault pane)

private extension DiagramTheme {
    /// atom-one-dark-ish, transparent background so the vault reading bg shows
    /// through and the diagram matches the surrounding code theme.
    static let genesisVault = DiagramTheme(
        background: BMColor(hex: "#0c0e10"),
        foreground: BMColor(hex: "#e6edf3")
    ).withTransparent(true)
}

// MARK: - Rich block renderer

/// Renders ONE markdown block natively-rich: mermaid → diagram, code → hljs,
/// everything else → the shared MarkdownBlockView.
struct RichBlockView: View {
    let block: MarkdownBlocks.Block
    var style: MarkdownStyle = .vault

    var body: some View {
        switch block {
        case .code(let language, let code, _):
            if language?.lowercased() == "mermaid" {
                MermaidBlockView(source: code, style: style)
            } else {
                RichCodeBlockView(language: language, code: code, style: style)
            }
        default:
            MarkdownBlockView(block: block, style: style)
        }
    }
}

/// A fenced code block with real hljs highlighting (falls back to the flat
/// MarkdownBlockView rendering if the JSC engine is unavailable).
private struct RichCodeBlockView: View {
    let language: String?
    let code: String
    var style: MarkdownStyle

    var body: some View {
        if let highlighted = NativeCodeHighlighter.highlight(code, language: language) {
            // hljs set the font and the colours; the shared chrome adds the language, Copy and the frame.
            MarkdownCodeBlock(language: language, code: code, text: highlighted, style: style, preStyled: true)
        } else {
            // Engine unavailable — reuse the shared flat code renderer.
            MarkdownBlockView(block: .code(language: language, code: code, index: 0), style: style)
        }
    }
}

/// A mermaid diagram rendered to an NSImage off the main actor, with a code
/// fallback if parsing/layout fails (native mermaid covers ~6 diagram types).
private struct MermaidBlockView: View {
    let source: String
    var style: MarkdownStyle

    @State private var image: NSImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                // Full-size + horizontally scrollable (Obsidian parity) — never
                // shrink the diagram to the column width. Vertical extent flows
                // in the outer reading ScrollView (no nested-scroll conflict).
                ScrollView(.horizontal, showsIndicators: true) {
                    Image(nsImage: image)
                        .resizable()
                        .interpolation(.high)
                        // BeautifulMermaid renders into a bottom-left CGContext
                        // without a y-flip → the NSImage is vertically inverted
                        // (arrows up, text upside-down). Flip it back on display.
                        .scaleEffect(x: 1, y: -1)
                        .frame(width: image.size.width, height: image.size.height)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(style.codeBackground)
                .clipShape(RoundedRectangle(cornerRadius: GenRadius.sm))
            } else if failed {
                // Unsupported diagram type / parse error — show the source.
                MarkdownBlockView(block: .code(language: "mermaid", code: source, index: 0), style: style)
            } else {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("rendering diagram…")
                        .font(GenTypography.mono(10))
                        .foregroundColor(style.mutedColor)
                }
                .padding(12)
            }
        }
        .task(id: source) { await renderImage() }
    }

    private func renderImage() async {
        let src = source
        let rendered: NSImage? = await Task.detached(priority: .userInitiated) {
            try? MermaidRenderer.renderImage(source: src, theme: .genesisVault, scale: 2.0)
        }.value
        if let rendered {
            image = rendered
            failed = false
        } else {
            image = nil
            failed = true
        }
    }
}
