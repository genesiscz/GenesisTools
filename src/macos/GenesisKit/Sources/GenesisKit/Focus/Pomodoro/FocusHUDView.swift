// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Focus/Pomodoro/FocusHUDView.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import SwiftUI

/// Spec 22 (S6) §10.2 — the Focus HUD.
///
/// Flow's HUD shows a number counting down. This one also shows what you are actually doing:
/// the live app mix of this phase and a keystroke sparkline, both read from the recorder that
/// is already running. Nothing here polls on its own — the engine ticks once a second and the
/// recorder every two, and this view renders whatever they last published.
struct FocusHUDView: View {
    @ObservedObject var engine: PomodoroEngine
    @ObservedObject var recorder: ActivityRecorder

    /// Injected so the window controller owns dismissal, and so previews need no window.
    var onOpenStudio: () -> Void = {}
    var onOpenSettings: () -> Void = {}
    var onToggleStyle: () -> Void = {}
    /// The panel refuses key status by default, so a text field in it cannot be typed into.
    /// These let the view borrow key status for exactly as long as the field is open.
    var onBeginEditing: () -> Void = {}
    var onEndEditing: () -> Void = {}
    /// Tags already used, newest first — picking beats typing for the common case.
    var recentTags: [String] = []
    var style: FocusHUDStyle = .full
    /// Blink requests from the controller. Defaulted so a preview needs none.
    @ObservedObject var flash = FocusFlash()
    /// Saves a plan changed from the Attention section of the menu.
    var onPlanChange: (PomodoroPlan) -> Void = { _ in }

    @State private var isHovering = false
    @State private var skipArmed = false
    @State private var tagDraft = ""
    @State private var isEditingTag = false
    /// What the pointer is currently over, explained in one line. The app's shared
    /// `.instantTooltip` is panel-based and never renders for this borderless non-key panel
    /// (verified with the app both inactive and active), so the HUD explains itself instead —
    /// which is also less to read on a 320pt window than a floating bubble.
    @State private var hint: String?
    @FocusState private var tagFieldFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var accent: Color {
        switch engine.phase {
        case .flow: return .genAccent
        case .shortBreak: return .genSuccess
        case .longBreak: return .genWaiting
        }
    }

    private var isPaused: Bool { engine.state == .paused }
    private var isRunning: Bool { engine.state == .running || engine.state == .overrun }

    var body: some View {
        Group {
            if style == .compact { compactBody } else { fullBody }
        }
        // Double-click anywhere on the card opens the Studio. Single clicks still belong to the
        // controls: a button consumes its own tap before this gesture sees it.
        .onTapGesture(count: 2) { onOpenStudio() }
        // Slow on purpose: four gentle blinks of the border over four seconds. On a window this
        // small, a fast strobe reads as an alarm, and a single blink is easy to miss.
        .attentionPulse(trigger: flash.count,
                        style: .slowBorder(color: accent, cornerRadius: FocusHUDMetrics.cornerRadius(for: style)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("focus-hud")
        .accessibilityLabel(voiceOverSummary)
    }

    // MARK: - Compact

    private var compactBody: some View {
        HStack(spacing: GenSpacing.md) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: GenSpacing.xs) {
                    Circle()
                        .fill(accent)
                        .frame(width: 7, height: 7)
                        .opacity(isRunning ? 1 : 0.35)
                    Text(engine.phase.label)
                        .font(GenTypography.caption(11, weight: .semibold))
                        .foregroundStyle(Color.genTextSecondary)
                        .accessibilityIdentifier("focus-hud-phase")
                    if recorder.pausedUntil != nil {
                        Image(systemName: "eye.slash")
                            .font(.system(size: 8))
                            .foregroundStyle(Color.genWarning)
                    }
                }
                Text(FocusHUDView.clock(displayedSeconds))
                    .font(.system(size: 34, weight: .medium))
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                    .foregroundStyle(timerColor)
                    .contentTransition(.numericText())
                    .accessibilityIdentifier("focus-hud-timer")
                // The steps as well as the dots: without them the compact HUD had no way to go back
                // after a mis-skip, or on to the next phase, short of the menu.
                cycleRow
            }
            Spacer(minLength: 0)
            VStack(alignment: .trailing, spacing: 4) {
                overflowMenu
                    .opacity(isHovering ? 1 : 0.4)
                Spacer(minLength: 0)
                primaryButton
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, GenSpacing.lg)
        .padding(.vertical, GenSpacing.md)
        .frame(width: FocusHUDMetrics.compactSize.width,
               height: FocusHUDMetrics.compactSize.height)
        .background(card)
        .onHover { hovering in
            withAnimation(reduceMotion ? nil : GenAnimation.quick) { isHovering = hovering }
        }
        // Editing a tag from the compact menu has nowhere to draw the field, so the compact
        // shape grows a field of its own rather than swallowing the request.
        .overlay(alignment: .bottomLeading) {
            if isEditingTag {
                tagButton
                    .padding(.horizontal, GenSpacing.lg)
                    .padding(.bottom, 6)
            }
        }
    }

