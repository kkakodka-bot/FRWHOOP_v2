import Foundation
import Combine
import NoopPush
import WhoopStore

@MainActor
final class ServerScoreRepository: ObservableObject {
    /// Root posts this after validated receipts/result invalidation; no payload is needed.
    static let refreshRequested = Notification.Name("noop.serverScores.refreshRequested")
    @Published private(set) var state = ServerScoreViewState.empty
    @Published private(set) var lastError: String?
    @Published private(set) var lastFetchedAt: Date?
    @Published private(set) var signedIn = false
    @Published private(set) var signOutNeedsRetry = false

    typealias Fetch = @Sendable (String, AccountSessionContext) async throws -> ServerScoreResponse
    private let fetchSnapshot: Fetch
    private let now: () -> Date
    private var context: AccountSessionContext?
    private var cache: ServerScoreSnapshotCache?
    private var epoch = UUID()
    private var timeZone = TimeZone.current
    private var explicitTimeZone = false
    private var foreground = true
    private var retired = false
    private var selectedDay: String?
    private var pollTask: Task<Void, Never>?
    private var hydrationTask: Task<Void, Never>?
    private var requests: [String: (id: UUID, task: Task<Void, Never>)] = [:]
    private var subscriptions: Set<AnyCancellable> = []

    init(fetch: @escaping Fetch = { try await ServerScoreClient.fetchDaySnapshot(day: $0, context: $1) },
         now: @escaping () -> Date = { Date() }) {
        fetchSnapshot = fetch
        self.now = now
        synchronizeIdentity()
        restoreSignOutFailure()
        NotificationCenter.default.publisher(for: CloudAuthClient.identityDidChange)
            .receive(on: DispatchQueue.main).sink { [weak self] _ in
                guard let self, !self.retired else { return }
                self.synchronizeIdentity()
                self.restoreSignOutFailure()
                self.hydrateAndRefresh()
                self.startPolling(todayKey: self.currentDay)
            }.store(in: &subscriptions)
        for name in [Self.refreshRequested, .NSCalendarDayChanged, .NSSystemTimeZoneDidChange,
                     ServerScoringSettings.settingsDidChange] {
            NotificationCenter.default.publisher(for: name).receive(on: DispatchQueue.main)
                .sink { [weak self] note in
                    guard let self, !self.retired else { return }
                    if note.name == .NSSystemTimeZoneDidChange, !self.explicitTimeZone { self.setTimeZone(.current) }
                    self.publish(days: self.state.days)
                    if self.foreground { Task { [weak self] in await self?.refreshVisibleDays() } }
                }.store(in: &subscriptions)
        }
    }

    var currentDay: String { ServerScoreDate.day(now(), timeZone: timeZone) }

    func wire(store: WhoopStore) {
        guard !retired else { return }
        epoch = UUID()
        cache = ServerScoreSnapshotCache(db: store.registryWriter)
        synchronizeIdentity()
        hydrateAndRefresh()
    }

    func configure(timeZone: TimeZone) {
        explicitTimeZone = true
        setTimeZone(timeZone)
    }

    private func setTimeZone(_ zone: TimeZone) {
        guard zone.identifier != timeZone.identifier else { return }
        timeZone = zone
        epoch = UUID()
        cancelRequests()
        selectedDay = nil
        publish(days: [:])
        hydrateAndRefresh()
    }

    func setForeground(_ active: Bool) {
        guard !retired else { return }
        foreground = active
        if active {
            synchronizeIdentity()
            hydrateAndRefresh()
            startPolling(todayKey: currentDay)
        } else {
            stopPolling()
            hydrationTask?.cancel()
            cancelRequests()
        }
    }

    /// Discards this runtime without signing out a replacement account runtime.
    func invalidate() {
        retired = true
        foreground = false
        epoch = UUID()
        stopPolling()
        hydrationTask?.cancel()
        cancelRequests()
        subscriptions.removeAll()
        context = nil
        signedIn = false
        lastFetchedAt = nil
        lastError = nil
        state = .empty
        if let cache { Task { await cache.activate(nil) } }
    }

    func signIn(email: String, password: String) async {
        do {
            _ = try await CloudAuthClient.signIn(email: email, password: password)
            guard !retired else { return }
            synchronizeIdentity()
            lastError = nil
            await hydrate()
            await refreshVisibleDays()
            startPolling(todayKey: currentDay)
        } catch {
            guard !retired else { return }
            synchronizeIdentity()
            lastError = "Sign-in failed"
        }
    }

