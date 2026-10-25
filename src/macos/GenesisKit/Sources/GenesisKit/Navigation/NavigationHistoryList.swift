import SwiftUI

/// The history as a list, newest first: who went there (User, Agent, Link), the place, the agent's note, when, and
/// where it sits from the cursor. A click hops there (`NavigationHistory.hop(to:)`). Rows take values only, so the
/// list costs nothing while the host's model changes.
public struct NavigationHistoryList<Target: Codable & Hashable>: View {
    let history: NavigationHistory<Target>
    var maxHeight: CGFloat
    let onHop: (String) -> Void

    public init(history: NavigationHistory<Target>, maxHeight: CGFloat = 420, onHop: @escaping (String) -> Void) {
        self.history = history
        self.maxHeight = maxHeight
        self.onHop = onHop
    }

    public var body: some View {
        let rows = history.newestFirst
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Text("History").kicker()
                Spacer(minLength: 8)
                Text(verbatim: Plural.count(rows.count, "place"))
                    .font(.system(size: 10.5).monospacedDigit())
                    .foregroundColor(KitPalette.faint)
            }
            .padding(.horizontal, 14)
            .padding(.top, 10)
            .padding(.bottom, 6)
            if rows.isEmpty {
                EmptyState(symbol: "clock.arrow.circlepath", text: "No places yet",
                           detail: "Every session, worktree, PR or commit the hub shows lands here.")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 18)
            } else {
                FittedScroll(maxHeight: maxHeight) {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(rows) { entry in
                            NavigationHistoryRow(entry: NavigationHistoryRowValue(entry, offset: history.offset(of: entry.id)),
                                                 onHop: onHop)
                        }
                    }
                    .padding(.horizontal, 6)
                    .padding(.bottom, 6)
                }
            }
        }
    }
}

/// What one row shows; equal values draw the same.
struct NavigationHistoryRowValue: Equatable {
    let id: String
    let title: String
    let actor: NavigationActor
    let note: String?
    let agentSession: String?
    let at: Date
    /// 0 for the place on screen, negative behind it, positive ahead, nil for a place only the log holds.
    let offset: Int?

    init<Target>(_ entry: NavigationEntry<Target>, offset: Int?) {
        id = entry.id
        title = entry.title
        actor = entry.actor
        note = entry.note.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
        agentSession = entry.agentSession
        at = entry.at
        self.offset = offset
    }

    var isCurrent: Bool { offset == 0 }

    /// "Back 2", "Forward 1", or nil for the current place and a place only the log holds.
    var position: String? {
        guard let offset, offset != 0 else { return nil }
        return offset < 0 ? "Back \(-offset)" : "Forward \(offset)"
    }

    var accessibilityText: String {
        var parts = ["\(actor.title): \(title)"]
        if let note { parts.append(note) }
        if isCurrent { parts.append("shown now") } else if let position { parts.append(position) }
        return parts.joined(separator: ", ")
    }
}

extension NavigationActor {
    /// The badge colour: the person is quiet, an agent stands out, a link sits between.
    var tint: Color {
        switch self {
        case .user: return KitPalette.dim
        case .agent: return Color(red: 0.74, green: 0.58, blue: 1.0)
        case .link: return KitPalette.renamed
        }
    }

    var symbol: String {
        switch self {
        case .user: return "person.fill"
        case .agent: return "sparkles"
        case .link: return "link"
        }
    }
}

struct NavigationHistoryRow: View, Equatable {
    let entry: NavigationHistoryRowValue
    let onHop: (String) -> Void

    static func == (lhs: Self, rhs: Self) -> Bool { lhs.entry == rhs.entry }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Circle()
                .fill(entry.isCurrent ? KitTheme.accent : Color.clear)
                .overlay(Circle().stroke(entry.isCurrent ? Color.clear : KitPalette.faint, lineWidth: 1))
                .frame(width: 7, height: 7)
                .padding(.top, 5)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Badge(entry.actor.title, color: entry.actor.tint, look: entry.actor == .user ? .tag : .tone,
                          symbol: entry.actor.symbol)
                    Text(verbatim: entry.title)
                        .font(.system(size: 12, weight: entry.isCurrent ? .semibold : .regular))
                        .foregroundColor(KitPalette.text)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 6)
                    LiveAgo(date: entry.at, style: .brief)
                        .font(.system(size: 10.5).monospacedDigit())
                        .foregroundColor(KitPalette.faint)
                        .fixedSize()
                }
                if let note = entry.note {
                    Text(verbatim: note)
                        .font(.system(size: 11))
                        .foregroundColor(KitPalette.dim)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if entry.isCurrent || entry.position != nil || entry.agentSession != nil {
                    HStack(spacing: 6) {
                        if entry.isCurrent {
                            Text("Shown now").font(.system(size: 10, weight: .medium)).foregroundColor(KitTheme.accent)
                        } else if let position = entry.position {
                            Text(verbatim: position).font(.system(size: 10)).foregroundColor(KitPalette.faint)
                        }
                        if let session = entry.agentSession {
                            Text(verbatim: "session \(session.prefix(8))")
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundColor(KitPalette.faint)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .rowButton(cornerRadius: 6) { onHop(entry.id) }
        .disabled(entry.isCurrent)
        .accessibilityLabel(Text(verbatim: entry.accessibilityText))
        .accessibilityHint(entry.isCurrent ? Text("") : Text("Opens this place"))
    }
}
