#if os(iOS)
import SwiftUI
import StrandDesign
import NoopPush

/// Experimental, explicit consent surface for raw one-way health-data egress to a user-controlled endpoint.
struct CloudPushView: View {
    @EnvironmentObject private var model: AppModel

    @State private var endpoint = CloudPushSettings.endpointText
    @State private var token = ""
    @State private var snapshot = CloudPushSettings.snapshot()
    @State private var validationMessage: String?
    @State private var capabilityProbe: CapabilityProbeUI = .idle
    @State private var capabilityProbeGeneration = 0

    private enum CapabilityProbeUI {
        case idle
        case testing
        case success(streams: [String], checkedAt: Date)
        case failure(PushFailure)
    }

    var body: some View {
        ScreenScaffold(
            title: "Self-hosted push",
            subtitle: "Experimental · iOS"
        ) {
            VStack(alignment: .leading, spacing: NoopMetrics.sectionSpacing) {
                destinationCard
                statusCard
            }
        }
        .task {
            while !Task.isCancelled {
                snapshot = CloudPushSettings.snapshot()
                try? await Task.sleep(for: .milliseconds(750))
            }
        }
    }

    private var destinationCard: some View {
        pushSection(
            icon: "icloud.and.arrow.up.fill",
            title: "Your endpoint",
            blurb: "When enabled, NOOP sends raw health records from this phone to an endpoint you control. That means data explicitly leaves the device."
        ) {
            VStack(alignment: .leading, spacing: NoopMetrics.space3) {
                Text("One-way export only. NOOP cannot restore from this endpoint and ships no receiver.")
                    .font(StrandFont.footnote)
                    .foregroundStyle(StrandPalette.statusWarning)
                    .fixedSize(horizontal: false, vertical: true)

                pushField(
                    label: String(localized: "Endpoint URL"),
                    text: $endpoint,
                    secret: false
                )
                .onChangeCompat(of: endpoint) { _ in
                    validationMessage = nil
                    capabilityProbe = .idle
                    capabilityProbeGeneration += 1
                }

                pushField(
                    label: snapshot.hasToken
                        ? String(localized: "Bearer token (saved; enter a new value to replace)")
                        : String(localized: "Bearer token (hidden)"),
                    text: $token,
                    secret: true
                )
                .onChangeCompat(of: token) { _ in
                    capabilityProbe = .idle
                    capabilityProbeGeneration += 1
                }

                if let validationMessage {
                    Text(validationMessage)
                        .font(StrandFont.footnote)
                        .foregroundStyle(StrandPalette.statusWarning)
                        .fixedSize(horizontal: false, vertical: true)
                }

                NoopButton("Save destination", kind: .secondary, fullWidth: true) {
                    saveDestination()
                }
                .disabled(!canSave)

                if isTestingConnection {
                    NoopButton("Testing connection…", kind: .secondary, fullWidth: true) {
                        testConnection()
                    }
                    .disabled(true)
                } else {
                    NoopButton("Test connection", kind: .secondary, fullWidth: true) {
                        testConnection()
                    }
                    .disabled(!canTestConnection)
                }

                Text("Checks authentication and supported data types. Sends no health data.")
                    .font(StrandFont.footnote)
                    .foregroundStyle(StrandPalette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                capabilitySummary

                if snapshot.hasToken {
                    NoopButton("Clear saved token", kind: .secondary, fullWidth: true) {
                        clearToken()
                    }
                }

                pushToggle(
                    title: String(localized: "Wi‑Fi only"),
                    detail: String(localized: "Connection tests and exports use unmetered Wi‑Fi only. Turn off to allow cellular and other connected networks."),
                    isOn: snapshot.wifiOnly
                ) { requested in
                    capabilityProbe = .idle
                    capabilityProbeGeneration += 1
                    CloudPushSettings.setWifiOnly(requested)
                    snapshot = CloudPushSettings.snapshot()
                    Task {
                        guard let writer = await model.repo.registryWriterForPush() else { return }
                        CloudPushScheduler.networkPolicyChanged(db: writer)
                    }
                }

                pushToggle(
                    title: String(localized: "Export waveform and raw batches"),
                    detail: String(localized: "Also upload large binary streams (PPG waveforms, 100 Hz motion, v18 auxiliary fields, and pre-decode frame batches). On by default; these objects are much larger than ordinary health records."),
                    isOn: snapshot.binaryObjectsEnabled
                ) { requested in
                    CloudPushSettings.setBinaryObjectsEnabled(requested)
                    snapshot = CloudPushSettings.snapshot()
                }

                pushToggle(
                    title: String(localized: "Enable automatic export"),
                    detail: String(localized: "After a full strap sync, export new and changed data automatically and catch up backlog on launch."),
                    isOn: snapshot.enabled
                ) { requested in
                    if !requested {
                        CloudPushSettings.setEnabled(false)
                        CloudPushScheduler.cancelScheduledWork()
                    } else if !CloudPushSettings.setEnabled(true) {
                        validationMessage = String(localized: "Save a valid endpoint and token before enabling.")
                    } else {
                        Task {
                            guard let writer = await model.repo.registryWriterForPush() else { return }
                            CloudPushScheduler.enqueueLaunchCatchUp(db: writer)
                        }
                    }
                    snapshot = CloudPushSettings.snapshot()
                }

                NoopButton("Export now", kind: .secondary, fullWidth: true) {
                    exportNow()
                }
                .disabled(!canSave || !snapshot.enabled)

                Text("Start a catch-up immediately. Automatic export must be enabled first.")
                    .font(StrandFont.footnote)
                    .foregroundStyle(StrandPalette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var statusCard: some View {
        pushSection(
            icon: "icloud.and.arrow.up.fill",
            title: "Status",
            blurb: "Credentials never appear in status or background task metadata."
        ) {
            VStack(alignment: .leading, spacing: NoopMetrics.space2 + 2) {
                if isActive {
                    ProgressView()
                        .tint(StrandPalette.accent)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                Text("Current state: \(runStateLabel(snapshot.runState))")
                    .font(StrandFont.body)
                    .foregroundStyle(StrandPalette.textPrimary)
                Text("Current export: \(snapshot.acceptedBatches) batches · \(snapshot.acceptedRecords) records accepted")
                    .font(StrandFont.footnote)
                    .foregroundStyle(StrandPalette.textSecondary)
                Text("Last full catch-up: \(formattedDate(snapshot.lastSuccessAt) ?? String(localized: "Never"))")
                    .font(StrandFont.body)
                    .foregroundStyle(StrandPalette.textPrimary)
                if let lastError = snapshot.lastError {
                    Text("Last error: \(lastError)")
                        .font(StrandFont.footnote)
                        .foregroundStyle(StrandPalette.statusWarning)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    @ViewBuilder
    private var capabilitySummary: some View {
        switch capabilityProbe {
        case .testing:
            ProgressView()
                .tint(StrandPalette.accent)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .failure(let failure):
            Text(CloudPushMessaging.pushFailureMessage(failure))
                .font(StrandFont.footnote)
                .foregroundStyle(StrandPalette.statusWarning)
                .fixedSize(horizontal: false, vertical: true)
        case .idle, .success:
            EmptyView()
        }

        if let shownStreams = displayedCapabilityStreams {
            let total = PushCapabilities.all.wireNames.count
            Text("Receiver supports \(shownStreams.count)/\(total) data types")
                .font(StrandFont.body)
                .foregroundStyle(shownStreams.isEmpty ? StrandPalette.statusWarning : StrandPalette.textPrimary)
            if let checkedAt = displayedCapabilitiesCheckedAt {
                Text("Last checked: \(formattedDate(checkedAt) ?? "")")
                    .font(StrandFont.footnote)
                    .foregroundStyle(StrandPalette.textSecondary)
            }
            Text(
                shownStreams.isEmpty
                    ? String(localized: "This receiver currently accepts no protocol 1.0 health data.")
                    : String(localized: "Accepted data: \(shownStreams.joined(separator: " · "))")
            )
            .font(StrandFont.footnote)
            .foregroundStyle(shownStreams.isEmpty ? StrandPalette.statusWarning : StrandPalette.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var savedEndpointMatchesProbe: Bool {
        token.isEmpty && validatedEndpoint?.url == snapshot.endpoint?.url
    }

    private var displayedCapabilityStreams: [String]? {
        if case .success(let streams, _) = capabilityProbe { return streams }
        return snapshot.supportedStreams.flatMap { savedEndpointMatchesProbe ? $0 : nil }
    }

    private var displayedCapabilitiesCheckedAt: Date? {
        if case .success(_, let checkedAt) = capabilityProbe { return checkedAt }
        return snapshot.capabilitiesCheckedAt.flatMap { savedEndpointMatchesProbe ? $0 : nil }
    }

    private var isTestingConnection: Bool {
        if case .testing = capabilityProbe { return true }
        return false
    }

    private var validatedEndpoint: PushValidEndpoint? {
        guard case .valid(let endpoint) = PushEndpointPolicy.validate(endpoint) else { return nil }
        return endpoint
    }

    private var endpointValid: Bool { validatedEndpoint != nil }
    private var tokenAvailable: Bool { !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || snapshot.hasToken }
    private var canSave: Bool { endpointValid && tokenAvailable }
    private var canTestConnection: Bool { endpointValid && tokenAvailable }

    private var isActive: Bool {
        switch snapshot.runState {
        case .queued, .running, .continuing, .retrying: true
        case .idle, .complete, .failed: false
        }
    }

    private func exportNow() {
        Task {
            guard persistDestinationForExport() else { return }
            guard let writer = await model.repo.registryWriterForPush() else {
                validationMessage = String(localized: "The local database is not ready yet. Try again shortly.")
                return
            }
            CloudPushScheduler.enqueueManualCatchUp(db: writer)
            snapshot = CloudPushSettings.snapshot()
        }
    }

    @discardableResult
    private func persistDestinationForExport() -> Bool {
        guard canSave else {
            validationMessage = String(localized: "Enter a valid endpoint and token before exporting.")
            return false
        }
        switch CloudPushSettings.saveEndpoint(endpoint) {
        case .invalid(let problem):
            validationMessage = CloudPushMessaging.endpointProblem(problem)
            return false
        case .valid(let valid):
            endpoint = valid.url
            if !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                CloudPushSettings.saveToken(token)
            }
            token = ""
            guard CloudPushSettings.setEnabled(true) else {
                validationMessage = String(localized: "Save a valid endpoint and token before enabling.")
                return false
            }
            snapshot = CloudPushSettings.snapshot()
            return CloudPushSettings.ready
        }
    }

    private func saveDestination() {
        switch CloudPushSettings.saveEndpoint(endpoint) {
        case .invalid(let problem):
            validationMessage = CloudPushMessaging.endpointProblem(problem)
        case .valid(let valid):
            let destinationChanged = snapshot.endpoint?.url != valid.url
            endpoint = valid.url
            if !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                CloudPushSettings.saveToken(token)
            }
            token = ""
            snapshot = CloudPushSettings.snapshot()
            if destinationChanged, snapshot.ready {
                Task {
                    guard let writer = await model.repo.registryWriterForPush() else { return }
                    CloudPushScheduler.destinationChanged(db: writer)
                }
            }
            validationMessage = String(localized: "Destination saved.")
        }
    }

    private func testConnection() {
        guard let valid = validatedEndpoint else {
            validationMessage = String(localized: "Save a valid endpoint and token before enabling.")
            return
        }
        let testToken = token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? CloudPushKeyStore.readToken()
            : token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let testToken, !testToken.isEmpty else {
            validationMessage = String(localized: "Save a valid endpoint and token before enabling.")
            return
        }
        guard CloudPushNetworkPolicy.canStartConnectionTest(
            networkAvailable: CloudPushNetworkPolicy.isNetworkAvailable(wifiOnly: snapshot.wifiOnly),
            endpointValid: true,
            tokenAvailable: true
        ) else {
            validationMessage = String(localized: "Connect to a network allowed by the Wi‑Fi only setting before testing the receiver.")
            return
        }

        let generation = capabilityProbeGeneration + 1
        capabilityProbeGeneration = generation
        let persistResult = token.isEmpty && valid.url == snapshot.endpoint?.url
        capabilityProbe = .testing
        Task {
            let result = await CloudPushConnectionTester.test(endpoint: valid, token: testToken)
            guard capabilityProbeGeneration == generation else { return }
            switch result {
            case .available(let capabilities):
                let checkedAt = Date()
                if persistResult {
                    CloudPushSettings.recordCapabilities(endpoint: valid, capabilities: capabilities, checkedAt: checkedAt)
                }
                snapshot = CloudPushSettings.snapshot()
                capabilityProbe = .success(streams: capabilities.wireNames, checkedAt: checkedAt)
            case .rejected(_, _, let failure):
                capabilityProbe = .failure(failure ?? PushFailure(code: .networkIO))
            }
        }
    }

    private func clearToken() {
        CloudPushSettings.saveToken("")
        CloudPushSettings.setEnabled(false)
        CloudPushScheduler.cancelScheduledWork()
        token = ""
        snapshot = CloudPushSettings.snapshot()
        validationMessage = String(localized: "Saved token cleared and push turned off.")
    }

    private func runStateLabel(_ state: CloudPushSettings.RunState) -> String {
        switch state {
        case .idle: String(localized: "Idle")
        case .queued: String(localized: "Queued")
        case .running: String(localized: "Sending")
        case .continuing: String(localized: "More local data found; continuing")
        case .retrying: String(localized: "Retrying after error")
        case .complete: String(localized: "Up to date")
        case .failed: String(localized: "Paused after error")
        }
    }

    private func formattedDate(_ date: Date?) -> String? {
        guard let date else { return nil }
        return DateFormatter.localizedString(from: date, dateStyle: .medium, timeStyle: .short)
    }

    private func pushSection<Content: View>(
        icon: String,
        title: LocalizedStringKey,
        blurb: LocalizedStringKey,
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        StrandCard(padding: NoopMetrics.space5) {
            VStack(alignment: .leading, spacing: NoopMetrics.space4) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Experimental").strandOverline()
                    HStack(spacing: NoopMetrics.space2 + 2) {
                        Image(systemName: icon)
                            .foregroundStyle(StrandPalette.accent)
                            .accessibilityHidden(true)
                        Text(title)
                            .font(StrandFont.title2)
                            .foregroundStyle(StrandPalette.textPrimary)
                    }
                }
                Text(blurb)
                    .font(StrandFont.subhead)
                    .foregroundStyle(StrandPalette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                content()
            }
        }
    }

    private func pushField(label: String, text: Binding<String>, secret: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).strandOverline()
            Group {
                if secret {
                    SecureField(label, text: text)
                } else {
                    TextField(label, text: text)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                }
            }
            .textFieldStyle(.plain)
            .font(StrandFont.mono(13))
            .foregroundStyle(StrandPalette.textPrimary)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(StrandPalette.surfaceInset, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(StrandPalette.hairline, lineWidth: 1)
            )
        }
    }

    private func pushToggle(
        title: String,
        detail: String,
        isOn: Bool,
        onChange: @escaping (Bool) -> Void
    ) -> some View {
        HStack(alignment: .center, spacing: NoopMetrics.space4) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(StrandFont.body)
                    .foregroundStyle(StrandPalette.textPrimary)
                Text(detail)
                    .font(StrandFont.footnote)
                    .foregroundStyle(StrandPalette.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Toggle(title, isOn: Binding(
                get: { isOn },
                set: { onChange($0) }
            ))
            .labelsHidden()
            .toggleStyle(.switch)
            .tint(StrandPalette.accent)
        }
    }
}
#endif
