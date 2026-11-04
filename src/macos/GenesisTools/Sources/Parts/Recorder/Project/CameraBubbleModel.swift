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