    func signOut() {
        do {
            try CloudAuthClient.clearSessionChecked()
            synchronizeIdentity()
            signOutNeedsRetry = false
            lastError = nil
        } catch {
            synchronizeIdentity()
            signOutNeedsRetry = true
            lastError = "Sign-out could not be saved. Access is stopped for this session; retry before closing the app."
        }
    }

    private func restoreSignOutFailure() {
        // The identity notification can replace this repository before the caller catches.
        if context == nil, CloudAuthClient.lastPersistenceError == .credentialUnavailable {
            signOutNeedsRetry = true
            lastError = "Credential storage is unavailable. Retry sign-out before closing the app."
        }
    }

    func setActivated(_ metrics: Set<ServerScoreMetric>, enabled: Bool) {
        synchronizeIdentity()
        guard let context, CloudAuthClient.isCurrent(context), state.configured else { return }
        var activated = state.activated
        if enabled { activated.formUnion(metrics.intersection(state.capabilities)) }
        else { activated.subtract(metrics) }
        ServerScoringSettings.setActivated(activated, scope: context.scope)
        publish(days: state.days)
        if foreground { Task { [weak self] in await self?.refreshVisibleDays() } }
    }

    func startPolling(todayKey: String) {
        guard !retired, foreground else { return }
        synchronizeIdentity()
        guard state.configured, signedIn else { return }
        // The compatibility argument is not captured: each iteration recalculates today.
        stopPolling()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.foreground, !self.retired else { return }
                await self.refreshVisibleDays()
                do { try await Task.sleep(for: .seconds(ServerScoringSettings.pollIntervalSeconds)) }
                catch { return }
            }
        }
    }

    func stopPolling() { pollTask?.cancel(); pollTask = nil }

    func refreshVisibleDays(todayKey: String? = nil) async {
        guard !retired, foreground else { return }
        synchronizeIdentity()
        publish(days: state.days)
        guard signedIn, state.configured else { return }
        if let day = todayKey, ServerScoreDate.isDay(day) { selectedDay = day }
        let current = currentDay
        await fetch(day: current)
        if let selectedDay, selectedDay != current, !Task.isCancelled { await fetch(day: selectedDay) }
    }

    func refreshRecentDays(limit: Int = 14) async {
        await refreshVisibleDays()
        for offset in 1..<max(1, min(limit, 14)) {
            guard foreground, !retired, !Task.isCancelled else { return }
            await fetch(day: ServerScoreDate.offsetDay(currentDay, by: -offset, timeZone: timeZone))
        }
    }

    /// Kept for older non-product call sites. Views must use state to distinguish null from local ownership.
    func overlay(for day: String) -> ServerScoreDayCache? {
        guard state.hasServerOwnership, let snapshot = state.days[day]?.snapshot else { return nil }
        return ServerScoreDayCache(day: day, algorithmVersion: snapshot.algorithmVersion,
            daily: snapshot.daily.map {
                ServerScoreDailyCache(hrvRmssdMs: $0[.hrv], restingHrBpm: $0[.restingHR].map { Int($0.rounded()) },
                    sleepTotalMin: $0[.sleepTotal], sleepInBedMin: $0[.sleepInBed], sleepAwakeMin: $0[.sleepAwake],
                    sleepLightMin: $0[.sleepLight], sleepDeepMin: $0[.sleepDeep], sleepRemMin: $0[.sleepREM],
                    sleepEfficiency: $0[.sleepEfficiency], respRateBpm: $0[.respiration], computedAt: snapshot.computedAt)
            }, nights: [], computedAt: snapshot.computedAt,
            stale: state.days[day]?.pending == true || state.days[day]?.cached == true,
            fetchedAt: state.days[day]?.fetchedAt ?? now())
    }

    private var cacheSession: ServerScoreCacheSession? {
        context.map { ServerScoreCacheSession(owner: ServerScoreCacheOwner(projectURL: $0.scope.projectURL, userID: $0.scope.userID),
                                              generation: $0.generation) }
    }

    private func synchronizeIdentity() {
        let next = CloudAuthClient.currentContext()
        guard next != context else { return }
        epoch = UUID()
        stopPolling()
        hydrationTask?.cancel()
        cancelRequests()
        context = next
        signedIn = next != nil
        selectedDay = nil
        lastFetchedAt = nil
        lastError = nil
        publish(days: [:], capabilities: next.map { ServerScoringSettings.knownCapabilities(scope: $0.scope) } ?? [])
    }

    private func isCurrent(_ expected: AccountSessionContext, epoch token: UUID) -> Bool {
        !retired && context == expected && epoch == token && CloudAuthClient.isCurrent(expected)
    }

    private func cancelRequests() {
        for entry in requests.values { entry.task.cancel() }
        requests.removeAll()
    }

    private func hydrateAndRefresh() {
        guard !retired else { return }
        hydrationTask?.cancel()
        hydrationTask = Task { [weak self] in
            guard let self else { return }
            await self.hydrate()
            guard !Task.isCancelled else { return }
            await self.refreshVisibleDays()
        }
    }

    private func hydrate() async {
        guard let cache, let session = cacheSession, let expected = context else { return }
        let token = epoch
        let interval = SyncPipelineTrace.begin(.cacheLoad)
        var outcome: SyncPipelineTrace.Outcome = .failed
        defer { SyncPipelineTrace.end(interval, outcome: outcome) }
        do {
            await cache.activate(session)
            guard isCurrent(expected, epoch: token), !Task.isCancelled else { outcome = .cancelled; return }
            let rows = try await cache.loadRecent(session: session, timeZoneID: timeZone.identifier)
            var days = state.days
            var capabilities = state.capabilities
            for row in rows {
                let snapshot = try await ServerScoreDecodeWorker.shared.restore(row)
                guard isCurrent(expected, epoch: token), !Task.isCancelled else { outcome = .cancelled; return }
                if let current = state.days[snapshot.day], current.snapshot != nil, !current.cached { continue }
                capabilities.formUnion(snapshot.supported)
                days[snapshot.day] = ServerScoreDayState(snapshot: snapshot, phase: phase(snapshot.status), fetchedAt: row.fetchedAt,
                    cached: true, pending: false, requestedInputRevision: nil, archiveStatus: nil)
            }
            guard isCurrent(expected, epoch: token), !Task.isCancelled else { outcome = .cancelled; return }
            // Fetches may have completed while the actor decoded the cached rows.
            for (day, entry) in state.days {
                if entry.snapshot != nil, !entry.cached { days[day] = entry }
            }
            publish(days: days, capabilities: capabilities.union(state.capabilities))
            outcome = rows.isEmpty ? .pending : .succeeded
        } catch {
            if !isCurrent(expected, epoch: token) || Task.isCancelled { outcome = .cancelled; return }
            lastError = "Cached server scores unavailable"
        }
    }

    private func fetch(day: String) async {
        guard !retired, foreground, let expected = context, state.configured else { return }
        if let existing = requests[day] { await existing.task.value; return }
        let id = UUID()
        let token = epoch
        let work = Task<Void, Never> { [weak self] in
            await self?.performFetch(day: day, expected: expected, token: token)
        }
        requests[day] = (id, work)
        await withTaskCancellationHandler { await work.value } onCancel: { work.cancel() }
        if requests[day]?.id == id { requests.removeValue(forKey: day) }
    }

    private func performFetch(day: String, expected: AccountSessionContext, token: UUID) async {
        let interval = SyncPipelineTrace.begin(.scoreRefresh)
        var outcome: SyncPipelineTrace.Outcome = .failed
        defer { SyncPipelineTrace.end(interval, outcome: outcome) }
        setDay(day, (state.days[day] ?? .empty(.loading)).retaining(.loading))
        do {
            let response = try await fetchSnapshot(day, expected)
            try Task.checkCancellation()
            guard isCurrent(expected, epoch: token) else { outcome = .cancelled; return }
            if let user = response.userId, user.lowercased() != expected.scope.userID.lowercased() { throw ServerScoreDecodeError.invalid }
            if let zone = response.timezone, zone != timeZone.identifier {
                setDay(day, (state.days[day] ?? .empty(.timezoneMismatch)).retaining(.timezoneMismatch))
                return
            }
            if let snapshot = response.snapshot {
                if let previous = state.days[day]?.snapshot,
                   previous.sourceDeviceId == snapshot.sourceDeviceId, previous.algorithmVersion == snapshot.algorithmVersion,
                   previous.resultRevision == snapshot.resultRevision, previous != snapshot {
                    throw ServerScoreSnapshotCacheError.revisionConflict
                }
                if let previous = state.days[day]?.snapshot,
                   previous.sourceDeviceId == snapshot.sourceDeviceId, previous.algorithmVersion == snapshot.algorithmVersion,
                   (snapshot.resultRevision < previous.resultRevision || snapshot.inputRevision < previous.inputRevision) {
                    setDay(day, state.days[day]!.retaining(.pending)); outcome = .stale; return
                }
                if let cache, let session = cacheSession {
                    let row = try await ServerScoreDecodeWorker.shared.prepare(snapshot, owner: session.owner, now: now())
                    guard isCurrent(expected, epoch: token), !Task.isCancelled else { outcome = .cancelled; return }
                    await cache.activate(session)
                    guard isCurrent(expected, epoch: token), !Task.isCancelled else { outcome = .cancelled; return }
                    let result = try await cache.store(row, session: session)
                    guard isCurrent(expected, epoch: token), !Task.isCancelled else { outcome = .cancelled; return }
                    if result == .ignoredOlderRevision { outcome = .stale; return }
                }
                let capabilities = state.capabilities.union(snapshot.supported)
                ServerScoringSettings.setKnownCapabilities(capabilities, scope: expected.scope)
                let entry = ServerScoreDayState(snapshot: snapshot, phase: phase(snapshot.status), fetchedAt: now(),
                    cached: false, pending: response.pending, requestedInputRevision: response.requestedInputRevision,
                    archiveStatus: response.archiveStatus)
                var days = state.days
                days[day] = entry
                publish(days: days, capabilities: capabilities)
                lastFetchedAt = entry.fetchedAt
                lastError = nil
                outcome = response.pending ? .waitingForServer : .succeeded
            } else {
                setDay(day, ServerScoreDayState(snapshot: state.days[day]?.snapshot, phase: phase(response.status),
                    fetchedAt: state.days[day]?.fetchedAt, cached: state.days[day]?.snapshot != nil,
                    pending: response.pending, requestedInputRevision: response.requestedInputRevision, archiveStatus: response.archiveStatus))
                if response.status == "pending" || response.status == "failed" {
                    let capabilities = state.capabilities.union(ServerScoreMetric.schema2)
                    ServerScoringSettings.setKnownCapabilities(capabilities, scope: expected.scope)
                    publish(days: state.days, capabilities: capabilities)
                }
                outcome = response.status == "pending" ? .waitingForServer : .failed
            }
        } catch {
            guard isCurrent(expected, epoch: token) else { outcome = .cancelled; return }
            if Task.isCancelled || error is CancellationError { outcome = .cancelled; return }
            let status: ServerScoreDayState.Phase
            if case ServerScoreDecodeError.unsupportedSchema = error { status = .unsupported }
            else if case ServerScoreClient.FetchError.unauthorized = error { status = .authenticationRequired; outcome = .authenticationRequired }
            else if (error as? URLError)?.code == .notConnectedToInternet { status = .offline; outcome = .offline }
            else { status = .failed }
            setDay(day, (state.days[day] ?? .empty(status)).retaining(status))
            lastError = state.days[day]?.note
        }
    }

    private func phase(_ value: String) -> ServerScoreDayState.Phase {
        switch value {
        case "available": return .available
        case "partial": return .partial
        case "no_data": return .noData
        case "pending": return .pending
        case "unsupported": return .unsupported
        default: return .failed
        }
    }

    private func setDay(_ day: String, _ entry: ServerScoreDayState) {
        var days = state.days
        days[day] = entry
        publish(days: days)
    }

    private func publish(days input: [String: ServerScoreDayState], capabilities: Set<ServerScoreMetric>? = nil) {
        let interval = SyncPipelineTrace.begin(.snapshotPublication)
        defer { SyncPipelineTrace.end(interval, outcome: .succeeded) }
        var days = input
        let keep = Set([currentDay, selectedDay].compactMap { $0 })
        for key in days.keys.sorted() where days.count > 14 && !keep.contains(key) { days.removeValue(forKey: key) }
        let authenticated = context.map(CloudAuthClient.isCurrent) ?? false
        signedIn = authenticated
        state = ServerScoreViewState(generation: context?.generation, revision: state.revision &+ 1,
            currentDay: currentDay, timezone: timeZone.identifier,
            configured: ServerScoringSettings.isEnabled && ServerScoringSettings.anonKey() != nil && context != nil,
            authenticated: authenticated, capabilities: capabilities ?? state.capabilities,
            activated: context.map { ServerScoringSettings.activatedMetrics(scope: $0.scope) } ?? [], days: days)
    }
}
