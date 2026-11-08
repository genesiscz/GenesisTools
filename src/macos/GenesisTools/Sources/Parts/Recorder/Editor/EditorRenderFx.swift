import SwiftUI

/// Round 4 fx-render: the Style tab's controls for transitions at cuts, the 3D tilt and the magnifier lenses. Each
/// change is a look (`setLooks`): drawn per frame from the project, so the preview shows it without a rebuild.
struct RenderFxSection: View {
    @Bindable var model: EditorModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            TransitionsControls(model: model)
            Divider().padding(.vertical, 4)
            TiltControls(model: model)
            Divider().padding(.vertical, 4)
            LensControls(model: model)
        }
    }

    /// How many joins (cuts) the edit has; a split alone is none.
    static func joinCount(_ project: EditProject) -> Int {
        let clips = project.clips.filter { $0.sourceDurationUs > 0 }
        return zip(clips, clips.dropFirst()).filter { $0.0.toUs != $0.1.fromUs }.count
    }
}

private struct TransitionsControls: View {
    @Bindable var model: EditorModel

    var body: some View {
        let current = model.project.transitions?.default ?? EditProject.Transition()
        let joins = RenderFxSection.joinCount(model.project)
        let own = model.project.transitions?.joins?.count ?? 0
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(text: "Transitions at cuts", value: joins == 0 ? nil : Plural.count(joins, "cut"))
            GenSegmentedTabs("Transition", items: [.init(EditProject.TransitionKind.none, "None"), .init(.crossfade, "Fade"),
                                                   .init(.zoom, "Zoom"), .init(.blur, "Blur")],
                             selection: Binding(get: { current.kind }, set: { kind in
                                 model.setLooks { project in
                                     var settings = project.transitions ?? EditProject.Transitions()
                                     settings.default.kind = kind
                                     // Nothing to keep: a hard cut everywhere is the same as no settings.
                                     project.transitions = kind == .none && settings.joins == nil ? nil : settings
                                 }
                             }),
                             minSegmentWidth: 44, identifier: "recorder.style.transition", fillsWidth: true)
                .instantTooltip("What every cut does: a hard cut (None), a crossfade, a zoom through, or a blurred wipe")
            if current.kind != .none {
                SectionLabel(text: "Length", value: "\(current.ms) ms")
                Slider(value: Binding(get: { Double(current.ms) }, set: { value in
                    model.setLooks { $0.transitions?.default.ms = Int((value / 50).rounded()) * 50 }
                }), in: 100...1500)
                    .accessibilityLabel("Transition length")
                    .accessibilityIdentifier("recorder.style.transitionLength")
            }
            if joins == 0 {
                Text("This edit has no cut yet. Each cut you make gets the transition.")
                    .font(.system(size: 11.5)).foregroundStyle(RecorderPalette.dim)
                    .fixedSize(horizontal: false, vertical: true)
            } else if own > 0 {
                Text(verbatim: "\(Plural.count(own, "cut")) has its own transition (set with the transition op).")
                    .font(.system(size: 11.5)).foregroundStyle(RecorderPalette.dim)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

private struct TiltControls: View {
    @Bindable var model: EditorModel

    var body: some View {
        let tilt = model.project.tilt
        VStack(alignment: .leading, spacing: 8) {
            SwitchRow("3D tilt", isOn: Binding(get: { tilt != nil }, set: { on in
                model.setLooks { $0.tilt = on ? ($0.tilt ?? EditProject.Tilt()) : nil }
            }))
            .accessibilityIdentifier("recorder.style.tilt")
            .instantTooltip("Turns the framed picture slightly in 3D, drifting slowly, with a tilt in at the start and out at the end")
            if let tilt {
                SectionLabel(text: "Strength", value: "\(Int((tilt.strength * 100).rounded()))%")
                Slider(value: Binding(get: { tilt.strength }, set: { value in
                    model.setLooks { $0.tilt?.strength = (value * 20).rounded() / 20 }
                }), in: 0...1)
                    .accessibilityLabel("Tilt strength")
                    .accessibilityIdentifier("recorder.style.tiltStrength")
                SwitchRow("Drift", isOn: Binding(get: { tilt.drift }, set: { on in model.setLooks { $0.tilt?.drift = on } }))
                SwitchRow("Tilt in at the start", isOn: Binding(get: { tilt.tiltIn }, set: { on in model.setLooks { $0.tilt?.tiltIn = on } }))
                SwitchRow("Tilt out at the end", isOn: Binding(get: { tilt.tiltOut }, set: { on in model.setLooks { $0.tilt?.tiltOut = on } }))
                if model.project.frame == nil {
                    Text("Best with a frame: without one the picture tilts over black.")
                        .font(.system(size: 11.5)).foregroundStyle(RecorderPalette.dim)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

private struct LensControls: View {
    @Bindable var model: EditorModel

    var body: some View {
        let lenses = model.project.lens?.items ?? []
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(text: "Magnifier lens", value: lenses.isEmpty ? nil : Plural.count(lenses.count, "lens", "lenses"))
            GhostButton("Add Lens at Playhead", symbol: "magnifyingglass.circle",
                        tooltip: model.cursor == nil ? "A 2 s lens in the middle of the picture" : "A 2 s lens that follows the cursor",
                        fullWidth: true, identifier: "recorder.style.addLens") { addLens() }
            ForEach(Array(lenses.enumerated()), id: \.element.id) { index, lens in
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(verbatim: "Lens \(index + 1)").font(.system(size: 12.5, weight: .medium))
                        Text(verbatim: String(format: "%.1f–%.1f s", Double(lens.startUs) / 1_000_000, Double(lens.endUs) / 1_000_000))
                            .font(.system(size: 11.5).monospacedDigit()).foregroundStyle(RecorderPalette.dim)
                        Spacer(minLength: 4)
                        IconButton(systemName: "trash", tooltip: "Delete this lens", size: 11) { remove(lens.id) }
                    }
                    SectionLabel(text: "Magnification", value: String(format: "%.1f×", lens.magnification))
                    Slider(value: Binding(get: { lens.magnification }, set: { value in
                        update(lens.id) { $0.magnification = (value * 10).rounded() / 10 }
                    }), in: 1.5...4)
                        .accessibilityLabel("Lens \(index + 1) magnification")
                    SectionLabel(text: "Size", value: "\(Int((lens.radius * 100).rounded()))%")
                    Slider(value: Binding(get: { lens.radius }, set: { value in
                        update(lens.id) { $0.radius = (value * 100).rounded() / 100 }
                    }), in: 0.04...0.4)
                        .accessibilityLabel("Lens \(index + 1) size")
                    if model.cursor != nil {
                        SwitchRow("Follow the cursor", isOn: Binding(get: { lens.follow }, set: { on in update(lens.id) { $0.follow = on } }))
                    }
                }
                .padding(.top, 4)
            }
        }
    }

    private func addLens() {
        let durationUs = model.project.source.durationUs
        let startUs = min(max(0, TimelineMap.sourceTime(atOutput: model.clock.outUs, in: model.project)), max(0, durationUs - 200_000))
        let lens = EditProject.LensItem(id: EditProject.newID("l"), startUs: startUs, endUs: min(durationUs, startUs + 2_000_000),
                                        follow: model.cursor != nil)
        model.setLooks { project in
            var settings = project.lens ?? EditProject.Lens()
            settings.items.append(lens)
            project.lens = settings
        }
    }

    private func update(_ id: String, _ change: @escaping (inout EditProject.LensItem) -> Void) {
        model.setLooks { project in
            guard var settings = project.lens, let index = settings.items.firstIndex(where: { $0.id == id }) else { return }
            change(&settings.items[index])
            project.lens = settings
        }
    }

    private func remove(_ id: String) {
        model.setLooks { project in
            project.lens?.items.removeAll { $0.id == id }
            if project.lens?.items.isEmpty == true { project.lens = nil }
        }
    }
}
