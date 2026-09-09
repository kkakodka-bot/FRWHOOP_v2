#if os(iOS)
import SwiftUI
import StrandDesign

/// One-time iOS banner when a cold launch (not state restoration) finds a paired strap whose last
/// offload is more than 24 hours old — swiping NOOP closed stops background syncing.
struct ForceQuitSyncBanner: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var live: LiveState

    @AppStorage("noop.forceQuitSyncBannerDismissed") private var dismissed = false
    @State private var visible = false

    var body: some View {
        Group {
            if visible {
                NoopCard(padding: 14, tint: StrandPalette.statusWarning) {
                    HStack(alignment: .top, spacing: NoopMetrics.space3) {
                        Image(systemName: "arrow.triangle.2.circlepath")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(StrandPalette.statusWarning)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: NoopMetrics.space2) {
                            Text("Leave NARA in the app switcher")
                                .font(StrandFont.subhead)
                                .foregroundStyle(StrandPalette.textPrimary)
                            Text("Swiping NARA closed stops background syncing with your strap. Leave it in the app switcher so overnight sync can finish.")
                                .font(StrandFont.caption)
                                .foregroundStyle(StrandPalette.textSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                        Button {
                            dismissed = true
                            visible = false
                        } label: {
                            Image(systemName: "xmark")
                                .font(StrandFont.caption)
                                .foregroundStyle(StrandPalette.textTertiary)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(String(localized: "Dismiss"))
                    }
                }
                .padding(.horizontal, NoopMetrics.screenPadding)
                .padding(.top, NoopMetrics.space2)
            }
        }
        .onAppear { evaluate() }
    }

    private func evaluate() {
        guard !dismissed else { return }
        guard !model.ble.launchedViaStateRestoration else { return }
        guard model.deviceRegistry?.devices.contains(where: { $0.brand == "WHOOP" }) == true
                || live.connected else { return }
        guard let synced = live.lastSyncedAt else {
            visible = true
            return
        }
        let age = Date().timeIntervalSince1970 - synced
        visible = age > 24 * 60 * 60
    }
}
#endif
