import Foundation
import GRDB

// MARK: - v44 store: durable post-offload sync debt + journal (#1538)
//
// SyncJobStore.swift — GRDB CRUD over `syncJob` and `syncJournalEntry` (migration v44-sync-jobs).
// Device-local operational state only; NOT part of the `.noopbak` backup whitelist.

/// One outstanding post-offload stage debt. `kind` is the primary key so at most one debt per stage.
public struct SyncJob: Equatable, Codable, Sendable {
    public var kind: String
    public var owedAt: Int
    public var token: String
    public var attempts: Int
    public var lastNote: String?

    public init(kind: String, owedAt: Int, token: String, attempts: Int, lastNote: String?) {
        self.kind = kind
        self.owedAt = owedAt
        self.token = token
        self.attempts = attempts
        self.lastNote = lastNote
    }

    static func decode(_ row: Row) -> SyncJob {
        SyncJob(
            kind: row["kind"],
            owedAt: row["owedAt"],
            token: row["token"],
            attempts: row["attempts"],
            lastNote: row["lastNote"]
        )
    }
}

/// One completed sync-drain pass recorded for diagnostics.
public struct SyncJournalEntry: Equatable, Codable, Sendable {
    public var id: Int64
    public var ts: Int
    public var wakeReason: String
    public var stagesRun: String
    public var stagesOwed: String
    public var durationMs: Int
    public var note: String?

    public init(id: Int64, ts: Int, wakeReason: String, stagesRun: String, stagesOwed: String,
                durationMs: Int, note: String?) {
        self.id = id
        self.ts = ts
        self.wakeReason = wakeReason
        self.stagesRun = stagesRun
        self.stagesOwed = stagesOwed
        self.durationMs = durationMs
        self.note = note
    }

    static func decode(_ row: Row) -> SyncJournalEntry {
        SyncJournalEntry(
            id: row["id"],
            ts: row["ts"],
            wakeReason: row["wakeReason"],
            stagesRun: row["stagesRun"],
            stagesOwed: row["stagesOwed"],
            durationMs: row["durationMs"],
            note: row["note"]
        )
    }
}

/// Post-offload stage identifiers. Stored as TEXT in `syncJob.kind`.
public enum SyncJobKind: String, CaseIterable, Sendable {
    case rescore
    case cloudPush
    case healthWriteback
    case widgetPublish
}

extension WhoopStore {

    /// Newest journal rows retained on device. Swept amortised on insert, same shape as
    /// `v18AuxSample` / `ppgWaveformSample` retention.
    public static let syncJournalRetentionRows = 200

    /// Record that [kind] is owed. Returns a fresh token (#1681): a pass settles only the debt it
    /// captured. Re-marking the same kind replaces the token so a stale pass cannot clear new work.
    @discardableResult
    public func markJobOwed(kind: String, note: String? = nil) async throws -> String {
        try await markJobsOwed(kinds: [kind], note: note)[kind] ?? ""
    }

    /// Atomically record a set of post-offload debts. Each kind receives a fresh token, and all rows
    /// commit together. This is used by the historical safe-trim path: downstream work becomes durable
    /// after decoded rows land but before the strap is allowed to discard the chunk.
    @discardableResult
    public func markJobsOwed(kinds: [String], note: String? = nil) async throws -> [String: String] {
        let uniqueKinds = Array(Set(kinds.filter { !$0.isEmpty })).sorted()
        guard !uniqueKinds.isEmpty else { return [:] }
        let tokens = Dictionary(uniqueKeysWithValues: uniqueKinds.map { ($0, UUID().uuidString) })
        let now = Int(Date().timeIntervalSince1970)
        try syncWrite { db in
            let statement = try db.cachedStatement(sql: """
                INSERT INTO syncJob (kind, owedAt, token, attempts, lastNote)
                VALUES (?, ?, ?, 0, ?)
                ON CONFLICT(kind) DO UPDATE SET
                    owedAt = excluded.owedAt,
                    token = excluded.token,
                    attempts = 0,
                    lastNote = excluded.lastNote
                """)
            for kind in uniqueKinds {
                try statement.execute(arguments: [kind, now, tokens[kind], note])
            }
        }
        return tokens
    }

