import SwiftUI
import StrandDesign

/// Test Centre / developer controls for server HRV/sleep readback (Phase 4).
struct ServerScoringView: View {
    @EnvironmentObject private var model: AppModel
    @State private var enabled = ServerScoringSettings.isEnabled
    @State private var email = ServerScoringSettings.authEmail
    @State private var password = ""
    @State private var working = false

    var body: some View {
        ScreenScaffold(
            title: "Server scoring",
            subtitle: "Read cached server HRV and sleep"
        ) {
            VStack(alignment: .leading, spacing: NoopMetrics.sectionSpacing) {
                settingsCard
                authCard
                statusCard
            }
        }
    }

    private var settingsCard: some View {
        pushSection(
            icon: "server.rack",
            title: "Display",
            blurb: "When on, Today and Sleep show server-computed HRV and sleep totals. Live HR and graphs stay on-device."
        ) {
            pushToggle(
                title: String(localized: "Use server scores"),
                detail: String(localized: "Default off. Requires a Supabase account on your VPS."),
                isOn: enabled
            ) { requested in
                ServerScoringSettings.setEnabled(requested)
                enabled = requested
                if requested {
                    Task { await model.serverScores.refreshVisibleDays(todayKey: model.repo.today?.day) }
                    if let day = model.repo.today?.day {
                        model.serverScores.startPolling(todayKey: day)
                    }
                } else {
                    model.serverScores.stopPolling()
                }
            }
        }
    }

    private var authCard: some View {
        pushSection(
            icon: "person.badge.key.fill",
            title: "Sign in",
            blurb: "Uses your Supabase JWT — not the push ingest token."
        ) {
            VStack(alignment: .leading, spacing: NoopMetrics.space3) {
                TextField("Email", text: $email)
                    #if os(iOS)
                    .textContentType(.emailAddress)
                    .autocapitalization(.none)
                    .disableAutocorrection(true)
                    #endif
                SecureField("Password", text: $password)
                HStack(spacing: NoopMetrics.space3) {
                    NoopButton(working ? "Signing in…" : "Sign in", kind: .secondary, fullWidth: true) {
                        signIn()
                    }
                    .disabled(working || email.isEmpty || password.isEmpty)
                    if model.serverScores.signedIn {
                        NoopButton("Sign out", kind: .tertiary, fullWidth: true) {
                            model.serverScores.signOut()
                            password = ""
                        }
                    }
                }
            }
        }
    }

    private var statusCard: some View {
        pushSection(
            icon: "clock.arrow.circlepath",
            title: "Status",
            blurb: "Polls get_day_snapshot every \(ServerScoringSettings.pollIntervalSeconds)s; shows last-known values when stale."
        ) {
            VStack(alignment: .leading, spacing: NoopMetrics.space2) {
                row("Signed in", model.serverScores.signedIn ? "Yes" : "No")
                if let at = model.serverScores.lastFetchedAt {
                    row("Last fetch", at.formatted(date: .abbreviated, time: .shortened))
                }
                if let err = model.serverScores.lastError {
                    Text(err)
                        .font(StrandFont.footnote)
                        .foregroundStyle(StrandPalette.statusWarning)
                }
            }
        }
    }

    private func signIn() {
        working = true
        Task {
            await model.serverScores.signIn(email: email, password: password)
            password = ""
            working = false
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).font(StrandFont.footnote).foregroundStyle(StrandPalette.textSecondary)
            Spacer()
            Text(value).font(StrandFont.footnote).foregroundStyle(StrandPalette.textPrimary)
        }
    }

    @ViewBuilder
    private func pushSection<Content: View>(
        icon: String,
        title: String,
        blurb: String,
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        StrandCard(padding: NoopMetrics.space5) {
            VStack(alignment: .leading, spacing: NoopMetrics.space4) {
                HStack(spacing: NoopMetrics.space2 + 2) {
                    Image(systemName: icon).foregroundStyle(StrandPalette.accent)
                    Text(title).font(StrandFont.title2).foregroundStyle(StrandPalette.textPrimary)
                }
                Text(blurb)
                    .font(StrandFont.subhead)
                    .foregroundStyle(StrandPalette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                content()
            }
        }
    }

    @ViewBuilder
    private func pushToggle(
        title: String,
        detail: String,
        isOn: Bool,
        onChange: @escaping (Bool) -> Void
    ) -> some View {
        Toggle(isOn: Binding(get: { isOn }, set: onChange)) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(StrandFont.body).foregroundStyle(StrandPalette.textPrimary)
                Text(detail).font(StrandFont.footnote).foregroundStyle(StrandPalette.textSecondary)
            }
        }
        .tint(StrandPalette.accent)
    }
}
