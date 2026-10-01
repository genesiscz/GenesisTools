import SwiftUI

/// A path you can act on, the one component for every file or folder path on screen. A click does
/// the right thing for what is on disk (`PathOpener.primary`): a folder opens in Finder, a file opens
/// in Cursor at `line`, a missing path says so. A right-click lists every action (Finder, reveal,
/// Cursor, cmux, copy); the icons copy, reveal and open in Cursor.
/// A context menu, not a SwiftUI `Menu`: a Menu whose label truncates inside a header HStack sent
/// AttributeGraph into a layout cycle and crashed the GenesisTools hub (2026-09-24).
public struct PathLabel: View {
    let path: String
    var font: Font
    var showIcons: Bool
    var findField: String
    var line: Int?
    var title: String?
    var color: Color

    /// `line`: a file's line, where the click opens Cursor. `title`: the shown text instead of the
    /// path ("~/…"), for a row that names a folder by its last component and keeps every action of
    /// the full path. `findField`: the key a panel find lists this text under.
    public init(
        path: String,
        font: Font = .system(size: 11, design: .monospaced),
        showIcons: Bool = true,
        findField: String = "path",
        line: Int? = nil,
        title: String? = nil,
        color: Color = KitPalette.dim
    ) {
        self.path = path
        self.font = font
        self.showIcons = showIcons
        self.findField = findField
        self.line = line
        self.title = title
        self.color = color
    }

    /// The shown text ("~/…"): what a panel find row lists under `findField`.
    public static func display(_ path: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        if path == home {
            return "~"
        }

        // Only below the home folder: a sibling such as `/Users/mean` keeps its full path.
        return path.hasPrefix(home + "/") ? "~" + path.dropFirst(home.count) : path
    }

    public var body: some View {
        let display = Self.display(path)
        HStack(spacing: 2) {
            Button {
                GenesisKit.log("pathLabel.click \(display)")
                PathOpener.primary(path, line: line)
            } label: {
                KitFindText(text: title ?? display, field: findField).font(font).foregroundColor(color).lineLimit(1).truncationMode(.middle)
            }
            .buttonStyle(.genHoverPlain())
            .instantTooltip("\(display)\(line.map { ":\($0)" } ?? "")\nClick to open it. Right-click for Finder, Cursor, cmux and copy.")
            .contextMenu { PathActionsMenu(path: path, line: line) }
            if showIcons {
                IconButton(systemName: "doc.on.doc", tooltip: "Copy path", size: 10) { PathOpener.copy(path, what: "path") }
                IconButton(systemName: "folder", tooltip: "Reveal in Finder", size: 10) { PathOpener.reveal(path) }
                IconButton(systemName: "chevron.left.forwardslash.chevron.right", tooltip: "Open in Cursor", size: 10) { PathOpener.cursor(path, line: line) }
            }
        }
    }
}

/// Every action on a path, for a `.contextMenu` on any row that shows one.
public struct PathActionsMenu: View {
    let path: String
    var line: Int?

    public init(path: String, line: Int? = nil) {
        self.path = path
        self.line = line
    }

    public var body: some View {
        Button("Open in Finder") { PathOpener.finder(path) }
        Button("Reveal in Finder") { PathOpener.reveal(path) }
        Button("Open in Cursor") { PathOpener.cursor(path, line: line) }
        if GenesisKit.host?.opensTerminal == true {
            Button("Open in a new cmux workspace") { PathOpener.cmux(path) }
        }
        Divider()
        Button("Copy path") { PathOpener.copy(path, what: "path") }
        Button("Copy ~ path") { PathOpener.copy(PathLabel.display(path), what: "path") }
    }
}
