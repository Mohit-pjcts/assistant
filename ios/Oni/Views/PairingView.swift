import OniCore
import SwiftUI

/// First launch: the Mac's Tailscale address and the Vault token
/// (`python -m assistant.vault_sync` prints it on the Mac).
struct PairingView: View {
    @Environment(AppModel.self) private var model
    @State private var address = ""
    @State private var token = ""
    @State private var working = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: 10) {
                        OniMark(size: 56).foregroundStyle(Color.accentColor)
                        Text("Oni").font(.largeTitle).fontWeight(.semibold)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                }
                .listRowBackground(Color.clear)
                Section {
                    TextField("my-mac.tailnet.ts.net", text: $address)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                    SecureField("Vault token", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Your Mac")
                } footer: {
                    Text("""
                    On the Mac, run `tailscale serve --bg 8000` once, then \
                    `python -m assistant.vault_sync` to print the token. \
                    Tailscale must be on for this iPhone.
                    """)
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
                Section {
                    Button {
                        Task { await connect() }
                    } label: {
                        HStack {
                            Text("Connect")
                            if working { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(working || address.isEmpty || token.isEmpty)
                }
            }
            .navigationTitle("Connect to Oni")
        }
    }

    private func connect() async {
        working = true
        error = nil
        defer { working = false }
        do {
            _ = try await model.pair(address: address, token: token)
        } catch {
            self.error = switch error {
            case VaultServerError.unauthorized: "The Mac rejected that token."
            default: AppModel.describe(error)
            }
        }
    }
}
