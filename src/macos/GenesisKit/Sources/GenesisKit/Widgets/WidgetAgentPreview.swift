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
    private var waiting: Int { model.waitingSessionCount }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "tray").font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.white.opacity(0.65))
                Text("Inbox").font(.system(size: 12, weight: .semibold))
                Spacer()
                if model.inbox.needsAnswer > 0 {
                    Button { model.openInboxNotification(on: surface, needsAnswer: true) } label: {
                        HStack(spacing: 4) {
                            WidgetInboxCount(count: model.inbox.needsAnswer, needsAnswer: true,
                                pulse: model.inboxPulse, reduceMotion: model.effectiveReduceMotion, complete: model.inbox.complete)
                            Text("need you").font(.system(size: 10))
                        }
                    }.buttonStyle(.genHoverPlain()).instantTooltip("Open need you inbox items")
                }
                if model.inbox.unread > 0 {
                    Button { model.openInboxNotification(on: surface, needsAnswer: false) } label: {
                        HStack(spacing: 4) {
                            WidgetInboxCount(count: model.inbox.unread, needsAnswer: false,
                                pulse: model.inboxPulse, reduceMotion: model.effectiveReduceMotion, complete: model.inbox.complete)
                            Text("unread").font(.system(size: 10))
                        }
                    }.buttonStyle(.genHoverPlain()).instantTooltip("Open unread inbox items")
                }
                if model.inboxCount == 0 {
                    Text(model.inbox.complete ? "All caught up" : "Inbox status unavailable")
                        .font(.system(size: 10)).foregroundStyle(.secondary)
                } else {
                    IconButton(systemName: "checkmark.circle", tooltip: "Mark all read. Nothing is deleted.",
                               size: 11, action: model.markAllRead)
                        .accessibilityLabel("Mark all inbox items read")
                }
            }.padding(.horizontal, 5).padding(.bottom, 5)

            if model.previewSessions.isEmpty {
                HStack(spacing: 12) {
                    GenesisWidgetMark()
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Nothing needs you.").font(.system(size: 13, weight: .medium))
                        Text("New questions and finished work appear here.")
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading).padding(.horizontal, 5)
            } else {
                ForEach(model.previewSessions) { session in
                    Button {
                        model.openInboxNotification(on: surface, key: session.key)
                    } label: {
                        HStack(spacing: 9) {
                            AIProviderGlyph(meta: AIProviders.meta(for: session.target.provider), size: 21)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(session.title).font(.system(size: 11.5, weight: .medium)).lineLimit(1)
                                HStack(spacing: 5) {
                                    Text(
                                        session.project.isEmpty ? session.target.provider.capitalized : session.project
                                    )
                                    .lineLimit(1)
                                    Text("·")
                                    Text(session.visualStatus.label).lineLimit(1)
                                }.font(.system(size: 9.5)).foregroundStyle(.white.opacity(0.45))
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
                        .background(
                            session.status == "waiting" ? Color.orange.opacity(0.065) : .white.opacity(0.025),
                            in: RoundedRectangle(cornerRadius: 10))
                    }
                    .buttonStyle(.genHoverRow())
                    .accessibilityLabel("Open " + session.title + ", " + session.visualStatus.label)
                }
            }
            Spacer(minLength: 0)
            Button {
                model.section = "Sessions"
                model.openModule("agents", on: surface)
            } label: {
                HStack {
                    Image(systemName: "rectangle.stack").font(.system(size: 10))
                    Text("Projects & sessions").font(.system(size: 10, weight: .medium))
                    Spacer()
                    if model.activeSessionCount > 0 {
                        Text("\(model.activeSessionCount) active").font(.system(size: 9.5)).monospacedDigit()
                    }
                    Image(systemName: "chevron.right").font(.system(size: 8, weight: .semibold))
                }
                .foregroundStyle(.white.opacity(0.5)).padding(.horizontal, 5).padding(.vertical, 5)
                .contentShape(Rectangle())
            }.buttonStyle(.genHoverPlain())
                .instantTooltip(model.activeSessionCount > 0
                    ? "\(model.activeSessionCount) sessions are working or wait for you. Browse every project and session."
                    : "Browse every project and session")
                .accessibilityLabel("Browse all projects and sessions")
        }
        .padding(.horizontal, 13).padding(.vertical, 14)
        // Laid out at its own height and pinned to the top: the window is sized from this measurement, and while a
        // new size is on its way an overflow may hide the footer, never the header.
        .fixedSize(horizontal: false, vertical: true)
        .onGeometryChange(for: CGFloat.self, of: \.size.height) { model.reportPreviewFit($0) }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}
