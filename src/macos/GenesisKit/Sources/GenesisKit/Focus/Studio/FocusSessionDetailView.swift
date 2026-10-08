// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Focus/Studio/FocusSessionDetailView.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import AppKit
import Charts
import SwiftUI

/// Spec 22 (S6) §10.7 — the per-session breakdown window.
///
/// Reading order is deliberate: how the session went (ring and stats), then when it went that
/// way (strip and effort), then where it went (apps, sites, windows), then exactly what
/// happened (the event log). Every block draws the icon of the app it is about, because a row
/// of names is slower to read than a row of icons.
struct FocusSessionDetailView: View {
    @ObservedObject var model: FocusSessionDetailModel

    var body: some View {
        Group {
            if model.missing {
                missingState
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: GenSpacing.lg) {
                        header
                        stats
                        strip
                        effortChart
                        breakdowns
                        eventLog
                    }
                    .padding(GenSpacing.lg)
                }
            }
        }
        .background(Color.genBackground)
        .frame(minWidth: 720, minHeight: 560)
        .task { model.reload() }
        // Same trap as the Studio: without this the root identifier swallows every control.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("focus-session-detail")
    }

    private var accent: Color {
        switch model.session?.kind {
        case ActivityStore.SessionKind.flow.rawValue: return .genAccent
        case ActivityStore.SessionKind.shortBreak.rawValue: return .genSuccess
        default: return .genWaiting
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .top, spacing: GenSpacing.lg) {
            ring
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: GenSpacing.sm) {
                    Text(model.title)
                        .font(GenTypography.display(20, weight: .semibold))
                        .foregroundStyle(Color.genTextPrimary)
                        .accessibilityIdentifier("focus-session-title")
                    if let state = model.session?.state,
                       state != ActivityStore.SessionState.done.rawValue {
                        Text(state)
                            .font(GenTypography.caption(10, weight: .semibold))
                            .foregroundStyle(Color.genWarning)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Capsule().fill(Color.genWarning.opacity(0.14)))
                    }
                }
                if let session = model.session {
                    Text("\(FocusFormat.clockTime(session.startedMs)) → "
                         + (session.endedMs.map(FocusFormat.clockTime) ?? "running")
                         + "  ·  planned \(FocusFormat.duration(model.plannedMs))"
                         + "  ·  actual \(FocusFormat.duration(model.actualMs))")
                        .font(GenTypography.mono(12))
                        .foregroundStyle(Color.genTextSecondary)
                }
                if let note = model.session?.note, !note.isEmpty {
                    Text(note)
                        .font(GenTypography.body(12))
                        .foregroundStyle(Color.genTextSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack(spacing: GenSpacing.sm) {
                    Button("Copy breakdown") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(model.markdown(), forType: .string)
                    }
                    .buttonStyle(.genHover(accent: accent))
                    .font(GenTypography.caption(11, weight: .semibold))
                    .foregroundStyle(accent)
                    .accessibilityIdentifier("focus-session-copy")
                    .instantTooltip("Copy this session's breakdown as Markdown")

                    Button("Reload") { model.reload() }
                        .buttonStyle(.genHover())
                        .font(GenTypography.caption(11))
                        .foregroundStyle(Color.genTextTertiary)
                        .accessibilityIdentifier("focus-session-reload")
                        .instantTooltip("Re-read this session from the ledger")
                }
                .padding(.top, 2)
            }
            Spacer(minLength: 0)
        }
    }

    /// Planned versus actual as a ring, with the focus density inside it: a pomodoro that ran
    /// its full 25 minutes while you were elsewhere is not a finished pomodoro.
    private var ring: some View {
        ZStack {
            Circle()
                .stroke(Color.genGlassFill, lineWidth: 8)
            Circle()
                .trim(from: 0, to: max(0.01, model.completion))
                .stroke(accent, style: StrokeStyle(lineWidth: 8, lineCap: .round))
                .rotationEffect(.degrees(-90))
            VStack(spacing: 0) {
                Text(FocusFormat.percent(model.density))
                    .font(GenTypography.mono(15, weight: .semibold))
                    .foregroundStyle(Color.genTextPrimary)
                Text("focused")
                    .font(GenTypography.caption(9))
                    .foregroundStyle(Color.genTextTertiary)
            }
        }
        .frame(width: 84, height: 84)
        // Combine, or the identifier lands on both the trim and the label inside it.
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("focus-session-ring")
        .accessibilityLabel("Focused \(FocusFormat.percent(model.density)) of the session")
        .instantTooltip("\(FocusFormat.percent(model.completion)) of planned time ran, \(FocusFormat.percent(model.density)) of it focused")
    }

    // MARK: - Stats

    private var stats: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: GenSpacing.sm), count: 4),
                  spacing: GenSpacing.sm) {
            tile("focused", FocusFormat.duration(model.totals.focusedMs), accent)
            tile("idle", FocusFormat.duration(model.totals.idleMs), .genTextTertiary)
            tile("paused", FocusFormat.duration(model.pausedMs), .genWaiting)
            tile("not measured", FocusFormat.duration(model.unmeasuredMs),
                 model.unmeasuredMs > 0 ? .genWarning : .genTextMuted)
            tile("keystrokes", "\(model.counts.keys)", .genTextPrimary)
            tile("clicks", "\(model.counts.clicks)", .genTextPrimary)
            tile("switches", "\(model.totals.switches)", .genTextPrimary)
            tile("interruptions", "\(model.session?.interruptions ?? 0)",
                 (model.session?.interruptions ?? 0) > 0 ? .genWarning : .genTextMuted)
        }
        .accessibilityIdentifier("focus-session-stats")
    }

    private func tile(_ label: String, _ value: String, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(GenTypography.mono(15, weight: .medium))
                .foregroundStyle(color)
            Text(label)
                .font(GenTypography.caption(10))
                .foregroundStyle(Color.genTextTertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(GenSpacing.sm)
        .background(
            RoundedRectangle(cornerRadius: GenRadius.sm, style: .continuous)
                .fill(Color.genSurface)
                .overlay(RoundedRectangle(cornerRadius: GenRadius.sm, style: .continuous)
                    .strokeBorder(Color.genGlassBorder, lineWidth: 1)))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("focus-session-stat-\(label.replacingOccurrences(of: " ", with: "-"))")
    }

    // MARK: - Strip

    /// The session drawn to scale, one block per event. Blocks wide enough to hold an icon get
    /// one, so the strip reads as "Xcode, Chrome, Slack" at a glance rather than as stripes.
    private var strip: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionTitle("Minute by minute")
            GeometryReader { geometry in
                let span = max(1, model.actualMs)
                let start = model.session?.startedMs ?? 0
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: GenRadius.sm, style: .continuous)
                        .fill(Color.genGlassFill)
                    ForEach(model.events) { event in
                        let x = geometry.size.width * Double(event.startedMs - start) / Double(span)
                        let width = max(1.5, geometry.size.width * Double(event.durationMs) / Double(span))
                        block(event, width: width)
                            .frame(width: width, height: 44)
                            .offset(x: max(0, min(x, geometry.size.width - width)))
                    }
                }
            }
            .frame(height: 44)
            .clipShape(RoundedRectangle(cornerRadius: GenRadius.sm, style: .continuous))
            .accessibilityElement(children: .ignore)
            .accessibilityIdentifier("focus-session-strip")
            .accessibilityLabel(stripSummary)

            HStack {
                Text(FocusFormat.clockTime(model.session?.startedMs ?? 0))
                Spacer()
                Text(model.session?.endedMs.map(FocusFormat.clockTime) ?? "now")
            }
            .font(GenTypography.mono(10))
            .foregroundStyle(Color.genTextMuted)
        }
    }

    /// What the strip says to VoiceOver, since the blocks themselves are decoration.
    private var stripSummary: String {
        let apps = model.appBuckets.prefix(3).map { "\($0.key) \(FocusFormat.percent($0.share))" }
        return "Session strip. " + (apps.isEmpty ? "Nothing recorded." : apps.joined(separator: ", "))
    }

    @ViewBuilder
    private func block(_ event: FocusSessionDetailModel.Event, width: CGFloat) -> some View {
        switch event.kind {
        case .work:
            ZStack {
                Rectangle().fill(FocusPalette.color(for: event.appName).opacity(0.85))
                if width >= 20 { AppIcon(bundleId: event.appBundle, size: min(18, width - 4)) }
            }
            .instantTooltip("\(event.appName) · \(FocusFormat.duration(event.durationMs))"
                  + (event.detail.map { "\n\($0)" } ?? ""))
        case .idle:
            Rectangle().fill(Color.genTextMuted.opacity(0.25))
                .instantTooltip("idle · \(FocusFormat.duration(event.durationMs))")
        case .pause(let reason):
            Rectangle().fill(Color.genWaiting.opacity(0.45))
                .instantTooltip("paused (\(reason)) · \(FocusFormat.duration(event.durationMs))")
        case .gap(let reason):
            Rectangle().fill(FocusPalette.gapFill)
                .overlay(Rectangle().strokeBorder(Color.genWarning.opacity(0.5), lineWidth: 1))
                .instantTooltip("not measured (\(reason)) · \(FocusFormat.duration(event.durationMs))")
        }
    }

    // MARK: - Effort

    private var effortChart: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionTitle("Keystrokes")
            if model.counts.keys == 0 {
                Text("No input recorded for this session.")
                    .font(GenTypography.caption(11))
                    .foregroundStyle(Color.genTextMuted)
                    .frame(height: 60, alignment: .leading)
            } else {
                Chart(model.effort) { point in
                    BarMark(
                        x: .value("at", Date(timeIntervalSince1970: Double(point.startedMs) / 1000)),
                        y: .value("keys", point.keys))
                        .foregroundStyle(accent.opacity(0.8))
                        .cornerRadius(1.5)
                }
                .chartYAxis {
                    AxisMarks(position: .leading) { _ in
                        AxisGridLine().foregroundStyle(Color.genGlassBorder)
                        AxisValueLabel().font(GenTypography.mono(9))
                    }
                }
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 6)) { _ in
                        AxisGridLine().foregroundStyle(Color.genGlassBorder.opacity(0.5))
                        AxisValueLabel(format: .dateTime.hour().minute()).font(GenTypography.mono(9))
                    }
                }
                .frame(height: 96)
                .accessibilityIdentifier("focus-session-effort")
            }
        }
    }

    // MARK: - Breakdowns

    private var breakdowns: some View {
        HStack(alignment: .top, spacing: GenSpacing.lg) {
            bucketList("Apps", model.appBuckets, identifier: "apps", icons: true)
            VStack(alignment: .leading, spacing: GenSpacing.lg) {
                if !model.siteBuckets.isEmpty {
                    bucketList("Sites", model.siteBuckets, identifier: "sites", icons: false)
                }
                if !model.projectBuckets.isEmpty {
                    bucketList("Projects", model.projectBuckets, identifier: "projects", icons: false)
                }
                if model.siteBuckets.isEmpty && model.projectBuckets.isEmpty {
                    bucketList("Windows", Array(model.windowBuckets.prefix(8)),
                               identifier: "windows", icons: true)
                }
            }
        }
    }

    private func bucketList(_ title: String, _ buckets: [FocusAggregate.Bucket],
                            identifier: String, icons: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionTitle(title)
            ForEach(buckets.prefix(10)) { bucket in
                HStack(spacing: GenSpacing.sm) {
                    if icons { AppIcon(bundleId: bucket.bundleId, size: 15) }
                    Text(bucket.key)
                        .font(GenTypography.body(12))
                        .foregroundStyle(Color.genTextPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .instantTooltip(bucket.key)
                    Spacer(minLength: GenSpacing.sm)
                    Text("\(bucket.visits)×")
                        .font(GenTypography.mono(10))
                        .foregroundStyle(Color.genTextMuted)
                        .instantTooltip("\(bucket.visits) visits")
                    Text(FocusFormat.duration(bucket.ms))
                        .font(GenTypography.mono(11))
                        .foregroundStyle(Color.genTextSecondary)
                        .frame(width: 58, alignment: .trailing)
                    GeometryReader { geometry in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color.genGlassFill)
                            Capsule()
                                .fill(FocusPalette.color(for: bucket.key).opacity(0.8))
                                .frame(width: max(2, geometry.size.width * bucket.share))
                        }
                    }
                    .frame(width: 90, height: 5)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("focus-session-\(identifier)")
    }

    // MARK: - Event log

    private var eventLog: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionTitle("Everything that happened  ·  \(model.events.count)")
            LazyVStack(spacing: 0) {
                ForEach(model.events) { event in
                    FocusSessionEventRow(event: event)
                    Divider().overlay(Color.genGlassBorder.opacity(0.4))
                }
            }
            .background(
                RoundedRectangle(cornerRadius: GenRadius.sm, style: .continuous)
                    .fill(Color.genSurface.opacity(0.6)))
            .accessibilityIdentifier("focus-session-events")
        }
    }

    private func sectionTitle(_ text: String) -> some View {
        Text(text.uppercased())
            .font(GenTypography.caption(10, weight: .semibold))
            .foregroundStyle(Color.genTextMuted)
            .tracking(0.6)
    }

    private var missingState: some View {
        VStack(spacing: GenSpacing.sm) {
            Image(systemName: "questionmark.folder")
                .font(.system(size: 24))
                .foregroundStyle(Color.genTextMuted)
            Text("This session is no longer in the ledger.")
                .font(GenTypography.body(13))
                .foregroundStyle(Color.genTextSecondary)
            Text("It was probably deleted through genesis focus forget.")
                .font(GenTypography.caption(11))
                .foregroundStyle(Color.genTextTertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("focus-session-missing")
    }
}

/// One line of the log. Split out so the lazy stack diffs rows, not one giant body.
struct FocusSessionEventRow: View {
    let event: FocusSessionDetailModel.Event

    var body: some View {
        HStack(spacing: GenSpacing.sm) {
            Text(FocusFormat.clockTime(event.startedMs))
                .font(GenTypography.mono(10))
                .foregroundStyle(Color.genTextMuted)
                .frame(width: 42, alignment: .leading)
            marker
            VStack(alignment: .leading, spacing: 1) {
                Text(event.appName)
                    .font(GenTypography.body(12))
                    .foregroundStyle(color)
                    .lineLimit(1)
                if let detail = event.detail, !detail.isEmpty {
                    Text(detail)
                        .font(GenTypography.caption(10))
                        .foregroundStyle(Color.genTextTertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .instantTooltip(detail)
                }
            }
            Spacer(minLength: GenSpacing.sm)
            if event.keys > 0 {
                Text("\(event.keys) keys")
                    .font(GenTypography.mono(10))
                    .foregroundStyle(Color.genTextMuted)
            }
            Text(FocusFormat.duration(event.durationMs))
                .font(GenTypography.mono(11))
                .foregroundStyle(Color.genTextSecondary)
                .frame(width: 58, alignment: .trailing)
        }
        .padding(.horizontal, GenSpacing.sm)
        .padding(.vertical, 5)
        .contentShape(Rectangle())
        .genHoverEffect(cornerRadius: GenRadius.sm)
    }

    @ViewBuilder
    private var marker: some View {
        switch event.kind {
        case .work: AppIcon(bundleId: event.appBundle, size: 15)
        case .idle: glyph("moon.zzz")
        case .pause: glyph("pause.circle")
        case .gap: glyph("exclamationmark.triangle")
        }
    }

    private func glyph(_ name: String) -> some View {
        Image(systemName: name)
            .font(.system(size: 11))
            .foregroundStyle(color)
            .frame(width: 15, height: 15)
    }

    private var color: Color {
        switch event.kind {
        case .work: return .genTextPrimary
        case .idle: return .genTextMuted
        case .pause: return .genWaiting
        case .gap: return .genWarning
        }
    }
}
