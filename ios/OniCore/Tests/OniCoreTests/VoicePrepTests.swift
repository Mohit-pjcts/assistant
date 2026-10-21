import Foundation
import Testing
@testable import OniCore

/// The earbud recording on its way to speech-to-text: mono, 16 kHz, loud enough.
@Suite struct VoicePrepTests {
    private func tone(seconds: Double, rate: Double = 48_000, peakDB: Double, frequency: Double = 220) -> RecordedAudio {
        let count = Int(seconds * rate)
        let amplitude = VoicePrep.amplitude(db: peakDB)
        let samples = (0..<count).map { Float(sin(2 * Double.pi * frequency * Double($0) / rate)) * amplitude }
        return RecordedAudio(samples: samples, sampleRate: rate)
    }

    /// The decoded 16-bit samples of a WAV this module wrote.
    private func samples(of wav: Data) -> [Int16] {
        wav.dropFirst(44).withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
    }

    private func peakDB(of wav: Data) -> Double {
        let peak = samples(of: wav).map { abs(Double($0)) }.max() ?? 0
        return 20 * log10(peak / Double(Int16.max))
    }

    @Test func theOutputIsAMono16kHz16BitWav() throws {
        let wav = try #require(VoicePrep.wav(from: tone(seconds: 1, peakDB: -22)))
        #expect(wav.prefix(4) == Data("RIFF".utf8) && wav[8..<12] == Data("WAVE".utf8))
        func u32(_ at: Int) -> UInt32 { wav[at..<at + 4].withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) } }
        func u16(_ at: Int) -> UInt16 { wav[at..<at + 2].withUnsafeBytes { $0.loadUnaligned(as: UInt16.self) } }
        #expect(u16(22) == 1)            // mono
        #expect(u32(24) == 16_000)       // 16 kHz
        #expect(u16(34) == 16)           // 16 bit
        #expect(samples(of: wav).count == 16_000)
        #expect(Int(u32(40)) == 16_000 * 2)
    }

    @Test func aQuietEarbudRecordingIsBroughtUpToTheTargetLevel() throws {
        // The measured earbud level: a -22 dBFS peak.
        let wav = try #require(VoicePrep.wav(from: tone(seconds: 1, peakDB: -22)))
        #expect(abs(peakDB(of: wav) - VoicePrep.targetPeakDB) < 0.5)
    }

    @Test func aLoudRecordingIsBroughtDownNotClipped() throws {
        let wav = try #require(VoicePrep.wav(from: tone(seconds: 1, peakDB: -0.5)))
        #expect(abs(peakDB(of: wav) - VoicePrep.targetPeakDB) < 0.5)
    }

    @Test func theBoostIsCappedSoAFaintRecordingIsNotTurnedIntoLoudNoise() throws {
        // -50 dBFS would need 47 dB; the cap allows 30.
        let wav = try #require(VoicePrep.wav(from: tone(seconds: 1, peakDB: -50)))
        #expect(abs(peakDB(of: wav) - (-50 + VoicePrep.maxGainDB)) < 0.7)
    }

    @Test func aSilentRecordingHasNothingToTranscribe() {
        #expect(VoicePrep.wav(from: tone(seconds: 1, peakDB: -70)) == nil)
        #expect(VoicePrep.wav(from: RecordedAudio(samples: Array(repeating: 0, count: 48_000), sampleRate: 48_000)) == nil)
    }

    @Test func aStrayPressIsTooShortToBeARequest() {
        #expect(VoicePrep.wav(from: tone(seconds: 0.2, peakDB: -10)) == nil)
        #expect(VoicePrep.wav(from: tone(seconds: 0.45, peakDB: -10)) != nil)
    }

    @Test func otherSampleRatesAreResampledToo() throws {
        let wav = try #require(VoicePrep.wav(from: tone(seconds: 1, rate: 44_100, peakDB: -20)))
        #expect(abs(samples(of: wav).count - 16_000) <= 1)
        let already = try #require(VoicePrep.wav(from: tone(seconds: 1, rate: 16_000, peakDB: -20)))
        #expect(samples(of: already).count == 16_000)
    }

    @Test func aToneSurvivesResamplingAtTheRightFrequency() throws {
        // 440 Hz for one second has 440 rising zero crossings at any sample rate.
        let wav = try #require(VoicePrep.wav(from: tone(seconds: 1, peakDB: -10, frequency: 440)))
        let s = samples(of: wav)
        let crossings = zip(s, s.dropFirst()).filter { $0 <= 0 && $1 > 0 }.count
        #expect(abs(crossings - 440) <= 2)
    }
}
