//
//  GitFailure.swift
//  GenesisKit
//
//  A failed git read as the user reads it: one sentence that says what happened and what to do, and the raw text
//  (git's stderr, the command) for a Details disclosure. The git components show `message`; `detail` never stands in
//  for it.
//

import Foundation

public struct GitFailure: Equatable, Sendable {
    /// One plain sentence.
    public var message: String
    /// The raw error, for Details; nil when it says no more than `message`.
    public var detail: String?

    public init(message: String, detail: String? = nil) {
        self.message = message
        self.detail = detail
    }

    /// `error` mapped to a sentence; `fallback` is the sentence for a cause this does not know.
    public init(_ error: Error, fallback: String) {
        if case ReviewError.notRepository = error {
            self.init(message: "\(error)")
            return
        }
        let raw = "\(error)".trimmed
        let message = Self.sentence(for: raw) ?? fallback
        self.init(message: message, detail: raw.isEmpty || raw == message ? nil : raw)
    }

    /// The sentence for a known cause in git's or the provider's raw text, nil for an unknown one.
    static func sentence(for raw: String) -> String? {
        let text = raw.lowercased()
        func has(_ needles: String...) -> Bool { needles.contains { text.contains($0) } }
        if has("not a git repository") {
            return "This folder is not in a git repository."
        }
        if has("no merge base", "shares no history") {
            return "This branch shares no history with its base branch, so there is nothing to compare."
        }
        if has("index.lock", "another git process") {
            return "Another git command is using this repository. Try again in a moment."
        }
        if has("is not in this file's history") {
            return "That commit did not change this file."
        }
        if has("fetch the pr branch", "fetch the base branch") {
            return "That commit is not in this repository. Fetch its branch, then try again."
        }
        if has("exists on disk, but not in", "does not exist in", "invalid object name", "unknown revision", "bad revision", "invalid commit") {
            return "That version of the file is not in git."
        }
        if has("launch path not accessible", "xcrun: error", "no developer tools", "command line tools") {
            return "Git could not start. Check that git or the Xcode command line tools are installed."
        }
        if text.hasPrefix("tools ") && text.contains(" exited ") {
            return "GenesisTools did not answer. Try again."
        }
        return nil
    }
}

extension GitFailure {
    /// A failure whose sentence the thrower already knows, through code that throws.
    struct Thrown: Error {
        let failure: GitFailure
    }
}
