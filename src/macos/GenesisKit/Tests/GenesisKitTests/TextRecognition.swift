import CoreGraphics
import Vision

/// Reads the text of a rendered picture for a test. Vision's accurate recognizer can fail to initialize its E5RT model
/// on a busy Mac (`e5rt_execution_stream_operation_create_precompiled_compute_operation_with_options`, error 13); the
/// same pixels are then read by its fast recognizer on the CPU, so every visible-word assertion still runs and a real
/// widget regression is not hidden among runtime failures.
func recognizeText(in image: CGImage, with request: VNRecognizeTextRequest) throws {
    do {
        try VNImageRequestHandler(cgImage: image).perform([request])
    } catch {
        request.recognitionLevel = .fast
        for (stage, devices) in try request.supportedComputeStageDevices {
            if let cpu = devices.first(where: { if case .cpu = $0 { return true }; return false }) {
                request.setComputeDevice(cpu, for: stage)
            }
        }
        try VNImageRequestHandler(cgImage: image).perform([request])
    }
}
