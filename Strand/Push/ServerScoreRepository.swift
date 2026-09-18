import Foundation
import Combine
import WhoopStore

/// Polls `get_day_snapshot`, persists last-known server scores, and serves overlays to the UI.
@MainActor
final class ServerScoreRepository: ObservableObject {
    @Published private(set) var lastError: String?
    @Published private(set) var lastFetchedAt: Date?
    @Published private(set) var signedIn: Bool = CloudAuthClient.storedSession() != nil
    @Published private(set) var sleepEditMessage: String?

    private var pollTask: Task<Void, Never>?
    private var cacheStore: ServerScoreCacheStore?
    private var session = ServerScoreSessionState()
    private var visibleDays = Set<String>()
    private var pollingDay: String?
    private var currentOwnerId: String? { CloudAuthClient.storedSession()?.userId.lowercased() }

    func wire(store: WhoopStore) {
        cacheStore = ServerScoreCacheStore(db: store.registryWriter)
        session.activate(ownerId: currentOwnerId)
        signedIn = currentOwnerId != nil
        preloadFromDisk()
    }

    func signIn(email: String, password: String) async {
        stopPolling()
        CloudAuthClient.clearSession()
        session.activate(ownerId: nil)
        signedIn = false
        lastFetchedAt = nil
        sleepEditMessage = nil
        let attempt = session.generation
        do {
            _ = try await CloudAuthClient.signIn(email: email, password: password)
            guard attempt == session.generation else { return }
            session.activate(ownerId: currentOwnerId)
            signedIn = true
            lastError = nil
            preloadFromDisk()
            await refreshVisibleDays()
            startPolling(todayKey: pollingDay ?? Repository.dayString(Date()))
        } catch {
            guard attempt == session.generation else { return }
            signedIn = false
            lastError = "Sign-in failed"
        }
    }

    func signOut() {
        CloudAuthClient.clearSession()
        signedIn = false
        stopPolling()
        session.activate(ownerId: nil)
        lastFetchedAt = nil
        lastError = nil
        sleepEditMessage = nil
    }

    func overlay(for day: String) -> ServerScoreDayCache? {
        guard ServerScoringSettings.isEnabled else { return nil }
        synchronizeOwner()
        visibleDays.insert(day)
        return session.overlay(day: day, currentOwnerId: currentOwnerId)
    }

    func startPolling(todayKey: String) {
        pollingDay = todayKey
        guard ServerScoringSettings.ready, signedIn else { return }
        stopPolling()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.fetch(day: todayKey)
                try? await Task.sleep(for: .seconds(ServerScoringSettings.pollIntervalSeconds))
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    /// Writes only the authenticated server override, never a local sleep row or local score.
    func saveSleepOverride(_ target: ServerSleepEditTarget, start: Int, end: Int, tombstone: Bool) async -> Bool {
        synchronizeOwner()
        guard ServerScoringSettings.ready, target.ownerId == session.ownerId,
              let cache = session.overlay(day: target.day, currentOwnerId: currentOwnerId),
              cache.features["sleep"]?.deviceId == target.deviceId,
              cache.features["sleep"]?.supportsBoundaryOverrides == true else {
            lastError = "The account or sleep source changed. Refresh before editing."
            return false
        }
        let generation = session.generation, key = "override:\(target.id)"
        let request = session.beginRequest(day: key)
        lastError = nil
        do {
            _ = try await ServerScoreClient.saveSleepOverride(target, start: start, end: end, tombstone: tombstone)
            guard !Task.isCancelled, session.isCurrentRequest(day: key, generation: generation, currentOwnerId: currentOwnerId, request: request) else { return false }
            sleepEditMessage = tombstone ? "Sleep deleted. Server recomputation queued." : "Sleep boundaries saved. Server recomputation queued."
            await fetch(day: target.day)
            return generation == session.generation && currentOwnerId == target.ownerId
        } catch {
            synchronizeOwner()
            guard !Task.isCancelled, session.isCurrentRequest(day: key, generation: generation, currentOwnerId: currentOwnerId, request: request) else { return false }
            if case ServerScoreClient.FetchError.unauthorized(let token) = error,
               CloudAuthClient.clearSession(ifAccessToken: token, ownerId: target.ownerId) {
                synchronizeOwner()
                lastError = "Session expired — sign in again"
            } else if case ServerScoreClient.FetchError.conflict = error {
                await fetch(day: target.day)
                guard generation == session.generation, currentOwnerId == target.ownerId else { return false }
                lastError = "This sleep was changed elsewhere. Close the editor and reopen it to use the latest revision."
            } else {
                lastError = "Sleep changes were not confirmed. Refresh before retrying; local sleep records were not changed."
            }
            return false
        }
    }

    func refreshVisibleDays(todayKey: String? = nil) async {
        guard ServerScoringSettings.ready, signedIn else { return }
        if let todayKey {
            visibleDays.insert(todayKey)
        }
        if visibleDays.isEmpty { visibleDays.insert(pollingDay ?? Repository.dayString(Date())) }
        for day in visibleDays.sorted() { await fetch(day: day) }
    }

    private func fetch(day: String) async {
        synchronizeOwner()
        guard let owner = session.ownerId else { return }
        let generation = session.generation
        let request = session.beginRequest(day: day)
        do {
            let cache = try await ServerScoreClient.fetchDaySnapshot(day: day, ownerId: owner)
            guard !Task.isCancelled, session.accept(cache, generation: generation, currentOwnerId: currentOwnerId, request: request) else { return }
            try cacheStore?.upsert(cache)
            lastFetchedAt = cache.fetchedAt
            lastError = nil
        } catch ServerScoreClient.FetchError.unauthorized(let token) {
            guard !Task.isCancelled, session.isCurrentRequest(day: day, generation: generation, currentOwnerId: currentOwnerId, request: request),
                  CloudAuthClient.clearSession(ifAccessToken: token, ownerId: owner) else { return }
            signedIn = false
            session.activate(ownerId: nil)
            lastError = "Session expired — sign in again"
        } catch {
            synchronizeOwner()
            guard !Task.isCancelled, session.isCurrentRequest(day: day, generation: generation, currentOwnerId: currentOwnerId, request: request) else { return }
            lastError = "Server scores unavailable"
            if let cached = try? cacheStore?.load(ownerId: owner, day: day) {
                session.accept(cached, generation: generation, currentOwnerId: currentOwnerId, request: request)
            }
        }
    }

    private func preloadFromDisk() {
        guard let cacheStore, let owner = session.ownerId else { return }
        let cal = Calendar.current
        let today = Date()
        for offset in 0..<14 {
            guard let date = cal.date(byAdding: .day, value: -offset, to: today) else { continue }
            let key = Repository.dayString(date)
            if let row = try? cacheStore.load(ownerId: owner, day: key) {
                session.accept(row, generation: session.generation, currentOwnerId: currentOwnerId)
            }
        }
    }

    private func synchronizeOwner() {
        guard session.ownerId != currentOwnerId else { return }
        stopPolling()
        session.activate(ownerId: currentOwnerId)
        signedIn = currentOwnerId != nil
        lastFetchedAt = nil
        lastError = nil
        sleepEditMessage = nil
        preloadFromDisk()
    }
}
