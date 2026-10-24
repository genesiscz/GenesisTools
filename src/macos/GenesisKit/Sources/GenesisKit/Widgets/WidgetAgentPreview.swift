import SwiftUI

struct WidgetActivityIndicator: View {
    let status: AgentWidgetStatus
    let animate: Bool

    var body: some View {
        if status == .working {
            SpinningArc(color: status.color, lineWidth: 1.7, period: 1.65, spinning: animate)
                .frame(width: 9, height: 9)
        } else {
            Circle().fill(status.color).frame(width: 6, height: 6)
                .shadow(color: status == .waiting ? status.color.opacity(0.35) : .clear, radius: 4)
        }
    }
}

private struct WidgetActivityRingLayout: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let text = subviews.first?.sizeThatFits(.unspecified) ?? .zero
        let diameter = max(28, max(text.width, text.height) + 10)
        return CGSize(width: diameter, height: diameter)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: CGPoint(x: bounds.midX, y: bounds.midY), anchor: .center, proposal: .unspecified)
    }
}

struct WidgetSessionActivity: View {
    let status: AgentWidgetStatus
    let count: Int
    let needsAnswer: Bool
    let animate: Bool
    var complete = true
    /// Grows with each arrival in this session; the count bumps once per arrival.
    var pulse = 0

    var body: some View {
        Group {
            if count > 0, status == .working {
                WidgetActivityRingLayout {
                    Text(verbatim: count > 99 ? "99+" : String(count) + (complete ? "" : "+"))
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .monospacedDigit().foregroundStyle(needsAnswer ? Color.orange : status.color)
                }.overlay {
                    SpinningArc(color: status.color, lineWidth: 1.7, spinning: animate)
                        .allowsHitTesting(false)
                }
            } else if count > 0 {
                WidgetInboxCount(count: count, needsAnswer: needsAnswer, pulse: pulse, reduceMotion: !animate,
                    complete: complete)
            } else if status == .working {
                SpinningArc(color: status.color, lineWidth: 1.7, spinning: animate)
                    .frame(width: 14, height: 14).padding(5)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(status.label + ", \(max(0, count)) inbox notifications")
    }
}

struct AgentWidgetPreview: View {
    @ObservedObject var model: WidgetModel
    let surface: WidgetSurfaceID
    /// The session whose cmux panel was opened from the row's accessibility action (the button itself exists only on the hovered row).
    @State private var cmuxPanelKey: String?

    var body: some View {
        let _ = RenderProbe.hit("widget.preview")
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "tray").font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.white.opacity(0.65))
                Text("Inbox").font(.system(size: 12, weight: .semibold))
                Spacer()
                if model.inbox.needsAnswer > 0 {
                    Button { model.toggleInboxOverview(on: surface) } label: {
                        HStack(spacing: 4) {
                            WidgetInboxCount(count: model.inbox.needsAnswer, needsAnswer: true,
                                pulse: model.inboxPulse, reduceMotion: model.effectiveReduceMotion, complete: model.inbox.complete)
                            Text("need you").font(.system(size: 10))
                        }
                    }.buttonStyle(.genHoverPlain()).instantTooltip("Every inbox entry that waits for your answer")
                }
                if model.inbox.unread > 0 {
                    Button { model.toggleInboxOverview(on: surface) } label: {
                        HStack(spacing: 4) {
                            WidgetInboxCount(count: model.inbox.unread, needsAnswer: false,
                                pulse: model.inboxPulse, reduceMotion: model.effectiveReduceMotion, complete: model.inbox.complete)
                            Text("unread").font(.system(size: 10))
                        }
                    }.buttonStyle(.genHoverPlain()).instantTooltip("Every unread inbox entry, from all sessions")
                }
                if model.inboxCount == 0 {
                    Text(model.snapshot == nil ? "Loading inbox" : model.inbox.complete ? "All caught up" : "Inbox status unavailable")
                        .font(.system(size: 10)).foregroundStyle(.secondary)
                } else {
                    IconButton(systemName: "checkmark.circle", tooltip: "Mark all read. Nothing is deleted.",
                               size: 11, action: model.markAllRead)
                        .accessibilityLabel("Mark all inbox items read")
                }
            }.padding(.horizontal, 5)

