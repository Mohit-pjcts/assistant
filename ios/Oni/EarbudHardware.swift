import AVFoundation
import MediaPlayer
import OniCore
import UIKit

struct EarbudError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

/// The earbud microphone, speaker and button, on the real phone. PLAN.md Phase 32.
///
/// iOS will not start a microphone from the background (Apple DTS; measured on
/// this phone, STEPS.md 181), so Oni is *armed* in the foreground: the audio
/// session is live, the microphone engine keeps running (the orange dot stays on),
/// a silent loop makes Oni the Now Playing app so the earbud button is delivered
/// here and not to a music app, and a press only decides whether what the
/// microphone hears is kept. Proven on the device with the screen locked
/// (STEPS.md 184).
@MainActor
final class EarbudHardware: VoiceRecorder, VoiceOutput {
    /// The earbud button.
    var onButton: (@MainActor () -> Void)?
    /// The microphone or audio session was lost and could not be recovered.
    var onLost: (@MainActor (String) -> Void)?

    private let log: EarbudLog
    private(set) var isArmed = false
    /// Off (the default): the microphone runs only between the two button presses,
    /// so there is no orange dot and no battery cost while waiting, but iOS only
    /// lets it start while Oni is on screen. On: it runs the whole time Oni is
    /// armed, which is the only way to start talking with the phone locked.
    /// How Oni gets the earbud button. `owner`: Oni is the Now Playing app and
    /// the button is delivered to it (nothing else is playing). `music`: music is
    /// playing, iOS sends the button to the music app (an Oni that mixes with it
    /// is not Now Playing, STEPS.md 189), so Oni watches music pause and resume
    /// and treats each as a press, and pauses the music while you talk.
    enum Mode { case owner, music }
    private(set) var mode = Mode.owner
    /// The voice turn is over: Oni may give the music back.
    private var musicPausedForVoice = false
    private var ignoreMusicEventsUntil = Date.distantPast
    /// Whether music was playing at the last look, and the task that keeps looking.
    private var musicWasPlaying = false
    private var musicWatcher: Task<Void, Never>?
    private(set) var keepsMicOn = UserDefaults.standard.bool(forKey: "earbudKeepMicOn")
    private var silentLoop: AVAudioPlayer?
    private var beep: AVAudioPlayer?
    private var engine: AVAudioEngine?
    private var sink: TapSink?
    private var player: AVAudioPlayer?
    private var waiter: PlaybackWaiter?
    private let synthesizer = AVSpeechSynthesizer()
    private var commandTokens: [(MPRemoteCommand, Any)] = []
    private var observers: [NSObjectProtocol] = []
    private var lastPress = Date.distantPast

    init(log: EarbudLog) { self.log = log }

    // MARK: arming

    func arm() async throws {
        guard !isArmed else { return }
        guard await AVAudioApplication.requestRecordPermission() else {
            throw EarbudError("Microphone access is off. Turn it on in Settings > Oni.")
        }
        await requestMusicControl()
        mode = AVAudioSession.sharedInstance().isOtherAudioPlaying ? .music : .owner
        do {
            try configureSession()
        } catch {
            throw EarbudError("The audio session would not start: \(error.localizedDescription)")
        }
        startSilentLoop()
        if mode == .owner { registerCommands() }
        observe()
        if mode == .music { startMusicWatcher() }
        if keepsMicOn, !startEngine() {
            teardown()
            throw EarbudError("The microphone would not start.")
        }
        isArmed = true
        log.add("ARMED (process \(getpid()), \(mode == .music ? "music mode" : "button mode"), mic \(keepsMicOn ? "always on" : "on press only")); \(routeDescription())")
    }

    func setKeepsMicOn(_ on: Bool) {
        guard on != keepsMicOn else { return }
        keepsMicOn = on
        UserDefaults.standard.set(on, forKey: "earbudKeepMicOn")
        log.add("mic mode: \(on ? "always on while armed" : "on press only")")
        guard isArmed else { return }
        if on {
            if engine == nil, !startEngine() { onLost?("The microphone would not start.") }
        } else if !(sink?.isCapturing ?? false) {
            stopEngine()
        }
    }

