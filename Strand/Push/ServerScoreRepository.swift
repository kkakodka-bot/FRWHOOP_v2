import Foundation
import WhoopStore

/// Polls `get_day_snapshot`, persists last-known server scores, and serves overlays to the UI.
@MainActor
final class ServerScoreRepository: ObservableObject {
    @Published private(set) var lastError: String?
    @Published private(set) var lastFetchedAt: Date?
    @Published private(set) var signedIn: Bool = CloudAuthClient.storedSession() != nil

    private var pollTask: Task<Void, Never>?
    private var cacheStore: ServerScoreCacheStore?
    private var memoryCache: [String: ServerScoreDayCache] = [:]

    func wire(store: WhoopStore) {
        cacheStore = ServerScoreCacheStore(db: store.registryWriter)
        signedIn = CloudAuthClient.storedSession() != nil
        preloadFromDisk()
    }

    func signIn(email: String, password: String) async {
        do {
            _ = try await CloudAuthClient.signIn(email: email, password: password)
            signedIn = true
            lastError = nil
            await refreshVisibleDays()
        } catch {
            signedIn = false
            lastError = "Sign-in failed"
        }
    }

    func signOut() {
        CloudAuthClient.clearSession()
        signedIn = false
        stopPolling()
    }

    func overlay(for day: String) -> ServerScoreDayCache? {
        guard ServerScoringSettings.isEnabled else { return nil }
        return memoryCache[day]
    }

    func startPolling(todayKey: String) {
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

    func refreshVisibleDays(todayKey: String? = nil) async {
        guard ServerScoringSettings.ready, signedIn else { return }
        if let todayKey {
            await fetch(day: todayKey)
        }
    }

    private func fetch(day: String) async {
        do {
            let cache = try await ServerScoreClient.fetchDaySnapshot(day: day)
            memoryCache[day] = cache
            try cacheStore?.upsert(
                day: cache.day,
                daily: cache.daily,
                nights: cache.nights,
                computedAt: cache.computedAt,
                stale: cache.stale
            )
            lastFetchedAt = cache.fetchedAt
            lastError = nil
        } catch ServerScoreClient.FetchError.unauthorized {
            signedIn = false
            lastError = "Session expired — sign in again"
        } catch {
            lastError = "Server scores unavailable"
            if let cached = memoryCache[day] ?? (try? cacheStore?.load(day: day)) {
                memoryCache[day] = cached
            }
        }
    }

    private func preloadFromDisk() {
        guard let cacheStore else { return }
        let cal = Calendar.current
        let today = Date()
        for offset in 0..<14 {
            guard let date = cal.date(byAdding: .day, value: -offset, to: today) else { continue }
            let key = Repository.dayString(date)
            if let row = try? cacheStore.load(day: key) {
                memoryCache[key] = row
            }
        }
    }
}
