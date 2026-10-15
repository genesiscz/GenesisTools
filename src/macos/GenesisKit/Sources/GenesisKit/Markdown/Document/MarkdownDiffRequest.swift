//
//  MarkdownDiffRequest.swift
//  GenesisKit
//
//  The changes a viewer is asked to show: `genesis-md://open?path=…&diff=staged`, `genesis open --diff staged`,
//  `GenesisTools --markdown note.md --diff staged`. An agent shows "what I changed in this note" in one call.
//

import Foundation

public struct MarkdownDiffRequest: Equatable, Sendable {
    public var scope: GitFileScope
    /// A commit for `lastCommit`; nil means the newest commit that changed the file.
    public var commit: String?

    public init(scope: GitFileScope, commit: String? = nil) {
        self.scope = scope
        self.commit = commit
    }

    /// `unstaged`, `staged`, `uncommitted`, `branch`, `last` (the newest commit that changed the file) or
    /// `commit:<sha>`; nil for anything else.
    public static func parse(_ value: String?) -> MarkdownDiffRequest? {
        guard let value = value?.trimmingCharacters(in: .whitespaces).lowercased(), !value.isEmpty else { return nil }
        if value == "last" || value == "lastcommit" { return MarkdownDiffRequest(scope: .lastCommit) }
        if value.hasPrefix("commit:") {
            let sha = String(value.dropFirst("commit:".count))
            guard !sha.isEmpty, sha.allSatisfy(\.isHexDigit) else { return nil }
            return MarkdownDiffRequest(scope: .lastCommit, commit: sha)
        }
        return GitFileScope(rawValue: value).map { MarkdownDiffRequest(scope: $0) }
    }

    /// The `diff=` query item of an open URL.
    public static func fromQuery(_ items: [URLQueryItem]) -> MarkdownDiffRequest? {
        parse(items.first(where: { $0.name == "diff" })?.value)
    }

    /// The `diff=` value an open URL carries.
    public var queryValue: String {
        if scope == .lastCommit { return commit.map { "commit:\($0)" } ?? "last" }
        return scope.rawValue
    }
}

extension MarkdownDocumentsModel {
    /// The selected file in the Changes mode at the request's scope.
    func showChanges(_ request: MarkdownDiffRequest) {
        revisionView = nil
        revisionCompare = nil
        changesScope = request.scope
        changesCommit = request.commit
        setMode(.changes)
    }
}