    func disarm() {
        guard isArmed else { return }
        stop()
        teardown()
        isArmed = false
        log.add("DISARMED")
    }

    private func teardown() {
        musicWatcher?.cancel()
        musicWatcher = nil
        stopEngine()
        silentLoop?.stop()
        silentLoop = nil
        for (command, token) in commandTokens { command.removeTarget(token) }
        commandTokens = []
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        MPNowPlayingInfoCenter.default().playbackState = .stopped
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: the button (Now Playing + remote commands)

    private func startSilentLoop() {
        if let loop = try? AVAudioPlayer(data: ToneMaker.wav(frequency: 0, seconds: 1)) {
            loop.numberOfLoops = -1
            loop.play()
            silentLoop = loop
        }
        // In music mode the music app must stay the Now Playing app.
        guard mode == .owner else { return }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: "Oni voice",
            MPMediaItemPropertyArtist: "Press the earbud button to talk",
            MPNowPlayingInfoPropertyPlaybackRate: 1.0,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: 0.0,
        ]
        MPNowPlayingInfoCenter.default().playbackState = .playing
    }

    private func registerCommands() {
        let center = MPRemoteCommandCenter.shared()
        // A single press has been seen to arrive as any of these.
        for (command, name) in [(center.togglePlayPauseCommand, "togglePlayPause"), (center.playCommand, "play"), (center.pauseCommand, "pause")] {
            command.isEnabled = true
            let token = command.addTarget { [weak self] _ in
                Task { @MainActor in self?.pressed(name) }
                return .success
            }
            commandTokens.append((command, token))
        }
    }

    private func pressed(_ name: String) {
        // One physical press must not count twice if iOS sends two events.
        let now = Date()
        guard now.timeIntervalSince(lastPress) > 0.4 else { return }
        lastPress = now
        log.add("button: \(name)")
        onButton?()
    }

    // MARK: VoiceRecorder

    func beginCapture() -> Bool {
        // In press-only mode the microphone starts here. iOS refuses that unless
        // Oni is on screen (kAUStartIO), which the log records for diagnosis.
        if engine?.isRunning != true {
            stopEngine()
            guard startEngine() else {
                log.add("beginCapture: could not start the microphone (\(UIApplication.shared.applicationState == .active ? "app is on screen" : "app is not on screen"))")
                return false
            }
        }
        guard let sink else { return false }
        sink.begin()
        return true
    }

    func endCapture() -> RecordedAudio? {
        guard let sink else { return nil }
        let result = sink.end()
        if !keepsMicOn { stopEngine() }
        if max(result.peaks.0, result.peaks.1) == 0 {
            log.add("the microphone delivered only silence; refreshing the audio session for the next try")
            refreshSession(because: "silent capture")
        }
        log.add(String(format: "captured %.1fs in %d buffers; peak left %.1f dBFS, right %.1f dBFS; used %@",
                       Double(result.samples.count) / sink.sampleRate, result.buffers,
                       Self.db(result.peaks.0), Self.db(result.peaks.1), result.usedRight ? "right" : "left"))
        return RecordedAudio(samples: result.samples, sampleRate: sink.sampleRate)
    }

    private static func db(_ peak: Float) -> Double { 20 * log10(Double(max(peak, 1e-9))) }

    // MARK: VoiceOutput

    /// True only when the sound goes to something worn: not the phone's speaker
    /// or receiver, so a private reply is never read out to the room.
    var canSpeakPrivately: Bool {
        let worn: Set<AVAudioSession.Port> = [.headphones, .usbAudio, .bluetoothA2DP, .bluetoothHFP, .bluetoothLE]
        return AVAudioSession.sharedInstance().currentRoute.outputs.contains { worn.contains($0.portType) }
    }

