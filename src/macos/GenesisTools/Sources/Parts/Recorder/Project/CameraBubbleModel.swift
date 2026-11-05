import CoreGraphics
import Foundation

extension EditProject {
    enum CameraShape: String, Codable, CaseIterable {
        case circle, rounded, square
    }

    /// A corner keeps the bubble `margin` from two edges; `custom` places its centre at (x, y).
    enum CameraCorner: String, Codable, CaseIterable {
        case bottomRight, bottomLeft, topRight, topLeft, custom
    }

    /// The camera recorded beside the screen (`camera.mov`), drawn over the picture as a bubble. The TypeScript side
    /// writes the same shape (src/utils/recording-editor/camera.ts). Each hidden part is a `cameraHide` item on an
    /// effect lane, in SOURCE times, so it moves with a cut.
    struct Camera: Codable, Equatable {
        struct Hidden: Codable, Equatable, Identifiable {
            var id: String
            var startUs: Int64
            var endUs: Int64
            /// The effect lane it sits on; nil is the first lane that holds camera parts.
            var lane: String?

            init(id: String = Hidden.newID(), startUs: Int64, endUs: Int64, lane: String? = nil) {
                self.id = id
                self.startUs = startUs
                self.endUs = endUs
                self.lane = lane
            }

            private enum Keys: String, CodingKey { case id, startUs, endUs, lane }

            /// A part saved before the lanes has no id: it gets one from its start, as camera.ts gives it.
            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: Keys.self)
                startUs = try c.decode(Int64.self, forKey: .startUs)
                endUs = try c.decode(Int64.self, forKey: .endUs)
                id = try c.decodeIfPresent(String.self, forKey: .id) ?? "k" + String(startUs, radix: 36)
                lane = try c.decodeIfPresent(String.self, forKey: .lane)
            }

            static func newID() -> String { "k" + UUID().uuidString.prefix(8).lowercased() }
        }

        /// The camera's movie; a bare name is beside the source movie.
        var file: String
        /// The camera time of a source moment is `source - offsetMs`.
        var offsetMs = 0
        var show = true
        var corner: CameraCorner = .bottomRight
        var x = 0.88
        var y = 0.82
        /// The side as a fraction of the canvas's short side.
        var size = 0.24
        var shape: CameraShape = .circle
        var mirror = true
        var margin = 0.035
        var hidden: [Hidden] = []

        init(file: String) {
            self.file = file
        }

        private enum Keys: String, CodingKey { case file, offsetMs, show, corner, x, y, size, shape, mirror, margin, hidden }

        /// Every key but `file` may be missing (a file an agent wrote by hand); the defaults are camera.ts's.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            file = try c.decode(String.self, forKey: .file)
            offsetMs = try c.decodeIfPresent(Int.self, forKey: .offsetMs) ?? 0
            show = try c.decodeIfPresent(Bool.self, forKey: .show) ?? true
            corner = try c.decodeIfPresent(CameraCorner.self, forKey: .corner) ?? .bottomRight
            x = try c.decodeIfPresent(Double.self, forKey: .x) ?? 0.88
            y = try c.decodeIfPresent(Double.self, forKey: .y) ?? 0.82
            size = try c.decodeIfPresent(Double.self, forKey: .size) ?? 0.24
            shape = try c.decodeIfPresent(CameraShape.self, forKey: .shape) ?? .circle
            mirror = try c.decodeIfPresent(Bool.self, forKey: .mirror) ?? true
            margin = try c.decodeIfPresent(Double.self, forKey: .margin) ?? 0.035
            hidden = try c.decodeIfPresent([Hidden].self, forKey: .hidden) ?? []
        }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: Keys.self)
            try c.encode(file, forKey: .file)
            try c.encode(offsetMs, forKey: .offsetMs)
            try c.encode(show, forKey: .show)
            try c.encode(corner, forKey: .corner)
            try c.encode(x, forKey: .x)
            try c.encode(y, forKey: .y)
            try c.encode(size, forKey: .size)
            try c.encode(shape, forKey: .shape)
            try c.encode(mirror, forKey: .mirror)
            try c.encode(margin, forKey: .margin)
            try c.encode(hidden, forKey: .hidden)
        }

        /// The camera movie's URL for an edit whose source movie is `video`.
        func movieURL(video: String) -> URL {
            file.hasPrefix("/") ? URL(fileURLWithPath: file)
                : URL(fileURLWithPath: video).deletingLastPathComponent().appendingPathComponent(file)
        }

        func shows(atSourceUs us: Int64) -> Bool {
            show && !hidden.contains { us >= $0.startUs && us < $0.endUs }
        }

        /// The camera movie's time of a source moment, in µs.
        func cameraUs(atSourceUs us: Int64) -> Int64 { us - Int64(offsetMs) * 1000 }

        /// The bubble's square on a canvas, top-left origin, the same rule as camera.ts `bubbleRect`.
        func rect(canvas: CGSize) -> CGRect {
            let short = min(canvas.width, canvas.height)
            let side = CGFloat(size) * short
            let gap = CGFloat(margin) * short
            let half = side / 2
            let center: CGPoint
            switch corner {
            case .bottomRight: center = CGPoint(x: canvas.width - gap - half, y: canvas.height - gap - half)
            case .bottomLeft: center = CGPoint(x: gap + half, y: canvas.height - gap - half)
            case .topRight: center = CGPoint(x: canvas.width - gap - half, y: gap + half)
            case .topLeft: center = CGPoint(x: gap + half, y: gap + half)
            case .custom:
                center = CGPoint(x: min(canvas.width - half, max(half, CGFloat(x) * canvas.width)),
                                 y: min(canvas.height - half, max(half, CGFloat(y) * canvas.height)))
            }
            return CGRect(x: center.x - half, y: center.y - half, width: side, height: side)
        }
    }
}

