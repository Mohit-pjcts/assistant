import Foundation

/// What the earbud microphone heard: one channel, at the rate the hardware ran.
public struct RecordedAudio: Sendable, Equatable {
    public let samples: [Float]
    public let sampleRate: Double

    public init(samples: [Float], sampleRate: Double) {
        self.samples = samples
        self.sampleRate = sampleRate
    }

    public var seconds: Double { sampleRate > 0 ? Double(samples.count) / sampleRate : 0 }
}

/// Turns a raw earbud recording into what the Mac's speech-to-text wants: a
/// 16 kHz, mono, 16-bit WAV with the level brought up.
///
/// Measured on the real earbuds (PLAN.md Phase 32, STEPS.md 184): the inline mic
/// is quiet (a peak of -22 dBFS, about 16 dB under a normal speech level) and
/// varies by 13 dB with how close it is to the mouth, so the level is normalized
/// rather than sent as recorded.
public enum VoicePrep {
    public static let targetRate = 16_000.0
    /// The loudest sample is brought to this level.
    public static let targetPeakDB = -3.0
    /// The boost is capped, so a near-silent recording is not turned into loud noise.
    public static let maxGainDB = 30.0
    /// A recording whose loudest sample is below this has no speech in it.
    public static let silencePeakDB = -55.0
    /// Shorter than this is a stray press, not a request.
    public static let minSeconds = 0.4

    /// The WAV to upload, or nil when there is nothing to transcribe (too short,
    /// or silent).
    public static func wav(from audio: RecordedAudio) -> Data? {
        guard audio.sampleRate > 0, audio.seconds >= minSeconds else { return nil }
        guard peak(of: audio.samples) >= amplitude(db: silencePeakDB) else { return nil }
        var samples = resample(audio.samples, from: audio.sampleRate, to: targetRate)
        let peak = peak(of: samples)
        guard peak > 0 else { return nil }
        let gain = min(amplitude(db: maxGainDB), amplitude(db: targetPeakDB) / peak)
        for index in samples.indices { samples[index] = max(-1, min(1, samples[index] * gain)) }
        return encodeWAV(samples, sampleRate: Int(targetRate))
    }

    public static func peak(of samples: [Float]) -> Float {
        samples.reduce(0) { max($0, abs($1)) }
    }

    public static func amplitude(db: Double) -> Float { Float(pow(10, db / 20)) }

    /// Box-filter resampling: each output sample is the mean of the input samples
    /// it covers. Cheap, and good enough for speech going into a recognizer.
    static func resample(_ input: [Float], from rate: Double, to target: Double) -> [Float] {
        guard rate != target, !input.isEmpty else { return input }
        let ratio = rate / target
        let count = Int(Double(input.count) / ratio)
        var out = [Float](repeating: 0, count: count)
        for index in 0..<count {
            let start = Int(Double(index) * ratio)
            let end = max(start + 1, min(input.count, Int(Double(index + 1) * ratio)))
            var sum: Float = 0
            for position in start..<end { sum += input[position] }
            out[index] = sum / Float(end - start)
        }
        return out
    }

    static func encodeWAV(_ samples: [Float], sampleRate: Int) -> Data {
        var data = Data()
        func append<T: FixedWidthInteger>(_ value: T) {
            withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) }
        }
        data.append(contentsOf: Array("RIFF".utf8)); append(UInt32(36 + samples.count * 2))
        data.append(contentsOf: Array("WAVEfmt ".utf8)); append(UInt32(16))
        append(UInt16(1)); append(UInt16(1)); append(UInt32(sampleRate))
        append(UInt32(sampleRate * 2)); append(UInt16(2)); append(UInt16(16))
        data.append(contentsOf: Array("data".utf8)); append(UInt32(samples.count * 2))
        for sample in samples { append(Int16(max(-1, min(1, sample)) * Float(Int16.max))) }
        return data
    }
}