    func earcon(_ earcon: Earcon) {
        let (frequency, seconds): (Double, Double) = switch earcon {
        case .started: (880, 0.15)
        case .stopped: (440, 0.15)
        case .cancelled: (330, 0.2)
        case .error: (150, 0.5)
        }
        beep = try? AVAudioPlayer(data: ToneMaker.wav(frequency: frequency, seconds: seconds))
        beep?.play()
    }

    func play(mp3: Data) async {
        guard let made = try? AVAudioPlayer(data: mp3) else {
            log.add("could not decode the reply audio")
            return
        }
        let waiter = PlaybackWaiter()
        made.delegate = waiter
        log.add(String(format: "playing reply audio (%.1fs); %@", made.duration, routeDescription()))
        player = made
        self.waiter = waiter
        if !made.play() { waiter.finish() }
        await waiter.wait()
        player = nil
        self.waiter = nil
        log.add("reply audio finished")
    }

    func say(_ text: String) async {
        log.add("speaking with the phone's own voice: \(text.prefix(60))")
        let waiter = PlaybackWaiter()
        synthesizer.delegate = waiter
        self.waiter = waiter
        synthesizer.speak(AVSpeechUtterance(string: text))
        await waiter.wait()
        self.waiter = nil
    }

    func stop() {
        player?.stop()
        synthesizer.stopSpeaking(at: .immediate)
        waiter?.finish()
    }

    // MARK: the always-on microphone