    // MARK: - Full

    private var fullBody: some View {
        VStack(spacing: 0) {
            header
            // The core is centred in whatever space is left, so idle (no mix, no sparkline)
            // and running (both present) both read as balanced instead of top-heavy.
            Spacer(minLength: GenSpacing.xs)
            VStack(spacing: GenSpacing.sm) {
                timer
                cycleRow
                if isRunning || isPaused {
                    mixRow
                    sparkline
                }
            }
            Spacer(minLength: GenSpacing.xs)
            primaryButton
            // The hover row keeps its height at all times. Reserving it stops the whole HUD
            // from jumping under the pointer the moment it arrives.
            secondaryRow
                .opacity(isHovering || isEditingTag ? 1 : 0)
                .allowsHitTesting(isHovering || isEditingTag)
                .padding(.top, GenSpacing.sm)
            hintLine
        }
        .padding(.horizontal, GenSpacing.lg)
        .padding(.vertical, GenSpacing.md)
        .frame(width: FocusHUDMetrics.size.width, height: FocusHUDMetrics.size.height)
        .background(card)
        .onHover { hovering in
            withAnimation(reduceMotion ? nil : GenAnimation.quick) { isHovering = hovering }
            if !hovering { skipArmed = false }
        }
        .animation(reduceMotion ? nil : GenAnimation.standard, value: engine.phase)
    }

    /// Edits one field of the plan and hands the whole plan to the controller, which saves it.
    private func planBinding<Value>(_ keyPath: WritableKeyPath<PomodoroPlan, Value>) -> Binding<Value> {
        Binding(get: { engine.plan[keyPath: keyPath] },
                set: { value in
                    var plan = engine.plan
                    plan[keyPath: keyPath] = value
                    onPlanChange(plan)
                })
    }

