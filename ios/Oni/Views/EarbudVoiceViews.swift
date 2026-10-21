import SwiftUI

/// Earbud-button voice for the Mac's Oni, as one card at the top of the Oni home.
struct EarbudVoiceCard: View {
    @Environment(EarbudVoice.self) private var earbud
    @Environment(Navigator.self) private var nav

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                ZStack {
                    Circle().fill(earbud.isArmed ? Color.accentColor.opacity(0.18) : Color(.tertiarySystemFill))
                    Image(systemName: earbud.isArmed ? "headphones.circle.fill" : "headphones")
                        .font(.system(size: 19))
                        .foregroundStyle(earbud.isArmed ? Color.accentColor : .secondary)
                }
                .frame(width: 40, height: 40)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Earbud voice").font(.subheadline).fontWeight(.semibold)
                    Text(earbud.statusLine)
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)

                if earbud.isArmed {
                    Button("Disarm") { earbud.disarm() }
                        .buttonStyle(.bordered).controlSize(.small)
                } else {
                    Button {
                        Task { await earbud.arm() }
                    } label: {
                        if earbud.isArming { ProgressView() } else { Text("Arm") }
                    }
                    .buttonStyle(.borderedProminent).controlSize(.small)
                    .disabled(earbud.isArming)
                }
            }

            if earbud.isArmed, let heard = earbud.session?.heard {
                Text("You: \(heard)").font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            if earbud.isArmed, let id = earbud.threadId {
                Button("Open the conversation") { nav.path.append(.macThread(id)) }
                    .font(.caption)
            }

            Divider()
            Toggle(isOn: Binding(get: { earbud.keepsMicOn }, set: { earbud.setKeepsMicOn($0) })) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Works with the phone locked").font(.footnote)
                    Text("Keeps the mic on: orange dot, more battery").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .strokeBorder(Color.accentColor.opacity(earbud.isArmed ? 0.5 : 0), lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
    }
}

/// What the earbud voice feature has been doing, newest first (also saved as
/// `earbud-voice.log` in the app's Documents for debugging on the device).
struct EarbudLogView: View {
    @Environment(EarbudVoice.self) private var earbud

    var body: some View {
        List {
            Section {
                Button("Clear log", role: .destructive) { earbud.log.clear() }
                ForEach(Array(earbud.log.lines.enumerated()), id: \.offset) { _, line in
                    Text(line).font(.system(.caption2, design: .monospaced))
                }
            } footer: {
                Text("Arm it from the Oni screen, put the earbuds in, lock the phone and press the earbud button. The microphone stays on while it is armed (the orange dot), and Oni owns the earbud button, so music apps will not get it.")
            }
        }
        .navigationTitle("Earbud voice log")
        .navigationBarTitleDisplayMode(.inline)
    }
}