            HStack(spacing: 6) {
                GenSegmentedTabs(
                    "Show", items: WidgetPreviewChoices.filters.map { .init($0.value, $0.title) },
                    selection: Binding(get: { model.previewFilter }, set: { model.setPreview(filter: $0) }),
                    minSegmentWidth: 70, identifier: "widget.preview.filter")
                Spacer(minLength: 4)
                IconButton(systemName: "arrow.up.arrow.down", tooltip: sortTooltip, size: 10.5) {
                    let sorts = WidgetPreviewChoices.sorts.map(\.value)
                    let index = sorts.firstIndex(of: model.previewSort) ?? 0
                    model.setPreview(sort: sorts[(index + 1) % sorts.count])
                }.accessibilityLabel("Order: " + WidgetPreviewChoices.title(sort: model.previewSort))
                IconButton(systemName: "slider.horizontal.3", tooltip: "Choose what this list shows and its order",
                           size: 10.5) {
                    model.showSettingsPage?("widgets.sessions#inbox-preview")
                }.accessibilityLabel("Inbox preview settings")
            }.padding(.horizontal, 5).padding(.bottom, 3)

            if model.previewList.isEmpty && model.snapshot == nil {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Loading sessions").font(.system(size: 11)).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 5).padding(.vertical, 6)
                    .accessibilityElement(children: .combine)
            } else if model.previewList.isEmpty {
                HStack(spacing: 12) {
                    GenesisWidgetMark()
                    VStack(alignment: .leading, spacing: 4) {
                        Text(model.previewFilter == "active" ? "Nothing is running." : "Nothing needs you.")
                            .font(.system(size: 13, weight: .medium))
                        Text("New questions and finished work appear here.")
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 5).padding(.vertical, 6)
            } else {
                FittedScroll(maxHeight: 360, initialHeight: model.previewListHeight,
                             measured: { if $0 > 0 { model.previewListHeight = $0 } }) {
                    LazyVStack(spacing: 6) {
                        ForEach(model.previewList) { session in row(session) }
                    }
                }
            }
            Button {
                model.section = "Sessions"
                model.inboxOverview = false
                model.openModule("agents", on: surface)
            } label: {
                HStack {
                    Image(systemName: "rectangle.stack").font(.system(size: 10))
                    Text("Projects & sessions").font(.system(size: 10, weight: .medium))
                    Spacer()
                    Text(Plural.count(model.previewList.count, "session")).font(.system(size: 11)).monospacedDigit()
                    Image(systemName: "chevron.right").font(.system(size: 8, weight: .semibold))
                }
                .foregroundStyle(.white.opacity(0.6)).padding(.horizontal, 5).padding(.vertical, 5)
                .contentShape(Rectangle())
            }.buttonStyle(.genHoverPlain())
                .instantTooltip("Browse every project and session")
                .accessibilityLabel("Browse all projects and sessions")
        }
        .padding(.horizontal, 13).padding(.vertical, 14)
        // Laid out at its own height and pinned to the top: the window is sized from this measurement, and while a
        // new size is on its way an overflow may hide the footer, never the header.
        .fixedSize(horizontal: false, vertical: true)
        .onGeometryChange(for: CGFloat.self, of: \.size.height) { model.reportPreviewFit($0) }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        // Like the row button's own popover: while it is open the edge panel must not collapse.
        .onChange(of: cmuxPanelKey) { _, key in model.cmuxPopoverOpen = key != nil }
    }

    private var sortTooltip: String {
        let sorts = WidgetPreviewChoices.sorts
        let index = sorts.firstIndex { $0.value == model.previewSort } ?? 0
        return "Order: \(sorts[index].title). Click for \(sorts[(index + 1) % sorts.count].title)."
    }

    private func row(_ session: WidgetSession) -> some View {
        WidgetHoverRow { hovering in HStack(spacing: 4) {
            Button {
                model.openInboxNotification(on: surface, key: session.key)
            } label: {
                HStack(spacing: 9) {
                    AIProviderGlyph(meta: AIProviders.meta(for: session.target.provider), size: 21)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(session.title).font(.system(size: 11.5, weight: .medium)).lineLimit(1)
                        HStack(spacing: 5) {
                            Text(session.project.isEmpty ? session.target.provider.capitalized : session.project)
                                .lineLimit(1)
                            Text("·")
                            Text(session.visualStatus.label).lineLimit(1)
                        }.font(.system(size: 11)).foregroundStyle(.white.opacity(0.6))
                        WidgetSessionTimes(session: session, inbox: model.inboxFor(session.key))
                    }
                    Spacer(minLength: 2)
                    if let inbox = model.inboxFor(session.key), inbox.unread + inbox.needsAnswer > 0 {
                        WidgetInboxCount(count: inbox.unread + inbox.needsAnswer, needsAnswer: inbox.needsAnswer > 0,
                            pulse: model.inboxPulseFor(session.key), reduceMotion: model.effectiveReduceMotion,
                            complete: model.inbox.complete)
                    } else {
                        WidgetActivityIndicator(status: session.visualStatus, animate: !model.effectiveReduceMotion)
                            .frame(width: 12, height: 12)
                    }
                }
                .padding(.horizontal, 9).padding(.vertical, 9)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(RowButtonStyle(cornerRadius: 10))
            .accessibilityLabel("Open " + session.title + ", " + session.visualStatus.label)
            WidgetCmuxButton(model: model, session: session, live: hovering)
        } }
        .padding(.trailing, 4)
        .accessibilityAction(named: "Open cmux for " + session.title) { cmuxPanelKey = session.key }
        .popover(isPresented: Binding(get: { cmuxPanelKey == session.key }, set: { if !$0 { cmuxPanelKey = nil } }),
                 arrowEdge: .trailing) {
            WidgetCmuxPanel(model: model, session: session).padding(14).frame(width: 380)
        }
        .background(
            model.inboxFor(session.key).map { $0.needsAnswer > 0 } == true || session.status == "waiting"
                ? Color.orange.opacity(0.065) : .white.opacity(0.025),
            in: RoundedRectangle(cornerRadius: 10))
        .attentionPulse(trigger: model.attentionTrigger(session.key), style: rowAttention, since: model.attentionStart(session.key))
    }

    private var rowAttention: AttentionPulseStyle {
        var style = model.attentionStyle
        style.cornerRadius = 10
        return style
    }
}

