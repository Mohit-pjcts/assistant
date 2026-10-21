import SwiftUI

/// Oni's mark (`Assets.xcassets/OniMark.imageset/oni-mark.svg`, the same drawing
/// as the Mac app's header), tinted by the surrounding foreground style.
struct OniMark: View {
    var size: CGFloat = 22

    var body: some View {
        Image("OniMark")
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// The title shown at the top of the Oni home screen: the mark and the name.
struct OniTitle: View {
    var body: some View {
        HStack(spacing: 7) {
            OniMark(size: 22).foregroundStyle(Color.accentColor)
            Text("Oni").font(.headline)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// Where the menu goes, in the order it is listed (the Mac app's own rail has
/// the same destinations).
enum AppSection: String, CaseIterable, Identifiable {
    case oni, calendar, board, memory, vault, search, settings

    var id: String { rawValue }

    var title: String {
        switch self {
        case .oni: "Oni"
        case .calendar: "Calendar"
        case .board: "Board"
        case .memory: "Memory"
        case .vault: "Vault"
        case .search: "Search"
        case .settings: "Settings"
        }
    }

    var icon: String {
        switch self {
        case .oni: "sparkles"
        case .calendar: "calendar"
        case .board: "rectangle.3.group"
        case .memory: "brain"
        case .vault: "books.vertical"
        case .search: "magnifyingglass"
        case .settings: "gearshape"
        }
    }
}

@Observable @MainActor
final class AppMenu {
    var selection: AppSection = .oni
    var isOpen = false

    func choose(_ section: AppSection) {
        selection = section
        isOpen = false
    }
}

/// The three-line button at the top left of every screen's root.
struct MenuButton: View {
    @Environment(AppMenu.self) private var menu
    @Environment(ChatController.self) private var chat
    @Environment(MacController.self) private var mac

    var body: some View {
        Button {
            menu.isOpen = true
        } label: {
            Image(systemName: "line.3.horizontal")
                // A turn running is never invisible, even from another screen.
                .overlay(alignment: .topTrailing) {
                    if chat.isRunning || mac.anyBusy {
                        Circle().fill(Color.accentColor).frame(width: 8, height: 8).offset(x: 5, y: -4)
                    }
                }
        }
        .accessibilityLabel("Menu")
    }
}

/// The slide-in menu: Oni's destinations, with Settings pinned at the bottom.
struct MenuDrawer: View {
    @Environment(AppMenu.self) private var menu
    @Environment(AppModel.self) private var model
    @Environment(ChatController.self) private var chat
    @Environment(MacController.self) private var mac

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                OniMark(size: 34).foregroundStyle(Color.accentColor)
                Text("Oni").font(.title).fontWeight(.semibold)
                Spacer()
            }
            .padding(.horizontal, 22).padding(.top, 28).padding(.bottom, 18)

            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach([AppSection.oni, .calendar, .board, .memory]) { row($0) }
                    Divider().padding(.vertical, 10).padding(.horizontal, 12)
                    ForEach([AppSection.vault, .search]) { row($0) }
                }
                .padding(.horizontal, 10)
            }

            Divider().padding(.horizontal, 22)
            row(.settings)
                .padding(.horizontal, 10).padding(.vertical, 8)
        }
        .frame(width: 292)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Color(.systemBackground).ignoresSafeArea())
        .overlay(alignment: .trailing) { Divider().ignoresSafeArea() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Menu")
        .gesture(DragGesture().onEnded { if $0.translation.width < -50 { menu.isOpen = false } })
    }

    private func row(_ section: AppSection) -> some View {
        let selected = menu.selection == section
        return Button {
            menu.choose(section)
        } label: {
            HStack(spacing: 14) {
                Image(systemName: section.icon)
                    .font(.system(size: 18))
                    .frame(width: 26)
                    .foregroundStyle(selected ? Color.accentColor : .secondary)
                Text(section.title).font(.body).fontWeight(selected ? .semibold : .regular)
                Spacer()
                badge(for: section)
            }
            .padding(.horizontal, 14).padding(.vertical, 12)
            .background(selected ? Color.accentColor.opacity(0.14) : .clear, in: RoundedRectangle(cornerRadius: 12))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    @ViewBuilder private func badge(for section: AppSection) -> some View {
        switch section {
        case .oni where chat.isRunning || mac.anyBusy:
            Circle().fill(Color.accentColor).frame(width: 8, height: 8)
        case .memory:
            if let count = mac.review?.pending.count, count > 0 { count_badge(count, tint: Color.accentColor) }
        case .settings:
            if !model.conflicts.isEmpty { count_badge(model.conflicts.count, tint: .orange) }
        default:
            EmptyView()
        }
    }

    private func count_badge(_ count: Int, tint: Color) -> some View {
        Text("\(count)").font(.caption).fontWeight(.semibold)
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(tint, in: Capsule()).foregroundStyle(.white)
    }
}
