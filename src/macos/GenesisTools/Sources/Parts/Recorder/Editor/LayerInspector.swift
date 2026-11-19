import SwiftUI

struct LayerInspector: View {
    let model: EditorModel
    @State private var defaultsOpen = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Layers").font(.headline)
                Spacer()
                Button { defaultsOpen = true } label: { Image(systemName: "slider.horizontal.3").frame(width: 26, height: 26) }
                .buttonStyle(.genHoverPlain())
                .accessibilityLabel("Layer drop settings")
                .instantTooltip("Set the place and size of new layers")
                .popover(isPresented: $defaultsOpen) { LayerDropSettings() }
            }
            if let row = model.inspectedLayer {
                Picker("Layer", selection: Binding(get: { row.id }, set: { model.selectLayer($0) })) {
                    ForEach(model.layerRows) { item in Label(item.name, systemImage: item.icon).tag(item.id) }
                }
                .accessibilityIdentifier("recorder.layers.selection")
                if let media = row.media {
                    MediaLayerInspector(model: model, layer: media).id(media.id)
                } else if let camera = model.project.camera {
                    CameraBubbleSection(model: model, layerControls: true)
                    let size = model.layerCanvasSize
                    let rect = camera.rect(canvas: size)
                    LayerFractionControl("Horizontal position", value: rect.midX / size.width) { x in
                        model.edit([.layer(.init(id: row.id, x: x, y: rect.midY / size.height))])
                    }
                    LayerFractionControl("Vertical position", value: rect.midY / size.height) { y in
                        model.edit([.layer(.init(id: row.id, x: rect.midX / size.width, y: y))])
                    }
                    LabeledContent("Span", value: "Whole recording")
                    LabeledContent("Opacity", value: "100%")
                }
            }
            WideButton(title: EditorModel.addLayerTitle, systemImage: "plus") { model.chooseLayerFile() }
        }
        .accessibilityIdentifier("recorder.layers.inspector")
    }
}

struct LayerDropSettings: View {
    @State private var defaults = EditorModel.DropDefaults()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker("Place dropped files at", selection: $defaults.atPointer) {
                Text("Centre").tag(false)
                Text("Pointer").tag(true)
            }
            SectionLabel(text: "Initial width", value: defaults.width.formatted(.percent))
            Slider(value: $defaults.width, in: 0.05...1, step: 0.01).accessibilityLabel("Initial width")
        }.padding().frame(width: 250)
            .onChange(of: defaults.width) { _, _ in defaults.save() }
            .onChange(of: defaults.atPointer) { _, _ in defaults.save() }
    }
}

private struct MediaLayerInspector: View {
    let model: EditorModel
    let layer: EditProject.MediaLayer

    var body: some View {
        SwitchRow("Visible", isOn: Binding(get: { !layer.hidden }, set: { set(.init(id: layer.id, hidden: !$0)) }))
        LayerFractionControl("Horizontal position", value: layer.x) { set(.init(id: layer.id, x: $0)) }
        LayerFractionControl("Vertical position", value: layer.y) { set(.init(id: layer.id, y: $0)) }
        LayerFractionControl("Width", value: layer.width, range: 0.05...1) { set(.init(id: layer.id, width: $0)) }
        LayerFractionControl("Opacity", value: layer.opacity) { set(.init(id: layer.id, opacity: $0)) }
        Picker("Shape", selection: Binding(get: { layer.shape }, set: { set(.init(id: layer.id, shape: .some($0))) })) {
            Text("Original").tag(nil as EditProject.CameraShape?)
            ForEach(EditProject.CameraShape.allCases, id: \.self) { shape in
                Text(shape.rawValue.capitalized).tag(Optional(shape))
            }
        }
        SectionLabel(text: "Span in the recording")
        let duration = Int(model.project.source.durationUs)
        let bound = duration < Int.max ? duration + 1 : Int.max
        seconds("Start", value: Int(layer.startUs), upper: bound, fractionDigits: 6) { value in
            guard value < layer.endUs else { return false }
            set(.init(id: layer.id, startUs: Int64(value)))
            return true
        }
        seconds("End", value: Int(layer.endUs), upper: bound, fractionDigits: 6) { value in
            guard value > layer.startUs, value <= duration else { return false }
            set(.init(id: layer.id, endUs: Int64(value)))
            return true
        }
        if layer.kind == .video {
            seconds("Start in video", value: layer.videoStartMs, upper: Int.max, fractionDigits: 3) { value in
                guard value < Int.max else { return false }
                set(.init(id: layer.id, videoStartMs: value))
                return true
            }
            SwitchRow("Play video sound", isOn: Binding(get: { layer.videoSound },
                                                        set: { set(.init(id: layer.id, videoSound: $0)) }))
            SwitchRow("Loop video", isOn: Binding(get: { layer.loop }, set: { set(.init(id: layer.id, loop: $0)) }))
        }
    }

    private func set(_ op: EditOp.Layer) { model.edit([.layer(op)]) }

    private func seconds(_ label: String, value: Int, upper: Int, fractionDigits: Int,
                         apply: @escaping (Int) -> Bool) -> some View {
        let step = fractionDigits == 6 ? 100_000 : 100
        return LabeledContent(label) {
            // Allow values just outside the edit's bounds so a bad span can report its validation error.
            KitNumberField("\(label) in seconds", value: Binding(get: { value }, set: { next in
                if next != value, next < 0 || !apply(next) {
                    model.show("Enter a time within the layer’s range.", error: true)
                }
            }), in: -step...upper, step: step, suffix: .text("s"),
                           style: .bare, fractionDigits: fractionDigits)
        }
    }
}

/// The thumb and label follow every pointer event. One completed adjustment makes one editor edit.
private struct LayerFractionControl: View {
    let label: String
    let value: Double
    let range: ClosedRange<Double>
    let apply: (Double) -> Void
    @State private var draft: Double?
    @State private var dragging = false

    init(_ label: String, value: Double, range: ClosedRange<Double> = 0...1, apply: @escaping (Double) -> Void) {
        self.label = label
        self.value = value
        self.range = range
        self.apply = apply
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            SectionLabel(text: label, value: (draft ?? value).formatted(.percent))
            Slider(value: Binding(get: { draft ?? value }, set: { new in
                if dragging { draft = new } else if new != value { apply(new) }
            }), in: range, step: 0.01, onEditingChanged: { editing in
                dragging = editing
                if !editing, let end = draft {
                    draft = nil
                    if end != value { apply(end) }
                }
            }).accessibilityLabel(label)
        }
    }
}

extension EditorModel {
    var layerCanvasSize: CGSize {
        EditRenderer.outputSizes(source: CGSize(width: project.source.width, height: project.source.height),
                                 maxHeight: 0, aspect: project.frame?.aspect).canvas
    }
}