    /// Always present, usually empty: a reserved line means the HUD never changes height when
    /// the pointer moves across its controls.
    private var hintLine: some View {
        Text(hint ?? " ")
            .font(GenTypography.caption(9))
            .foregroundStyle(Color.genTextMuted)
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .center)
            .frame(height: 12)
            .padding(.top, 2)
            .accessibilityIdentifier("focus-hud-hint")
    }

    /// Explains a control while the pointer is on it.
    private func explains(_ text: String) -> some ViewModifier { HintOnHover(text: text, hint: $hint) }

    // MARK: - Pieces

    private var card: some View {
        let radius = FocusHUDMetrics.cornerRadius(for: style)
        return RoundedRectangle(cornerRadius: radius, style: .continuous)
            .fill(Color.genSurface)
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill(accent.opacity(engine.phase == .flow ? 0.04 : 0.10))
            )
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(accent.opacity(isPaused ? 0.45 : 0.18), lineWidth: 1)
            )
            // Static shadow on purpose: an animated one is this app's biggest idle-CPU sink.
            .shadow(color: .black.opacity(0.45), radius: 18, y: 6)
    }

    private var header: some View {
        HStack(spacing: GenSpacing.xs) {
            Circle()
                .fill(accent)
                .frame(width: 6, height: 6)
                .opacity(isRunning ? 1 : 0.35)
            Text(phaseLabel)
                .font(GenTypography.caption(11, weight: .semibold))
                .foregroundStyle(Color.genTextSecondary)
                .textCase(.uppercase)
                .accessibilityIdentifier("focus-hud-phase")
            if let tag = engine.tag, !tag.isEmpty {
                Text("· \(tag)")
                    .font(GenTypography.caption(11))
                    .foregroundStyle(accent.opacity(0.9))
                    .lineLimit(1)
            }
            if recorder.pausedUntil != nil {
                Image(systemName: "eye.slash")
                    .font(.system(size: 9))
                    .foregroundStyle(Color.genWarning)
                    .accessibilityIdentifier("focus-hud-capture-off")
                    .modifier(explains("Recording paused · the timer still runs"))
            }
            Spacer(minLength: 0)
            overflowMenu
        }
    }

    private var displayedSeconds: Int {
        engine.state == .idle && engine.remainingSec == 0
            ? engine.plan.duration(of: engine.phase)
            : engine.remainingSec
    }

    private var timerColor: Color {
        engine.state == .overrun ? Color.genWarning
            : (isPaused ? Color.genTextSecondary : Color.genTextPrimary)
    }

    private var timer: some View {
        // Idle shows the length of the phase that WOULD start, so the window is useful before
        // anything is running rather than a dead 0:00.
        Text(FocusHUDView.clock(displayedSeconds))
            .font(.system(size: 52, weight: .medium, design: .default))
            .monospacedDigit()
            // Shrinks rather than truncating: an overrun of minutes rendered "+14:…".
            .lineLimit(1)
            .minimumScaleFactor(0.5)
            .foregroundStyle(timerColor)
            .contentTransition(.numericText())
            .accessibilityIdentifier("focus-hud-timer")
    }

    /// Dots flanked by the two controls a mis-skip needs: one step back, one step forward.
    private var cycleRow: some View {
        HStack(spacing: GenSpacing.sm) {
            phaseStep("chevron.left", id: "focus-hud-prev-phase",
                      tip: "Back to \(engine.plan.previous(before: engine.phase, completedFlows: engine.completedFlows).label.lowercased())") {
                engine.goBack()
            }
            cycleDots
            phaseStep("chevron.right", id: "focus-hud-next-phase",
                      tip: "Skip to \(engine.plan.next(after: engine.phase, completedFlows: engine.completedFlows + (engine.phase == .flow ? 1 : 0)).label.lowercased())") {
                engine.skip()
            }
        }
    }

    private func phaseStep(_ symbol: String, id: String, tip: String,
                           action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(Color.genTextTertiary)
                .frame(width: 16, height: 16)
                .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverIcon(accent: .genAccent, diameter: 16))
        .modifier(explains(tip))
        .accessibilityIdentifier(id)
        .accessibilityLabel(tip)
    }

    private var cycleDots: some View {
        HStack(spacing: 6) {
            ForEach(0 ..< max(1, engine.plan.cycleLength), id: \.self) { index in
                let done = index < engine.completedFlows % max(1, engine.plan.cycleLength)
                let active = index == engine.completedFlows % max(1, engine.plan.cycleLength) && isRunning
                Capsule()
                    .fill(done ? accent : (active ? accent.opacity(0.7) : Color.genTextMuted))
                    .frame(width: active ? 18 : 7, height: 7)
            }
        }
        .animation(reduceMotion ? nil : GenAnimation.gentle, value: engine.completedFlows)
        .accessibilityIdentifier("focus-hud-cycle")
        .accessibilityLabel("Flow \(engine.completedFlows % max(1, engine.plan.cycleLength) + 1) of \(engine.plan.cycleLength)")
    }

    private var mixRow: some View {
        HStack(spacing: GenSpacing.sm) {
            ForEach(mix) { entry in
                HStack(spacing: 3) {
                    AppIcon(bundleId: entry.bundleId, size: 12)
                    Text(entry.appName)
                        .font(GenTypography.caption(10))
                        .foregroundStyle(Color.genTextSecondary)
                        .lineLimit(1)
                    Text("\(Int(entry.share * 100))%")
                        .font(GenTypography.mono(10))
                        .foregroundStyle(Color.genTextTertiary)
                }
            }
            if mix.isEmpty {
                Text("measuring…")
                    .font(GenTypography.caption(10))
                    .foregroundStyle(Color.genTextMuted)
            }
        }
        .frame(height: 12)
        .accessibilityIdentifier("focus-hud-mix")
    }

    private var sparkline: some View {
        // A plain shape, not a Canvas and not a TimelineView: it redraws when the recorder
        // publishes, which is every two seconds, and never per display frame.
        FocusSparkline(samples: recorder.inputHistory)
            .stroke(accent.opacity(0.7), style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
            .frame(height: 16)
            .accessibilityIdentifier("focus-hud-sparkline")
            .accessibilityHidden(true)
    }

    private var primaryButton: some View {
        Button {
            switch engine.state {
            case .idle: engine.start(engine.phase, tag: engine.tag)
            case .running, .overrun: engine.pause()
            case .paused: engine.resume()
            }
        } label: {
            Image(systemName: isRunning ? "pause.fill" : "play.fill")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(accent)
                .frame(width: 40, height: 40)
                .background(Circle().fill(accent.opacity(0.12)))
                .overlay(Circle().strokeBorder(accent.opacity(0.35), lineWidth: 1))
        }
        .buttonStyle(.genHover(accent: accent, cornerRadius: 22, padding: EdgeInsets(), drawsBackground: false, scale: 1.06))
        .modifier(explains(isRunning ? "Pause this phase"
                           : (isPaused ? "Resume this phase"
                              : "Start a \(FocusFormat.duration(Int64(engine.plan.duration(of: engine.phase)) * 1000)) \(engine.phase.label.lowercased())")))
        .accessibilityIdentifier("focus-hud-primary")
        .accessibilityLabel(isRunning ? "Pause" : "Start")
    }

    private var secondaryRow: some View {
        HStack(spacing: GenSpacing.md) {
            hudAction("arrow.counterclockwise", "Restart this phase from the start",
                      id: "focus-hud-restart") {
                engine.start(engine.phase, tag: engine.tag)
            }
            Button {
                if skipArmed {
                    engine.skip()
                    skipArmed = false
                } else {
                    skipArmed = true
                }
            } label: {
                Text(skipArmed ? "skip?" : "skip")
                    .font(GenTypography.caption(10, weight: .semibold))
                    .foregroundStyle(skipArmed ? Color.genWarning : Color.genTextTertiary)
                    .frame(minWidth: 34)
            }
            .buttonStyle(.genHover(accent: accent, cornerRadius: 4))
            .modifier(explains(skipArmed ? "Press again to end this phase" : "End this phase, start the next"))
            .accessibilityIdentifier("focus-hud-skip")

            tagButton

            hudAction(recorder.pausedUntil == nil ? "eye" : "eye.slash",
                      recorder.pausedUntil == nil
                        ? "Pause activity recording for 1 hour"
                        : "Resume activity recording",
                      id: "focus-hud-capture-toggle") {
                if recorder.pausedUntil == nil {
                    recorder.pauseCapture(until: Date().addingTimeInterval(3600))
                } else {
                    recorder.resumeCapture()
                }
            }
        }
        .frame(height: 18)
    }

    @ViewBuilder
    private var tagButton: some View {
        if isEditingTag {
            TextField("tag", text: $tagDraft)
                .textFieldStyle(.plain)
                .font(GenTypography.caption(10))
                .foregroundStyle(accent)
                .frame(width: 84)
                .focused($tagFieldFocused)
                .onSubmit { commitTag() }
                .onExitCommand { cancelTagEditing() }
                .onAppear {
                    onBeginEditing()
                    // The panel has to become key before the field can take focus, and that is
                    // a window-server round trip, not an assignment.
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { tagFieldFocused = true }
                }
                .accessibilityIdentifier("focus-hud-tag-field")
        } else {
            Menu {
                Button("Type a tag…") { beginTagEditing() }
                if !recentTags.isEmpty {
                    Divider()
                    ForEach(recentTags.prefix(6), id: \.self) { tag in
                        Button("#\(tag)") { engine.setTag(tag) }
                    }
                }
                if engine.tag != nil {
                    Divider()
                    Button("Clear tag") { engine.setTag(nil) }
                }
            } label: {
                Text(engine.tag.map { "#\($0)" } ?? "#tag")
                    .font(GenTypography.caption(10))
                    .foregroundStyle(engine.tag == nil ? Color.genTextMuted : accent)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .genHoverEffect(accent: accent, cornerRadius: 4)
            .modifier(explains(engine.tag == nil ? "Tag this session for the breakdown" : "Change this session's tag"))
            .accessibilityIdentifier("focus-hud-tag")
        }
    }

    private func beginTagEditing() {
        tagDraft = engine.tag ?? ""
        isEditingTag = true
    }

    private func commitTag() {
        engine.setTag(tagDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                      ? nil
                      : tagDraft.trimmingCharacters(in: .whitespacesAndNewlines))
        endTagEditing()
    }

    private func cancelTagEditing() {
        endTagEditing()
    }

    private func endTagEditing() {
        isEditingTag = false
        tagFieldFocused = false
        onEndEditing()
    }

    private var overflowMenu: some View {
        Menu {
            Section("Start") {
                ForEach([15, 25, 45, 50, 90], id: \.self) { minutes in
                    Button("\(minutes) min flow") { engine.start(.flow, seconds: minutes * 60, tag: engine.tag) }
                }
            }
            Section("Break") {
                Button("Short break") { engine.start(.shortBreak) }
                Button("Long break") { engine.start(.longBreak) }
            }
            Divider()
            Button("Skip phase") { engine.skip() }
            Button("Stop") { engine.stop() }
            Divider()
            if recorder.pausedUntil == nil {
                Button("Pause capture for 1 hour") { recorder.pauseCapture(until: Date().addingTimeInterval(3600)) }
                Button("Pause capture until tomorrow") {
                    let tomorrow = Calendar.current.startOfDay(for: Date().addingTimeInterval(86_400))
                    recorder.pauseCapture(until: tomorrow)
                }
            } else {
                Button("Resume capture") { recorder.resumeCapture() }
            }
            Divider()
            Section("Tag") {
                Button(engine.tag == nil ? "Name this session…" : "Rename tag…") { beginTagEditing() }
                ForEach(recentTags.prefix(6), id: \.self) { tag in
                    Button("#\(tag)") { engine.setTag(tag) }
                }
                if engine.tag != nil {
                    Button("Clear tag") { engine.setTag(nil) }
                }
            }
            Divider()
            Section("Attention") {
                Picker("Pause when idle", selection: planBinding(\.idlePauseSec)) {
                    Text("Off").tag(0)
                    ForEach([1, 2, 5], id: \.self) { minutes in
                        Text("After \(minutes) min").tag(minutes * 60)
                    }
                }
                .pickerStyle(.menu)
                Toggle("Resume when I am back", isOn: planBinding(\.resumeOnActivity))
                    .disabled(engine.plan.idlePauseSec == 0)
                Picker("Nudge when stopped", selection: planBinding(\.nudgeEverySec)) {
                    Text("Off").tag(0)
                    ForEach([5, 10, 30], id: \.self) { minutes in
                        Text("At most every \(minutes) min").tag(minutes * 60)
                    }
                }
                .pickerStyle(.menu)
            }
            Divider()
            Button(style == .compact ? "Full size" : "Compact size") { onToggleStyle() }
            Divider()
            Button("Open Focus Studio") { onOpenStudio() }
            Button("Settings…") { onOpenSettings() }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Color.genTextTertiary)
                .frame(width: 20, height: 20)
                .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .genHoverEffect(accent: .genAccent, cornerRadius: 4)
        .modifier(explains("Durations, breaks, idle pause, Studio"))
        .accessibilityIdentifier("focus-hud-menu")
        .accessibilityLabel("Focus menu")
    }

    private func hudAction(_ symbol: String, _ label: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(Color.genTextTertiary)
                .frame(width: 18, height: 18)
                .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverIcon(accent: .genAccent, diameter: 18))
        .modifier(explains(label))
        .accessibilityIdentifier(id)
        .accessibilityLabel(label)
    }

    // MARK: - Derived

    /// Computed once per body evaluation from already-published state. The store query it used
    /// to need lives in the recorder, which caches per tick.
    private var mix: [ActivityRecorder.AppShare] {
        (isRunning || isPaused) ? recorder.currentMix : []
    }

    private var phaseLabel: String {
        switch engine.state {
        case .overrun: return "\(engine.phase.label) · over"
        case .idle: return "\(engine.phase.label) · ready"
        case .paused: return "\(engine.phase.label) · \(engine.pauseReason == .idle ? "away" : "paused")"
        case .running: return engine.phase.label
        }
    }

    private var voiceOverSummary: String {
        let minutes = abs(engine.remainingSec) / 60
        let seconds = abs(engine.remainingSec) % 60
        // Read as a sentence, not as a template: "over by" at the end came out as
        // "28 minutes 11 seconds over by".
        let clock = "\(minutes) minutes \(seconds) seconds"
        let core = engine.remainingSec < 0 ? "over by \(clock)" : "\(clock) remaining"
        let paused = isPaused ? ", paused" : ""
        let tag = engine.tag.map { ", tagged \($0)" } ?? ""
        return "\(engine.phase.label), \(core)\(paused)\(tag)"
    }

    static func clock(_ seconds: Int) -> String {
        let value = abs(seconds)
        let sign = seconds < 0 ? "+" : ""
        // Hours once past the hour, like the status strip: "+350:45" did not fit the HUD.
        if value >= 3600 {
            return "\(sign)\(value / 3600):\(String(format: "%02d:%02d", value % 3600 / 60, value % 60))"
        }
        return "\(sign)\(value / 60):\(String(format: "%02d", value % 60))"
    }
}

