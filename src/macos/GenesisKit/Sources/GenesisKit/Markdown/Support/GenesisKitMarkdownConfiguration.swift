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
    /// How tabs fall into groups by themselves (`MarkdownTabGrouping`). `.off` keeps one flat row.
    @Published public var tabGrouping: MarkdownTabGroupRule { didSet { store(tabGrouping.rawValue, "tabGrouping") } }
    /// Groups appear once this many tabs are open; fewer stay one plain row. 0 groups always.
    @Published public var tabGroupFrom: Int { didSet { store(tabGroupFrom, "tabGroupFrom") } }
    /// An automatic group smaller than this joins "Other".
    @Published public var tabGroupMinimum: Int { didSet { store(tabGroupMinimum, "tabGroupMinimum") } }
    /// A Project group with more tabs than this splits by its next folder.
    @Published public var tabGroupSplitAbove: Int { didSet { store(tabGroupSplitAbove, "tabGroupSplitAbove") } }
    /// Wrapped tabs: groups flow one after another (the default), or each open group starts its own rows.
    @Published public var tabGroupRows: Bool { didSet { store(tabGroupRows, "tabGroupRows") } }
    /// Wrapped tabs take at most this many rows and scroll past them, with a fade at the cut edge. 0 is no limit.
    /// Picking a row count drops a dragged height.
    @Published public var wrapTabsMaxRows: Int {
        didSet {
            store(wrapTabsMaxRows, "wrapTabsMaxRows")
            tabBarHeight = 0
        }
    }
    /// The wrapped bar's tallest height in points, dragged on its bottom edge. 0 follows `wrapTabsMaxRows`.
    @Published public var tabBarHeight: Double { didSet { store(tabBarHeight, "tabBarHeight") } }
    /// The reader's in-place edits: group order, collapsed groups, names, tabs moved by hand.
    @Published public var tabGroupState: MarkdownTabGroupState {
        didSet { if let data = try? JSONEncoder().encode(tabGroupState) { store(data, "tabGroupState") } }
    }

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

    // MARK: Editor

    /// The source editor opens the list of notes after `[[` and of tags after `#word` by itself. Off: Esc opens it.
    @Published public var completeWhileTyping: Bool { didSet { store(completeWhileTyping, "completeWhileTyping") } }

    // MARK: Git

    /// Every git control: the file's state, the gutter, the Changes mode, the history and the tree marks. A note
    /// outside a repository shows none of them either way.
    @Published public var git: Bool { didSet { store(git, "git") } }
    /// Bars beside the lines that differ from HEAD, in the editor and on the page.
    @Published public var gitGutter: Bool { didSet { store(gitGutter, "gitGutter") } }
    /// M, A, U and D marks on file tree rows and tabs, and a dot on folders that hold changes.
    @Published public var gitTreeDecorations: Bool { didSet { store(gitTreeDecorations, "gitTreeDecorations") } }
    /// Which agent session and turn wrote a changed line (GenesisTools' `tools agents blame`).
    @Published public var gitAgentAttribution: Bool { didSet { store(gitAgentAttribution, "gitAgentAttribution") } }
    /// The scope the Changes mode opens with.
    @Published public var gitDefaultScope: GitFileScope { didSet { store(gitDefaultScope.rawValue, "gitDefaultScope") } }

    /// One switch for a part of the git integration: its own setting, and only while git as a whole is on.
    public func gitShows(_ part: KeyPath<GenesisKitMarkdownConfiguration, Bool>) -> Bool {
        git && self[keyPath: part]
    }

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
        tabGrouping = string("tabGrouping").flatMap(MarkdownTabGroupRule.init(rawValue:)) ?? .smart
        func int(_ key: String, _ fallback: Int) -> Int { defaults.object(forKey: Self.prefix + key) as? Int ?? fallback }
        tabGroupFrom = int("tabGroupFrom", 10)
        tabGroupMinimum = int("tabGroupMinimum", 2)
        tabGroupSplitAbove = int("tabGroupSplitAbove", 12)
        tabGroupRows = bool("tabGroupRows", false)
        wrapTabsMaxRows = int("wrapTabsMaxRows", 4)
        tabBarHeight = double("tabBarHeight", 0)
        tabGroupState = defaults.data(forKey: Self.prefix + "tabGroupState")
            .flatMap { try? JSONDecoder().decode(MarkdownTabGroupState.self, from: $0) } ?? MarkdownTabGroupState()
        contrast = string("contrast").flatMap(MarkdownContrast.init(rawValue:)) ?? .high
        toolbarLabels = string("toolbarLabels").flatMap(MarkdownToolbarLabels.init(rawValue:)) ?? .whenRoom
        treeFontScalesWithWidth = bool("treeFontScalesWithWidth", true)
        treeFontSize = double("treeFontSize", 13)
        headingAnchors = bool("headingAnchors", true)
        codeBlockBar = bool("codeBlockBar", true)
        stickySection = bool("stickySection", true)
        scrollbarMatchMarks = bool("scrollbarMatchMarks", true)
        completeWhileTyping = bool("completeWhileTyping", true)
        git = bool("git", true)
        gitGutter = bool("gitGutter", true)
        gitTreeDecorations = bool("gitTreeDecorations", true)
        gitAgentAttribution = bool("gitAgentAttribution", true)
        gitDefaultScope = string("gitDefaultScope").flatMap(GitFileScope.init(rawValue:)) ?? .uncommitted
    }

    private func store(_ value: Any, _ key: String) {
        defaults.set(value, forKey: Self.prefix + key)
    }
}
