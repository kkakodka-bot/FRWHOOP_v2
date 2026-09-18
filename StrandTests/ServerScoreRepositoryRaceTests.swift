import XCTest
import WhoopStore
@testable import Strand

@MainActor
final class ServerScoreRepositoryRaceTests: XCTestCase {
    private let day = "2026-09-16"
    private let ownerA = "11111111-1111-1111-1111-111111111111"
    private let ownerB = "44444444-4444-4444-4444-444444444444"

    private actor Gate {
        private var continuation: CheckedContinuation<Void, Never>?
        private var opened = false
        func wait() async {
            if !opened { await withCheckedContinuation { continuation = $0 } }
        }
        func open() { opened = true; continuation?.resume(); continuation = nil }
    }
    private final class Auth {
        var owner: String?
        var conditionalClears = 0
        init(_ owner: String?) { self.owner = owner }
    }
    private func dependencies(_ auth: Auth,
        fetch: @escaping (String, String) async throws -> ServerScoreDayCache) -> ServerScoreRepository.Dependencies {
        .init(ownerId: { auth.owner }, clearSession: { auth.owner = nil },
            clearIfCurrent: { _, owner in
                auth.conditionalClears += 1
                guard auth.owner == owner else { return false }
                auth.owner = nil
                return true
            }, signIn: { owner, _ in auth.owner = owner }, fetch: fetch,
            enabled: { true }, ready: { true }, automaticPolling: false)
    }
    private func snapshot(_ owner: String, revision: Int = 1) throws -> ServerScoreDayCache {
        let data = try JSONSerialization.data(withJSONObject: ["server_scoring": [
            "schema_version": 2, "user_id": owner, "day": day, "algorithm_version": "per_feature",
            "features": ["sleep": ["status": "available", "device_id": "device", "algorithm_version": "frwhoop-server-1",
                "input_revision": revision, "required_revision": revision]],
            "daily": ["sleep_total_min": 480], "nights": [], "stale": false
        ]])
        return try ServerScoreCacheCodec.parseSnapshot(data, day: day, ownerId: owner,
            fetchedAt: Date(timeIntervalSince1970: Double(revision)))
    }

    func testLateSuccessAfterSignOutCannotDisplayOrPersist() async throws {
        let auth = Auth(ownerA), gate = Gate()
        let response = try snapshot(ownerA)
        let entered = expectation(description: "fetch started")
        let repo = ServerScoreRepository(dependencies: dependencies(auth) { _, _ in
            entered.fulfill(); await gate.wait(); return response
        })
        let store = try await WhoopStore.inMemory(); repo.wire(store: store)
        let pending = Task { await repo.refreshVisibleDays(todayKey: day) }
        await fulfillment(of: [entered], timeout: 2)
        repo.signOut()
        await gate.open(); await pending.value
        XCTAssertFalse(repo.signedIn); XCTAssertNil(repo.overlay(for: day)); XCTAssertNil(repo.lastFetchedAt)
        XCTAssertNil(try ServerScoreCacheStore(db: store.registryWriter).load(ownerId: ownerA, day: day))
    }

    func testDelayedUnauthorizedCannotClearTheNextAccount() async throws {
        let auth = Auth(ownerA), gate = Gate()
        let next = try snapshot(ownerB)
        let entered = expectation(description: "old account fetch started")
        let repo = ServerScoreRepository(dependencies: dependencies(auth) { _, owner in
            if owner == self.ownerA {
                entered.fulfill(); await gate.wait()
                throw ServerScoreClient.FetchError.unauthorized(accessToken: "old-token")
            }
            return next
        })
        let store = try await WhoopStore.inMemory(); repo.wire(store: store)
        let pending = Task { await repo.refreshVisibleDays(todayKey: day) }
        await fulfillment(of: [entered], timeout: 2)
        await repo.signIn(email: ownerB, password: "unused")
        XCTAssertEqual(repo.overlay(for: day)?.ownerId, ownerB)
        await gate.open(); await pending.value
        XCTAssertTrue(repo.signedIn); XCTAssertEqual(auth.owner, ownerB)
        XCTAssertEqual(repo.overlay(for: day)?.ownerId, ownerB); XCTAssertNil(repo.lastError)
        XCTAssertEqual(auth.conditionalClears, 0)
    }

    func testOlderOverlappingFetchCannotOverwriteNewerMemoryOrDisk() async throws {
        let auth = Auth(ownerA), gate = Gate()
        let old = try snapshot(ownerA, revision: 1), newest = try snapshot(ownerA, revision: 2)
        let entered = expectation(description: "first fetch started")
        var requests = 0
        let repo = ServerScoreRepository(dependencies: dependencies(auth) { _, _ in
            requests += 1
            if requests == 1 { entered.fulfill(); await gate.wait(); return old }
            return newest
        })
        let store = try await WhoopStore.inMemory(); repo.wire(store: store)
        let pending = Task { await repo.refreshVisibleDays(todayKey: day) }
        await fulfillment(of: [entered], timeout: 2)
        await repo.refreshVisibleDays(todayKey: day)
        await gate.open(); await pending.value
        XCTAssertEqual(repo.overlay(for: day)?.features["sleep"]?.inputRevision, 2)
        XCTAssertEqual(try ServerScoreCacheStore(db: store.registryWriter).load(ownerId: ownerA, day: day)?.features["sleep"]?.inputRevision, 2)
    }

    func testOfflineSignInRefreshDoesNotRestorePriorOwnerCache() async throws {
        let auth = Auth(ownerA)
        let prior = try snapshot(ownerA)
        var offline = false
        let repo = ServerScoreRepository(dependencies: dependencies(auth) { _, _ in
            if offline { throw URLError(.notConnectedToInternet) }
            return prior
        })
        let store = try await WhoopStore.inMemory(); repo.wire(store: store)
        await repo.refreshVisibleDays(todayKey: day)
        XCTAssertEqual(repo.overlay(for: day)?.ownerId, ownerA)
        offline = true
        await repo.signIn(email: ownerB, password: "unused")
        XCTAssertTrue(repo.signedIn); XCTAssertNil(repo.overlay(for: day))
        XCTAssertEqual(repo.lastError, "Server scores unavailable")
        XCTAssertNotNil(try ServerScoreCacheStore(db: store.registryWriter).load(ownerId: ownerA, day: day))
        XCTAssertNil(try ServerScoreCacheStore(db: store.registryWriter).load(ownerId: ownerB, day: day))
    }
}