    private func startEngine() -> Bool {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            log.add("the microphone input has no usable format")
            return false
        }
        let sink = TapSink(sampleRate: format.sampleRate)
        Self.installTap(on: input, format: format, sink: sink)
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            log.add("engine.start failed: \(error)")
            return false
        }
        self.engine = engine
        self.sink = sink
        log.add("microphone running: \(Int(format.sampleRate)) Hz, \(format.channelCount) ch")
        return true
    }

    private func stopEngine() {
        guard let engine else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        self.engine = nil
        sink = nil
    }

    /// Built in a `nonisolated` function on purpose: written inside this
    /// main-actor class the closure would be main-actor-isolated, AVAudio calls it
    /// on its own real-time queue, and Swift's isolation check traps (this crashed
    /// the app on the first buffer, STEPS.md 182).
    private nonisolated static func installTap(on input: AVAudioInputNode, format: AVAudioFormat, sink: TapSink) {
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
            sink.consume(buffer)
        }
    }

    /// iOS stops an AVAudioEngine whenever the route changes (earbuds in or out)
    /// and does not restart it, so rebuild it for the new route.
    private func restartEngine(because reason: String) {
        guard isArmed, keepsMicOn || (sink?.isCapturing ?? false) else {
            stopEngine()   // press-only: the next press starts it for the new route
            return
        }
        stopEngine()
        if startEngine() {
            log.add("microphone restarted (\(reason)); \(routeDescription())")
        } else {
            log.add("microphone could NOT be restarted (\(reason))")
            if mode == .owner, AVAudioSession.sharedInstance().isOtherAudioPlaying {
                switchToMusicMode(because: "music took the audio away")
            } else {
                onLost?("The microphone stopped and could not be restarted. Tap Arm again.")
            }
        }
    }

    // MARK: diagnostics and recovery

    private func observe() {
        let center = NotificationCenter.default
        let names: [Notification.Name] = [
            AVAudioSession.interruptionNotification,
            AVAudioSession.routeChangeNotification,
            AVAudioSession.mediaServicesWereResetNotification,
            AVAudioSession.silenceSecondaryAudioHintNotification,
            .AVAudioEngineConfigurationChange,
        ]
        for name in names {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                let event = Self.classify(note)
                MainActor.assumeIsolated { self?.handle(event) }
            })
        }
    }

    private enum Event { case interruptionBegan, interruptionEnded, routeChanged(UInt), engineChanged, servicesReset, music(playing: Bool), other }

    private nonisolated static func classify(_ note: Notification) -> Event {
        switch note.name {
        case AVAudioSession.interruptionNotification:
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt ?? 0
            return AVAudioSession.InterruptionType(rawValue: raw) == .ended ? .interruptionEnded : .interruptionBegan
        case AVAudioSession.routeChangeNotification:
            return .routeChanged(note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0)
        case AVAudioSession.silenceSecondaryAudioHintNotification:
            let raw = note.userInfo?[AVAudioSessionSilenceSecondaryAudioHintTypeKey] as? UInt ?? 0
            return .music(playing: AVAudioSession.SilenceSecondaryAudioHintType(rawValue: raw) == .begin)
        case .AVAudioEngineConfigurationChange: return .engineChanged
        case AVAudioSession.mediaServicesWereResetNotification: return .servicesReset
        default: return .other
        }
    }

    private func handle(_ event: Event) {
        switch event {
        case .interruptionBegan:
            log.add("interrupted (a call, Siri, an alarm or music starting)")
            // Music starting is an interruption of a session that does not mix.
            // A call is not "other audio playing", so it falls through to the
            // normal resume below.
            if mode == .owner {
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(400))
                    if AVAudioSession.sharedInstance().isOtherAudioPlaying { self.switchToMusicMode(because: "music started") }
                }
            }
        case .music(let playing):
            log.add("system hint: other audio \(playing ? "began" : "ended")")
        case .interruptionEnded:
            // After a call the session and the engine are both stopped.
            do {
                try AVAudioSession.sharedInstance().setActive(true)
                silentLoop?.play()
                if keepsMicOn { restartEngine(because: "the interruption ended") }
            } catch {
                log.add("could not resume after the interruption: \(error)")
                onLost?("Oni lost the audio after an interruption. Tap Arm again.")
            }
        case .routeChanged(let reason):
            log.add("route change (reason \(reason)); \(routeDescription())")
            // Earbuds plugged in or out after arming: the first engine on the new
            // input recorded exact silence on the device (STEPS.md 188) until the
            // session was re-armed, so cycle the session for the new route.
            if isArmed, reason == 1 || reason == 2 { refreshSession(because: "the earbuds changed") }
        case .engineChanged:
            restartEngine(because: "the audio route changed")
        case .servicesReset:
            log.add("iOS reset its audio services")
            onLost?("iOS reset the audio system. Tap Arm again.")
        case .other:
            break
        }
    }

    /// Deactivates and reactivates the audio session (what re-arming does), then
    /// brings back the silent loop and, if the mic is meant to stay on, the engine.
    private func refreshSession(because reason: String) {
        guard isArmed, !(sink?.isCapturing ?? false) else { return }
        stopEngine()
        silentLoop?.stop()
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setActive(false)
            try configureSession()
        } catch {
            log.add("could not refresh the audio session (\(reason)): \(error)")
        }
        startSilentLoop()
        if keepsMicOn, !startEngine() {
            if mode == .owner, session.isOtherAudioPlaying { switchToMusicMode(because: "music took the audio away") }
            else { onLost?("The microphone stopped and could not be restarted. Tap Arm again.") }
        }
        log.add("audio session refreshed (\(reason)); \(routeDescription())")
    }

    /// Not mixing makes Oni the Now Playing app (the button comes to it) but stops
    /// other audio; mixing keeps the music playing.
    private func configureSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: mode == .music ? [.mixWithOthers] : [])
        try session.setActive(true)
    }

    /// Music started (or was playing) while Oni was the button owner: iOS has
    /// stopped Oni's session. Take the session back without interrupting the music.
    private func switchToMusicMode(because reason: String) {
        guard isArmed, mode == .owner else { return }
        mode = .music
        stopEngine()
        silentLoop?.stop()
        for (command, token) in commandTokens { command.removeTarget(token) }
        commandTokens = []
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        do {
            try configureSession()
        } catch {
            log.add("music mode: could not take the audio session back: \(error)")
        }
        startSilentLoop()
        if keepsMicOn, !startEngine() { log.add("music mode: the microphone will start on the first press instead") }
        startMusicWatcher()
        log.add("switched to music mode (\(reason)); \(routeDescription())")
    }

    // MARK: music

    private func requestMusicControl() async {
        guard MPMediaLibrary.authorizationStatus() == .notDetermined else { return }
        let status = await withCheckedContinuation { continuation in
            MPMediaLibrary.requestAuthorization { continuation.resume(returning: $0) }
        }
        log.add("music control permission: \(status == .authorized ? "granted" : "not granted")")
    }

    private func pauseMusic(_ why: String) {
        ignoreMusicEventsUntil = Date().addingTimeInterval(1.5)
        MPMusicPlayerController.systemMusicPlayer.pause()
        log.add("paused the music (\(why))")
    }

    /// The voice turn finished or was cancelled: music that was playing before the
    /// press goes on playing.
    func voiceTurnEnded() {
        guard mode == .music, musicPausedForVoice else { return }
        musicPausedForVoice = false
        ignoreMusicEventsUntil = Date().addingTimeInterval(1.5)
        MPMusicPlayerController.systemMusicPlayer.play()
        log.add("resumed the music")
    }

    private func isMusicPlaying() -> Bool {
        AVAudioSession.sharedInstance().isOtherAudioPlaying
            || MPMusicPlayerController.systemMusicPlayer.playbackState == .playing
    }

    /// Looks at the music a few times a second. The system's own "other audio
    /// started or stopped" notification never arrived on the device (STEPS.md 190),
    /// so the state is read directly instead.
    private func startMusicWatcher() {
        musicWatcher?.cancel()
        musicWasPlaying = isMusicPlaying()
        log.add("watching the music (playing now: \(musicWasPlaying))")
        musicWatcher = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(250))
                guard let self, !Task.isCancelled else { return }
                let playing = self.isMusicPlaying()
                if playing != self.musicWasPlaying {
                    self.musicWasPlaying = playing
                    self.musicChanged(playing: playing)
                }
            }
        }
    }

    /// Music paused or resumed while Oni is in music mode. That is the earbud
    /// button: it pauses playing music and plays paused music.
    private func musicChanged(playing: Bool) {
        guard mode == .music else { return }
        if Date() < ignoreMusicEventsUntil {
            log.add("music \(playing ? "started" : "paused") (caused by Oni, ignored)")
            return
        }
        log.add("music \(playing ? "started" : "paused") (counted as a button press)")
        let recording = sink?.isCapturing ?? false
        if playing {
            // Oni never talks over music: put it back to sleep for the turn. If it
            // was paused before the press, it stays paused afterwards too.
            pauseMusic(recording ? "you finished talking" : "you started talking")
        } else if !recording {
            musicPausedForVoice = true
        }
        pressed(playing ? "music-start" : "music-pause")
    }

    private func routeDescription() -> String {
        let route = AVAudioSession.sharedInstance().currentRoute
        let inputs = route.inputs.map { "\($0.portType.rawValue) \"\($0.portName)\"" }.joined(separator: ", ")
        let outputs = route.outputs.map { "\($0.portType.rawValue) \"\($0.portName)\"" }.joined(separator: ", ")
        return "in: [\(inputs.isEmpty ? "none" : inputs)] out: [\(outputs.isEmpty ? "none" : outputs)]"
    }
}

