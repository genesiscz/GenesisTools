// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/SessionTranscriptView.swift at 2026-09-24T03:59:06+02:00 at commit hash 0d268a43e86e6e5e0ce16132aed8c862e201923e
// Excerpt: lines 36-161 (TranscriptItem, TranscriptTimeline, ToolKind, summarizeGroup); the views below them depend on the Genesis theme.
import Foundation


// MARK: - Timeline model

enum TranscriptItem: Equatable, Identifiable {
    case user(TranscriptTurn)
    case assistant(TranscriptTurn)
    case work(id: String, at: String?, tools: [TranscriptTool])

    var id: String {
        switch self {
        case .user(let turn): return "u-\(turn.id)"
        case .assistant(let turn): return "a-\(turn.id)"
        case .work(let id, _, _): return "w-\(id)"
        }
    }
}

enum TranscriptTimeline {
    /// Flatten turns into timeline items, merging consecutive tool-bearing
    /// assistant messages into one work group (T3 "tool group" layer 2).
    /// Chronology inside one assistant message is text → tools, so a turn with
    /// both emits its text row first, then opens/extends the group.
    static func build(_ turns: [TranscriptTurn]) -> [TranscriptItem] {
        var items: [TranscriptItem] = []
        var groupTools: [TranscriptTool] = []
        var groupId: String?
        var groupAt: String?

        func closeGroup() {
            guard let id = groupId, !groupTools.isEmpty else { return }
            items.append(.work(id: id, at: groupAt, tools: groupTools))
            groupTools = []
            groupId = nil
            groupAt = nil
        }

        for turn in turns {
            if turn.role == "user" {
                closeGroup()
                items.append(.user(turn))
                continue
            }
            if !turn.text.isEmpty {
                closeGroup()
                items.append(.assistant(turn))
            }
            if !turn.tools.isEmpty {
                if groupId == nil {
                    groupId = turn.tools[0].id
                    groupAt = turn.at
                }
                groupTools.append(contentsOf: turn.tools)
            }
        }
        closeGroup()
        // Ids come from the CLI (turn ids, and a group keyed by its first tool
        // call), and this array goes straight into a `ForEach`. Two items under
        // one id is undefined behaviour in SwiftUI — the 2026-09-03 popup
        // freeze was that, from a session listed twice — so a repeated id is
        // dropped rather than rendered.
        var seen = Set<String>()
        return items.filter { seen.insert($0.id).inserted }
    }
}

// MARK: - Tool taxonomy (T3 itemType → SF Symbol + summary verb)

private enum ToolKind: CaseIterable {
    case command, read, edit, search, web, task, skill, mcp, other

    static func of(_ tool: TranscriptTool) -> ToolKind {
        if tool.name.hasPrefix("mcp__") { return .mcp }
        switch tool.name {
        case "Bash", "BashOutput", "KillShell": return .command
        case "Read", "NotebookRead": return .read
        case "Edit", "Write", "MultiEdit", "NotebookEdit": return .edit
        case "Grep", "Glob", "LS": return .search
        case "WebSearch", "WebFetch": return .web
        case "Task", "Agent", "Workflow": return .task
        case "Skill": return .skill
        default: return .other
        }
    }

    var icon: String {
        switch self {
        case .command: return "terminal"
        case .read: return "eye"
        case .edit: return "square.and.pencil"
        case .search: return "magnifyingglass"
        case .web: return "globe"
        case .task: return "cpu"
        case .skill: return "sparkles"
        case .mcp: return "wrench.and.screwdriver"
        case .other: return "hammer"
        }
    }

    /// `summarize(3)` → "Ran 3 commands" (T3 `summarizeToolGroup` verbs).
    func summarize(_ count: Int) -> String {
        let n = count
        let s = n == 1 ? "" : "s"
        switch self {
        case .command: return "Ran \(n) command\(s)"
        case .read: return "Read \(n) file\(s)"
        case .edit: return "Changed \(n) file\(s)"
        case .search: return "\(n) search\(n == 1 ? "" : "es")"
        case .web: return "Searched the web \(n) time\(s)"
        case .task: return "Ran \(n) subagent\(s)"
        case .skill: return "Used \(n) skill\(s)"
        case .mcp: return "\(n) tool call\(s)"
        case .other: return "Used \(n) tool\(s)"
        }
    }
}

// GenesisTools adaptation: internal (was private) so the hub's own work-group row can call it.
func summarizeGroup(_ tools: [TranscriptTool]) -> String {
    var counts: [ToolKind: Int] = [:]
    for tool in tools { counts[ToolKind.of(tool), default: 0] += 1 }
    // Stable order: taxonomy order, largest families first feel noisy — keep enum order.
    let parts = ToolKind.allCases.compactMap { kind -> String? in
        guard let n = counts[kind] else { return nil }
        return kind.summarize(n)
    }
    return parts.joined(separator: " · ")
}