    /// Mirror an external rescore debt without minting a new token — `RescoreBackgroundScheduler`
    /// remains the source of truth; this row exists so all owed work is visible in one table.
    public func mirrorRescoreJob(token: String, owedAt: Int? = nil) async throws {
        let ts = owedAt ?? Int(Date().timeIntervalSince1970)
        try syncWrite { db in
            try db.execute(sql: """
                INSERT INTO syncJob (kind, owedAt, token, attempts, lastNote)
                VALUES (?, ?, ?, 0, NULL)
                ON CONFLICT(kind) DO UPDATE SET
                    owedAt = excluded.owedAt,
                    token = excluded.token
                """, arguments: [SyncJobKind.rescore.rawValue, ts, token])
        }
    }

    /// Settle [kind] only when [token] still matches the current debt (#1681).
    @discardableResult
    public func settleJob(kind: String, token: String) async throws -> Bool {
        try syncWrite { db in
            let current = try String.fetchOne(
                db, sql: "SELECT token FROM syncJob WHERE kind = ?", arguments: [kind])
            guard current == token else { return false }
            try db.execute(sql: "DELETE FROM syncJob WHERE kind = ? AND token = ?",
                           arguments: [kind, token])
            return true
        }
    }

    /// Remove a job row when the external source of truth says the debt is gone.
    public func clearJob(kind: String) async throws {
        try syncWrite { db in
            try db.execute(sql: "DELETE FROM syncJob WHERE kind = ?", arguments: [kind])
        }
    }

    /// Every currently outstanding debt, oldest first.
    public func owedJobs() async throws -> [SyncJob] {
        try syncRead { db in
            try Row.fetchAll(db, sql: "SELECT * FROM syncJob ORDER BY owedAt ASC")
                .map(SyncJob.decode)
        }
    }

    /// Bump the attempt counter before starting a stage pass. When a token is supplied, a stale pass
    /// cannot charge its attempt to a newer generation that arrived after the pass captured its inputs.
    public func recordJobAttempt(kind: String, token: String? = nil) async throws {
        try syncWrite { db in
            if let token {
                try db.execute(sql: """
                    UPDATE syncJob SET attempts = attempts + 1 WHERE kind = ? AND token = ?
                    """, arguments: [kind, token])
            } else {
                try db.execute(sql: """
                    UPDATE syncJob SET attempts = attempts + 1 WHERE kind = ?
                    """, arguments: [kind])
            }
        }
    }

    /// Append one drain journal row and sweep rows older than `syncJournalRetentionRows`.
    public func appendSyncJournal(wakeReason: String, stagesRun: [String], stagesOwed: [String],
                                  durationMs: Int, note: String? = nil) async throws {
        let now = Int(Date().timeIntervalSince1970)
        let run = stagesRun.joined(separator: ",")
        let owed = stagesOwed.joined(separator: ",")
        try syncWrite { db in
            try db.execute(sql: """
                INSERT INTO syncJournalEntry (ts, wakeReason, stagesRun, stagesOwed, durationMs, note)
                VALUES (?, ?, ?, ?, ?, ?)
                """, arguments: [now, wakeReason, run, owed, durationMs, note])
            try db.execute(sql: """
                DELETE FROM syncJournalEntry WHERE id NOT IN (
                    SELECT id FROM syncJournalEntry ORDER BY id DESC LIMIT ?
                )
                """, arguments: [Self.syncJournalRetentionRows])
        }
    }

    /// Recent journal entries, newest first.
    public func recentSyncJournal(limit: Int = 20) async throws -> [SyncJournalEntry] {
        let capped = max(1, min(limit, Self.syncJournalRetentionRows))
        return try syncRead { db in
            try Row.fetchAll(
                db,
                sql: "SELECT * FROM syncJournalEntry ORDER BY id DESC LIMIT ?",
                arguments: [capped]
            ).map(SyncJournalEntry.decode)
        }
    }
}