/// Collects what the microphone hears while a capture is on. Each channel is
/// kept on its own and the louder one is used: averaging them would cancel to
/// silence if the earbud delivered them in opposite phase (the first on-device
/// try recorded exact silence). One lock because the tap runs on AVAudio's queue.
nonisolated final class TapSink: @unchecked Sendable {
    let sampleRate: Double
    private let lock = NSLock()
    private var left: [Float] = []
    private var right: [Float] = []
    private var capturing = false
    private var buffers = 0
    /// A little over the session's own recording limit, so memory cannot grow without bound.
    private let maxSamples: Int

    init(sampleRate: Double) {
        self.sampleRate = sampleRate
        maxSamples = Int(sampleRate * 70)
    }

    var isCapturing: Bool { lock.withLock { capturing } }

    func begin() {
        lock.withLock {
            left.removeAll(keepingCapacity: true)
            right.removeAll(keepingCapacity: true)
            buffers = 0
            capturing = true
        }
    }

    func end() -> (samples: [Float], peaks: (Float, Float), usedRight: Bool, buffers: Int) {
        lock.withLock {
            capturing = false
            let l = left.reduce(Float(0)) { max($0, abs($1)) }
            let r = right.reduce(Float(0)) { max($0, abs($1)) }
            let useRight = r > l
            return (useRight ? right : left, (l, r), useRight, buffers)
        }
    }

    func consume(_ buffer: AVAudioPCMBuffer) {
        lock.withLock {
            guard capturing, let data = buffer.floatChannelData else { return }
            let frames = Int(buffer.frameLength)
            let channels = Int(buffer.format.channelCount)
            guard channels > 0, left.count + frames <= maxSamples else { return }
            buffers += 1
            let stride = buffer.format.isInterleaved ? channels : 1
            func channel(_ index: Int) -> UnsafeBufferPointer<Float> {
                let base = buffer.format.isInterleaved ? data[0] + index : data[index]
                return UnsafeBufferPointer(start: base, count: frames * stride)
            }
            let first = channel(0)
            for frame in 0..<frames { left.append(first[frame * stride]) }
            if channels > 1 {
                let second = channel(1)
                for frame in 0..<frames { right.append(second[frame * stride]) }
            }
        }
    }
}