/// When a session was last active and when its newest question or answer arrived: "working now · asked 3m ago",
/// "active 12m ago · answered 1h ago". Both live, so a row left open keeps counting.
struct WidgetSessionTimes: View {
    let session: WidgetSession
    let inbox: WidgetInboxSession?

    var body: some View {
        HStack(spacing: 5) {
            if session.visualStatus == .working {
                Text("working now")
            } else if session.activityAt > 0 {
                LiveAgo(date: Date(timeIntervalSince1970: session.activityAt / 1000), style: .brief) { "active " + $0 }
            }
            if let entry = Self.latest(inbox) {
                Text("·")
                LiveAgo(date: Date(timeIntervalSince1970: entry.at / 1000), style: .brief) { entry.verb + " " + $0 }
                    .foregroundStyle(entry.waiting ? Color.orange.opacity(0.8) : .white.opacity(0.6))
            }
        }
        .font(.system(size: 11)).foregroundStyle(.white.opacity(0.6)).lineLimit(1)
    }

    /// The newest entry: a question still waiting wins, since that is what the row is about.
    static func latest(_ inbox: WidgetInboxSession?) -> (verb: String, at: Double, waiting: Bool)? {
        if let item = inbox?.pendingItem, item.at.isFinite, item.at > 0 {
            return (item.kind == "decision" ? "decision asked" : "asked", item.at, true)
        }
        guard let item = inbox?.unreadItem ?? inbox?.latest, item.at.isFinite, item.at > 0 else { return nil }
        switch item.kind {
        case "answer": return ("answered", item.at, false)
        case "result": return ("finished", item.at, false)
        default: return ("new entry", item.at, false)
        }
    }
}

/// The header line under a session's title: agent, project and model, then whether it works now or how long it
/// has been idle, and its context size (Martin, 2026-10-23: "the header probably can have way more info").
struct WidgetSessionFacts: View {
    let session: WidgetSession
    let contextTokens: Int?
    let animate: Bool

    var body: some View {
        HStack(spacing: 5) {
            Text(Self.origin(session)).lineLimit(1).truncationMode(.middle)
            Text("·")
            if session.visualStatus == .working {
                WidgetActivityIndicator(status: .working, animate: animate)
                Text("working").foregroundStyle(session.visualStatus.color)
            } else if session.activityAt > 0 {
                LiveAgo(date: Date(timeIntervalSince1970: session.activityAt / 1000), style: .brief) { "idle " + $0 }
            } else {
                Text(session.visualStatus.label)
            }
            if let contextTokens {
                Text("·")
                // The header is the session chooser's button, whose tooltip covers this line; VoiceOver says it.
                Text("ctx " + SessionFormat.tokens(contextTokens)).monospacedDigit()
                    .accessibilityLabel("Context size of the last model call, \(contextTokens) tokens")
            }
        }
        .font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
    }

    /// "Claude · my-project · opus-5-5": the agent, the project, and the model without its vendor prefix.
    static func origin(_ session: WidgetSession) -> String {
        let model = session.model.map { $0.replacingOccurrences(of: "claude-", with: "") }
        return [AIProviders.meta(for: session.target.provider).displayName, session.project, model]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }
}
