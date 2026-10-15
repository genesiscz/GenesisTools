//
//  MarkdownDocumentsModel+Find.swift
//  GenesisKit
//
//  The find panel's behaviour beyond the plain search: the option toggles and
//  where they are remembered, Enter and Shift+Enter, find in selection, ⌘F
//  taking the selection as its query, and "find in all open tabs". The state
//  lives in the find section of MarkdownDocumentsModel.swift.
//

import AppKit
import WebKit

/// Where find in selection limits the source search: a range of one tab's text.
struct MarkdownFindScope: Equatable {
    var docId: String
    var range: NSRange
}

/// A selection the source editor reported. `byUser` is false for the ones find
/// itself made (selecting a match) and for a text change from outside.
struct MarkdownEditorSelection: Equatable {
    var docId: String
    var range: NSRange
    var byUser: Bool
}

/// One row of "find in all open tabs": a tab with matches, how many, and the
/// first matching line.
struct MarkdownFindTabHit: Identifiable, Equatable {
    let id: String
    let title: String
    let path: String
    let count: Int
    let snippet: String
    /// Where the match sits in `snippet`, so the row can mark it.
    let snippetMatch: NSRange
    let isSelected: Bool
}

extension MarkdownFindOptions {
    static let matchCaseKey = "markdownWindow.find.matchCase"
    static let wholeWordKey = "markdownWindow.find.wholeWord"
    static let regexKey = "markdownWindow.find.regex"

    init(defaults: UserDefaults) {
        self.init(
            matchCase: defaults.bool(forKey: Self.matchCaseKey),
            wholeWord: defaults.bool(forKey: Self.wholeWordKey),
            regex: defaults.bool(forKey: Self.regexKey)
        )
    }

    func save(to defaults: UserDefaults) {
        defaults.set(matchCase, forKey: Self.matchCaseKey)
        defaults.set(wholeWord, forKey: Self.wholeWordKey)
        defaults.set(regex, forKey: Self.regexKey)
    }
}

extension MarkdownFindCommand {
    /// The options as the page's `window.gnFind` reads them.
    var jsOptions: String {
        let scope = scope.map(String.init) ?? "null"
        return "{matchCase:\(options.matchCase),wholeWord:\(options.wholeWord),regex:\(options.regex),"
            + "scope:\(scope),ticks:\(scrollbarMarks)}"
    }
}

extension MarkdownDocumentsModel {
    /// Why the query cannot run, for the counter; nil = it can. The source
    /// side compiles the pattern itself, the page reports a pattern its own
    /// engine refuses as index -1.
    var findPatternError: String? {
        guard !findQuery.isEmpty else { return nil }
        if let error = SourceFind.patternError(findQuery, options: findOptions) { return error }
        return findIndex < 0 ? SourceFind.invalidPattern : nil
    }

    /// Enter in the find field walks forward, Shift+Enter back, as in Cursor
    /// and every browser. ⌘G / ⇧⌘G do the same from anywhere in the window.
    func submitFind(shift: Bool) {
        stepFind(shift ? -1 : 1)
    }

    /// The rendered page's tally after a find command. In split view the
    /// editor's search owns the counter and the walk (find in selection
    /// included), so the preview only marks and its count is dropped.
    func webFindResult(index: Int, count: Int) {
        guard !findsInSource else { return }
        findIndex = index
        findCount = count
    }

    /// The range the source search is limited to, or nil for the whole text:
    /// find in selection is off, it took no selection, or it belongs to another tab.
    var activeSourceScope: NSRange? {
        guard findInSelection, let scope = findScope, scope.docId == selected?.id, scope.range.length > 0 else {
            return nil
        }
        return scope.range
    }

    /// Find in selection on or off. On takes the selection of this moment: the
    /// reader's last selection in the editor, and (through a new token) the
    /// page's DOM selection. With nothing selected it searches the whole text.
    func setFindInSelection(_ on: Bool) {
        guard on != findInSelection else { return }
        findInSelection = on
        findScope = nil
        if on {
            findScopeToken &+= 1
            if findsInSource, let doc = selected, let picked = editorUserSelection,
               picked.docId == doc.id, picked.range.length > 0 {
                findScope = MarkdownFindScope(docId: doc.id, range: picked.range)
            }
        }
        // A new scope starts from its own first match, not from the old index.
        findIndex = 0
        search()
    }

    /// A replace inside the scope moves its end, so the scope keeps covering
    /// the same text.
    func growFindScope(by delta: Int) {
        guard delta != 0, activeSourceScope != nil, var scope = findScope else { return }
        scope.range.length = max(0, scope.range.length + delta)
        findScope = scope
    }

    /// The source editor's selection moved. Called on every caret move, so it
    /// only stores.
    func editorSelectionChanged(_ range: NSRange, byUser: Bool, in docId: String) {
        let selection = MarkdownEditorSelection(docId: docId, range: range, byUser: byUser)
        editorSelection = selection
        if byUser { editorUserSelection = selection }
    }

    /// ⌘F takes a one-line selection as the query: the editor's when the
    /// search runs over the source, else the page's (read from its DOM, so it
    /// lands a moment later and selects the field again).
    func seedFindFromSelection() {
        if findsInSource {
            guard let picked = editorSelection, picked.byUser, picked.range.length > 0,
                  let doc = selected, picked.docId == doc.id else { return }
            let text = doc.displayText as NSString
            guard NSMaxRange(picked.range) <= text.length,
                  let seed = SourceFind.seed(from: text.substring(with: picked.range), regex: findOptions.regex) else { return }
            findQuery = seed
        } else if mode.showsPreview, renderer == .web, let web = webProxy.web {
            web.evaluateJavaScript("window.getSelection().toString()") { [weak self] result, _ in
                guard let self, let text = result as? String,
                      let seed = SourceFind.seed(from: text, regex: self.findOptions.regex),
                      seed != self.findQuery else { return }
                self.findQuery = seed
                self.findFocusToken &+= 1
            }
        }
    }

    /// Every open tab with a match for the query and the match options (find
    /// in selection belongs to one tab, so it does not apply), in tab order.
    /// Runs over each tab's text, so tabs that are not on screen count too.
    func findAllTabsHits() -> [MarkdownFindTabHit] {
        let options = findOptions
        guard !findQuery.isEmpty, SourceFind.patternError(findQuery, options: options) == nil else { return [] }
        let current = selected?.id
        return docs.compactMap { doc in
            let text = doc.displayText
            let hits = SourceFind.matches(in: text, query: findQuery, options: options)
            guard let first = hits.first else { return nil }
            let snippet = SourceFind.snippet(in: text, around: first)
            return MarkdownFindTabHit(
                id: doc.id, title: doc.title, path: doc.url.path, count: hits.count,
                snippet: snippet.text, snippetMatch: snippet.match, isSelected: doc.id == current
            )
        }
    }

    /// A row of "find in all open tabs": that tab, with the search run there
    /// (`select` re-runs it while the panel is open).
    func openFindHit(_ hit: MarkdownFindTabHit) {
        guard docs.contains(where: { $0.id == hit.id }) else { return }
        if selected?.id == hit.id {
            search()
        } else {
            select(hit.id)
        }
    }
}