extension EditProject {
    /// The `camera` edit op (src/utils/recording-editor/project.ts `cameraOpSchema`), the one `movie.camera(...)` and
    /// `tools recorder edit` send. The editor's drag and Style controls change the bubble only through it, so edit.json is
    /// the same from every door; camera-ops.json holds the cases both sides are tested on.
    struct CameraChange: Decodable, Equatable {
        var file: String?
        var show: Bool?
        var corner: CameraCorner?
        /// The centre as fractions of the canvas; setting either makes the corner custom.
        var x: Double?
        var y: Double?
        var size: Double?
        var shape: CameraShape?
        var mirror: Bool?
        var offsetMs: Int?
        /// false removes the bubble from the edit (the camera movie stays).
        var enabled: Bool?

        init(file: String? = nil, show: Bool? = nil, corner: CameraCorner? = nil, x: Double? = nil, y: Double? = nil,
             size: Double? = nil, shape: CameraShape? = nil, mirror: Bool? = nil, offsetMs: Int? = nil, enabled: Bool? = nil) {
            self.file = file
            self.show = show
            self.corner = corner
            self.x = x
            self.y = y
            self.size = size
            self.shape = shape
            self.mirror = mirror
            self.offsetMs = offsetMs
            self.enabled = enabled
        }

        /// The op's ranges: the TypeScript side refuses a value outside them, the editor holds a drag inside them.
        static let sizeRange = 0.08...0.6
        static let offsetRange = -600_000...600_000
    }

    enum CameraChangeError: LocalizedError {
        case noCamera

        var errorDescription: String? {
            #"this edit has no camera yet; give the camera movie with { op: "camera", file: "camera.mov" }"#
        }
    }

    /// The edit with `change` applied as project.ts applies the `camera` op.
    func applying(_ change: CameraChange) throws -> EditProject {
        var next = self
        if change.enabled == false {
            next.camera = nil
            return next
        }
        guard let file = change.file ?? camera?.file else { throw CameraChangeError.noCamera }
        var bubble = camera ?? Camera(file: file)
        bubble.file = file
        if let show = change.show { bubble.show = show }
        if let corner = change.corner { bubble.corner = corner }
        if let x = change.x { bubble.x = min(1, max(0, x)) }
        if let y = change.y { bubble.y = min(1, max(0, y)) }
        if change.x != nil || change.y != nil { bubble.corner = .custom }
        if let size = change.size {
            bubble.size = min(CameraChange.sizeRange.upperBound, max(CameraChange.sizeRange.lowerBound, size))
        }
        if let shape = change.shape { bubble.shape = shape }
        if let mirror = change.mirror { bubble.mirror = mirror }
        if let offset = change.offsetMs {
            bubble.offsetMs = min(CameraChange.offsetRange.upperBound, max(CameraChange.offsetRange.lowerBound, offset))
        }
        next.camera = bubble
        return next
    }
}

/// The preview's drag and resize of the bubble as camera changes. A view of the canvas at any size maps by fractions,
/// because the bubble's place and side are fractions of the canvas.
enum CameraPlacement {
    /// The bubble centred at `center` (view points), held where the whole bubble shows, as the renderer draws it.
    static func moved(_ camera: EditProject.Camera, center: CGPoint, in view: CGSize) -> EditProject.CameraChange {
        let half = camera.rect(canvas: view).width / 2
        let x = min(view.width - half, max(half, center.x)) / max(1, view.width)
        let y = min(view.height - half, max(half, center.y)) / max(1, view.height)
        return .init(x: Double(x), y: Double(y))
    }

    /// The grip that sizes the bubble sits on the corner that faces into the canvas, so dragging it out grows the bubble
    /// toward the pointer: away from the anchoring corner, or the bottom right of a bubble placed by its centre.
    static func grip(_ corner: EditProject.CameraCorner) -> (x: CGFloat, y: CGFloat) {
        switch corner {
        case .bottomRight: return (-1, -1)
        case .bottomLeft: return (1, -1)
        case .topRight: return (-1, 1)
        case .topLeft, .custom: return (1, 1)
        }
    }

    /// The side after dragging the grip by `translation` from a bubble of side `start`. A corner bubble keeps its far
    /// corner, so the grip moves with the side; a centred one grows both ways, so the grip moves half as far.
    static func side(start: CGFloat, translation: CGSize, corner: EditProject.CameraCorner) -> CGFloat {
        let grip = grip(corner)
        let along = (grip.x * translation.width + grip.y * translation.height) / 2
        return start + (corner == .custom ? 2 * along : along)
    }

    /// The bubble with a side of `side` view points, inside the op's size range.
    static func resized(_ camera: EditProject.Camera, side: CGFloat, in view: CGSize) -> EditProject.CameraChange {
        let size = Double(side / max(1, min(view.width, view.height)))
        let range = EditProject.CameraChange.sizeRange
        return .init(size: min(range.upperBound, max(range.lowerBound, size)))
    }
}