/// Resumes one waiting caller when playback or speech finishes, whichever thread
/// the system reports it on.
nonisolated final class PlaybackWaiter: NSObject, AVAudioPlayerDelegate, AVSpeechSynthesizerDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Never>?
    private var finished = false

    func wait() async {
        await withCheckedContinuation { continuation in
            lock.lock()
            if finished {
                lock.unlock()
                continuation.resume()
            } else {
                self.continuation = continuation
                lock.unlock()
            }
        }
    }

    func finish() {
        lock.lock()
        finished = true
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume()
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) { finish() }
    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: (any Error)?) { finish() }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { finish() }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) { finish() }
}

/// A tiny mono 16-bit WAV in memory: a tone, or silence when the frequency is 0.
/// The earbud beeps and the silent Now Playing loop.
nonisolated enum ToneMaker {
    static func wav(frequency: Double, seconds: Double, amplitude: Double = 0.4, sampleRate: Int = 22_050) -> Data {
        let count = Int(Double(sampleRate) * seconds)
        var samples = [Int16](repeating: 0, count: count)
        if frequency > 0 {
            for index in 0..<count {
                let time = Double(index) / Double(sampleRate)
                // A short fade at both ends so the beep does not click.
                let edge = min(1, Double(min(index, count - index)) / Double(sampleRate / 100))
                samples[index] = Int16(sin(2 * .pi * frequency * time) * amplitude * edge * Double(Int16.max))
            }
        }
        var data = Data()
        func append<T: FixedWidthInteger>(_ value: T) {
            withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) }
        }
        data.append(contentsOf: Array("RIFF".utf8)); append(UInt32(36 + count * 2))
        data.append(contentsOf: Array("WAVEfmt ".utf8)); append(UInt32(16))
        append(UInt16(1)); append(UInt16(1)); append(UInt32(sampleRate))
        append(UInt32(sampleRate * 2)); append(UInt16(2)); append(UInt16(16))
        data.append(contentsOf: Array("data".utf8)); append(UInt32(count * 2))
        for sample in samples { append(sample) }
        return data
    }
}
