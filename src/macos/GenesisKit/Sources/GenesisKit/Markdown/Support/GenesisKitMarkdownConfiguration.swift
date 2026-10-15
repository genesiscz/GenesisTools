//
//  GenesisKitMarkdownConfiguration.swift
//  GenesisKit
//
//  The markdown viewer's tunables in one place: hover previews, tabs, contrast, the toolbar, the file
//  tree, the page extras, and which actions a file or a folder offers. A host sets them at launch; a
//  settings screen can bind to them later. The switches a reader flips in the window are remembered
//  in the defaults, the lists a host chooses are not.
//

import SwiftUI

/// How strongly secondary text stands out from the chrome.
public enum MarkdownContrast: String, CaseIterable, Sendable {
    /// The original greys.
    case standard
    /// Brighter, whiter secondary and muted text. The default.
    case high
}

/// When a toolbar button shows its label beside its icon.
public enum MarkdownToolbarLabels: String, CaseIterable, Sendable {
    case never
    /// Only while the whole row fits at the window's current width.
    case whenRoom
    case always
}

@MainActor
public final class GenesisKitMarkdownConfiguration: ObservableObject {
    public static let shared = GenesisKitMarkdownConfiguration()

    private let defaults: UserDefaults
    private static let prefix = "markdown.config."

    // MARK: Hover previews

    /// A floating, bordered preview of a note after the pointer rests on a link or a tab.
    @Published public var hoverPreview: Bool { didSet { store(hoverPreview, "hoverPreview") } }
    /// How long the pointer rests before the preview opens, in seconds.
    @Published public var hoverPreviewDelay: TimeInterval { didSet { store(hoverPreviewDelay, "hoverPreviewDelay") } }
    /// The floating preview's size, before it is fitted to the screen.
    @Published public var hoverPreviewSize = CGSize(width: 560, height: 440)

    // MARK: Tabs

    /// Tabs wrap onto more rows instead of scrolling sideways.
    @Published public var wrapTabs: Bool { didSet { store(wrapTabs, "wrapTabs") } }
    /// A single click in the file tree opens a preview tab (italic title) that the next single click
    /// replaces. An edit, a double-click or a double-click on the tab keeps it.
    @Published public var previewTabs: Bool { didSet { store(previewTabs, "previewTabs") } }

    // MARK: Chrome

    @Published public var contrast: MarkdownContrast { didSet { store(contrast.rawValue, "contrast") } }
    @Published public var toolbarLabels: MarkdownToolbarLabels { didSet { store(toolbarLabels.rawValue, "toolbarLabels") } }
    /// The file tree's font grows with the sidebar's width.
    @Published public var treeFontScalesWithWidth: Bool { didSet { store(treeFontScalesWithWidth, "treeFontScalesWithWidth") } }
    /// The file tree's font size at the standard sidebar width, in points.
    @Published public var treeFontSize: Double { didSet { store(treeFontSize, "treeFontSize") } }

    // MARK: Page

    /// A `#` link beside a heading on hover; a click copies the heading's link.
    @Published public var headingAnchors: Bool { didSet { store(headingAnchors, "headingAnchors") } }
    /// A bar on every code block: its language and a copy button.
    @Published public var codeBlockBar: Bool { didSet { store(codeBlockBar, "codeBlockBar") } }
    /// The heading of the section on screen, pinned to the top of the page.
    @Published public var stickySection: Bool { didSet { store(stickySection, "stickySection") } }
    /// Ticks on the page's scrollbar where the find matches are.
    @Published public var scrollbarMatchMarks: Bool { didSet { store(scrollbarMatchMarks, "scrollbarMatchMarks") } }

    // MARK: Path actions

    /// What a folder offers (a path segment, a tree folder), in menu order.
    @Published public var folderActions: [PathAction] = PathAction.folderDefaults
    /// What a file offers (the last path segment, a tree file, a tab), in menu order.
    @Published public var fileActions: [PathAction] = PathAction.fileDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        func bool(_ key: String, _ fallback: Bool) -> Bool {
            defaults.object(forKey: Self.prefix + key) as? Bool ?? fallback
        }
        func double(_ key: String, _ fallback: Double) -> Double {
            defaults.object(forKey: Self.prefix + key) as? Double ?? fallback
        }
        func string(_ key: String) -> String? { defaults.string(forKey: Self.prefix + key) }
        hoverPreview = bool("hoverPreview", true)
        hoverPreviewDelay = double("hoverPreviewDelay", 1.0)
        wrapTabs = bool("wrapTabs", false)
        previewTabs = bool("previewTabs", true)
        contrast = string("contrast").flatMap(MarkdownContrast.init(rawValue:)) ?? .high
        toolbarLabels = string("toolbarLabels").flatMap(MarkdownToolbarLabels.init(rawValue:)) ?? .whenRoom
        treeFontScalesWithWidth = bool("treeFontScalesWithWidth", true)
        treeFontSize = double("treeFontSize", 13)
        headingAnchors = bool("headingAnchors", true)
        codeBlockBar = bool("codeBlockBar", true)
        stickySection = bool("stickySection", true)
        scrollbarMatchMarks = bool("scrollbarMatchMarks", true)
    }

    private func store(_ value: Any, _ key: String) {
        defaults.set(value, forKey: Self.prefix + key)
    }
}
