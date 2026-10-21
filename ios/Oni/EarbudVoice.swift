import Foundation
import Observation
import OniCore
import UIKit

/// The on-screen and on-disk log of the earbud voice feature. The file
/// (`Documents/earbud-voice.log`) can be read off the phone with
/// `devicectl device copy from`, which is how this was debugged on the device.
@Observable @MainActor
final class EarbudLog {
    private(set) var lines: [String] = []
    private let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("earbud-voice.log")
    private static let stamp: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss.SSS"
        return formatter
    }()

    func add(_ message: String) {
        let state: String
        switch UIApplication.shared.applicationState {
        case .active: state = "fg"
        case .inactive: state = "inactive"
        case .background: state = "BG"
        @unknown default: state = "?"
        }
        let line = "\(Self.stamp.string(from: Date())) [\(state)] \(message)"
        lines.insert(line, at: 0)
        if lines.count > 300 { lines.removeLast() }
        guard let data = (line + "\n").data(using: .utf8) else { return }
        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
        } else {
            try? data.write(to: url)
        }
    }

    func clear() {
        lines = []
        try? FileManager.default.removeItem(at: url)
    }
}

/// Earbud-button voice for the Mac's Oni (PLAN.md Phase 32): arm it, put the
/// earbuds in, lock the phone, and press the earbud button to talk.
///
/// Every spoken turn goes into one Mac conversation, "Earbud voice", so the
/// transcript is there to read and any confirmation card is there to answer.
@Observable @MainActor
final class EarbudVoice {
    private(set) var isArming = false
    private(set) var problem: String?
    private(set) var session: HeadsetVoiceSession?
    private(set) var threadId: String?

    let log = EarbudLog()
    private let mac: MacController
    private let hardware: EarbudHardware
    private static let threadKey = "earbudVoiceThreadId"

    init(mac: MacController) {
        self.mac = mac
        hardware = EarbudHardware(log: log)
    }

    var isArmed: Bool { session?.isArmed == true }
    var keepsMicOn: Bool { hardware.keepsMicOn }
    func setKeepsMicOn(_ on: Bool) { hardware.setKeepsMicOn(on) }

    /// One line for the bar at the top of the Oni tab.
    var statusLine: String {
        if isArming { return "Getting ready…" }
        if let problem { return problem }
        guard let session, session.isArmed else { return "Off" }
        if let notice = session.notice, session.phase == .idle { return notice }
        switch session.phase {
        case .off, .idle:
            if hardware.mode == .music {
                return "Music mode: press the earbud button to talk. Your music pauses while you do and comes back after."
            }
            return hardware.keepsMicOn ? "Ready, even locked. Press the earbud button and talk."
                                       : "Ready. Keep Oni open, press the earbud button and talk."
        case .recording: return "Listening… press again when you're done."
        case .transcribing: return "Got it…"
        case .thinking: return "Oni is working… press to cancel."
        case .speaking: return "Speaking… press to interrupt."
        }
    }

    func arm() async {
        guard !isArming, !isArmed else { return }
        isArming = true
        problem = nil
        defer { isArming = false }
        guard let server = mac.server else {
            problem = "Pair with your Mac first (Settings)."
            return
        }
        do {
            let id = try await voiceThread(server)
            guard let chat = mac.session(id) else { throw EarbudError("Can't reach your Mac.") }
            await chat.open()
            try await hardware.arm()
            hardware.onButton = { [weak self] in self?.session?.press() }
            hardware.onLost = { [weak self] message in
                self?.problem = message
                self?.disarm()
            }
            let voice = HeadsetVoiceSession(server: server, chat: chat, recorder: hardware, output: hardware)
            voice.onEvent = { [weak self] line in self?.log.add(line) }
            voice.onIdle = { [weak self] in self?.hardware.voiceTurnEnded() }
            voice.arm()
            session = voice
            threadId = id
        } catch let error as MacServerError {
            problem = error.description
        } catch let error as EarbudError {
            problem = error.description
        } catch {
            problem = error.localizedDescription
        }
        if let problem { log.add("arm failed: \(problem)") }
    }

    func disarm() {
        session?.disarm()
        hardware.disarm()
        session = nil
    }

    /// The Mac conversation voice turns go into: the one used before if it still
    /// exists, otherwise a new one named "Earbud voice".
    private func voiceThread(_ server: HTTPMacServer) async throws -> String {
        let known = try await server.threads().threads
        if let saved = UserDefaults.standard.string(forKey: Self.threadKey), known.contains(where: { $0.id == saved }) {
            return saved
        }
        let made = try await server.createThread(title: "Earbud voice")
        UserDefaults.standard.set(made.id, forKey: Self.threadKey)
        await mac.refresh()
        return made.id
    }
}
