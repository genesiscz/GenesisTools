//
//  PathAction.swift
//  GenesisKit
//
//  The verbs a file or a folder can offer. A host picks and orders them per kind
//  (`GenesisKitMarkdownConfiguration.folderActions` / `.fileActions`); the menu that shows them
//  supplies the handlers for the verbs that need its window (the sidebar ones).
//

import Foundation

public enum PathAction: String, CaseIterable, Sendable, Codable {
    /// Reveal it in the file sidebar: an animated scroll to the row and a highlight.
    case showInSidebar
    /// Root the file sidebar at the folder (a file: its folder) and pulse it.
    case navigateInSidebar
    /// A folder opens in Finder; a file is revealed there.
    case openInFinder
    /// Cursor on the whole folder (a file: its folder, with the file opened).
    case openInCursor
    /// The app macOS opens the file with.
    case openInDefaultApp
    case openInObsidian
    case openInTerminal
    case copyPath
    /// The file sidebar's text search, limited to the folder.
    case searchInFolder
    case newFile
    case newFolder
    case rename
    case duplicate
    case trash

    public static let folderDefaults: [PathAction] = [
        .showInSidebar, .navigateInSidebar, .searchInFolder, .newFile, .newFolder,
        .openInFinder, .openInCursor, .openInTerminal, .copyPath,
    ]

    public static let fileDefaults: [PathAction] = [
        .showInSidebar, .openInDefaultApp, .openInObsidian, .openInFinder, .openInCursor,
        .copyPath, .rename, .duplicate, .trash,
    ]
}
