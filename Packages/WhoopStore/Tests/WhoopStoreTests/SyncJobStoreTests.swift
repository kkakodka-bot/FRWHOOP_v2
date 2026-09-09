import XCTest
import GRDB
@testable import WhoopStore

final class SyncJobStoreTests: XCTestCase {

    private func store() async throws -> WhoopStore {
        try await WhoopStore.inMemory()
    }

    // MARK: - Migration shape

    func testV44AddsSyncJobTablesAdditively() async throws {
        let s = try await store()
        let tables = try await s.tableNames()
        XCTAssertTrue(tables.contains("syncJob"))
        XCTAssertTrue(tables.contains("syncJournalEntry"))

        let jobPK = try await s.primaryKeyColumns("syncJob")
        XCTAssertEqual(jobPK, ["kind"])

        let jobCols = try await s.columnNamesForTest(table: "syncJob")
        XCTAssertEqual(jobCols, ["kind", "owedAt", "token", "attempts", "lastNote"])

        let journalCols = try await s.columnNamesForTest(table: "syncJournalEntry")
        XCTAssertEqual(journalCols, ["id", "ts", "wakeReason", "stagesRun", "stagesOwed", "durationMs", "note"])
    }

    // MARK: - Token semantics (#1681)

    func testStaleTokenCannotSettle() async throws {
        let s = try await store()
        let first = try await s.markJobOwed(kind: SyncJobKind.cloudPush.rawValue)
        _ = try await s.markJobOwed(kind: SyncJobKind.cloudPush.rawValue)
        let staleSettled = try await s.settleJob(kind: SyncJobKind.cloudPush.rawValue, token: first)
        XCTAssertFalse(staleSettled)

        let owed = try await s.owedJobs()
        XCTAssertEqual(owed.count, 1)
        XCTAssertNotEqual(owed[0].token, first)

        let settled = try await s.settleJob(kind: SyncJobKind.cloudPush.rawValue, token: owed[0].token)
        XCTAssertTrue(settled)
        let remaining = try await s.owedJobs()
        XCTAssertTrue(remaining.isEmpty)
    }

    func testMatchingTokenSettles() async throws {
        let s = try await store()
        let token = try await s.markJobOwed(kind: SyncJobKind.widgetPublish.rawValue, note: "test")
        let settled = try await s.settleJob(kind: SyncJobKind.widgetPublish.rawValue, token: token)
        XCTAssertTrue(settled)
    }

    func testRecordJobAttemptIncrements() async throws {
        let s = try await store()
        _ = try await s.markJobOwed(kind: SyncJobKind.healthWriteback.rawValue)
        try await s.recordJobAttempt(kind: SyncJobKind.healthWriteback.rawValue)
        try await s.recordJobAttempt(kind: SyncJobKind.healthWriteback.rawValue)
        let job = try await s.owedJobs().first
        XCTAssertEqual(job?.attempts, 2)
    }

    // MARK: - Journal cap

    func testJournalCapSweepsOldestRows() async throws {
        let s = try await store()
        let keep = WhoopStore.syncJournalRetentionRows
        for i in 0..<(keep + 5) {
            try await s.appendSyncJournal(
                wakeReason: "manual",
                stagesRun: ["rescore"],
                stagesOwed: [],
                durationMs: i,
                note: "row-\(i)"
            )
        }
        let rows = try await s.recentSyncJournal(limit: keep + 10)
        XCTAssertEqual(rows.count, keep)
        XCTAssertEqual(rows.first?.durationMs, keep + 4)
        XCTAssertEqual(rows.last?.durationMs, 5)
    }

    func testMirrorRescoreJobPreservesExternalToken() async throws {
        let s = try await store()
        let external = "external-rescore-token"
        try await s.mirrorRescoreJob(token: external, owedAt: 1_700_000_000)
        let job = try await s.owedJobs().first
        XCTAssertEqual(job?.kind, SyncJobKind.rescore.rawValue)
        XCTAssertEqual(job?.token, external)
    }
}