// MARK: - Sparkline

/// Keystrokes per tick as a polyline. A `Shape` rather than a `Canvas` so it participates in
/// normal diffing and costs nothing when the samples do not change.
struct FocusSparkline: Shape {
    var samples: [Int]

    func path(in rect: CGRect) -> Path {
        var path = Path()
        guard samples.count > 1 else { return path }
        let peak = max(samples.max() ?? 1, 1)
        let step = rect.width / CGFloat(samples.count - 1)
        for (index, sample) in samples.enumerated() {
            let x = rect.minX + CGFloat(index) * step
            let y = rect.maxY - (CGFloat(sample) / CGFloat(peak)) * rect.height
            if index == 0 { path.move(to: CGPoint(x: x, y: y)) } else { path.addLine(to: CGPoint(x: x, y: y)) }
        }
        return path
    }
}

/// Sets the HUD's hint line while the pointer is over a control, and clears it on the way out
/// without clobbering a hint another control has already set.
private struct HintOnHover: ViewModifier {
    let text: String
    @Binding var hint: String?

    func body(content: Content) -> some View {
        content.onHover { inside in
            if inside {
                hint = text
            } else if hint == text {
                hint = nil
            }
        }
    }
}

/// The HUD comes in two shapes. `full` is the working surface: mix, sparkline, hover controls.
/// `compact` is the glance: phase, time, one button, and the cycle dots — small enough to park
/// in a corner of a screen you are using for something else.
enum FocusHUDStyle: String, CaseIterable, Identifiable {
    case full, compact
    var id: String { rawValue }
    var label: String { self == .full ? "Full" : "Compact" }
}

enum FocusHUDMetrics {
    static let size = CGSize(width: 320, height: 250)
    static let compactSize = CGSize(width: 260, height: 104)
    static let cornerRadius: CGFloat = 20
    static let compactCornerRadius: CGFloat = 16

    static func size(for style: FocusHUDStyle) -> CGSize {
        style == .compact ? compactSize : size
    }

    static func cornerRadius(for style: FocusHUDStyle) -> CGFloat {
        style == .compact ? compactCornerRadius : cornerRadius
    }
}

/// Makes the HUD blink. The controller calls `pulse()`; the view plays one `AttentionPulse`
/// per count.
final class FocusFlash: ObservableObject {
    @Published private(set) var count = 0
    func pulse() { count += 1 }
}
