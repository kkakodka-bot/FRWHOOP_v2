import Foundation
import CryptoKit
import NoopPush
import Darwin

enum CloudUploadError: Error, Equatable {
    case unavailable, staleOwner, storageFull, corruptJournal, changedPayload, invalidRequest
    case retryScheduled, invalidReceipt, responseTooLarge
}

struct CloudUploadJob: Codable, Sendable {
    enum Phase: String, Codable { case prepared, transferring, uploaded, responseSaved, receiptSaved, retryPending }
    enum Operation: String, Codable { case request, objectPut, objectComplete }

    let id: String
    let owner: AccountScope
    var generation: UUID
    let endpoint: String
    let deviceID: String
    let createdAt: Date
    var phase: Phase = .prepared
    var operation: Operation
    var payloadName: String?
    var payloadSHA256: String?
    var payloadBytes: Int = 0
    var method: String
    var headers: [String: String]
    var objectID: String?
    var objectKey: String?
    var verifiedObjectKey: String?
    var manifest: Data?
    var lanePath: String?
    var signedURL: String?
    var signedHeaders: [String: String] = [:]
    var signedExpiry: Date?
    var needsNewIntent = false
    var attempt: UUID?
    var taskIdentifier: Int?
    var failures = 0
    var nextAttemptAt: Date?
    var responseStatus: Int?
    var responseBody: Data?
    var acknowledged = false
    var receiverStateID: String = ""
    var batchID: String?
    var allowsCellular: Bool?
    var allowsConstrained: Bool?
    var validatedReceipt: PushDurabilityReceipt?
    var correlation: UUID?

    var taskDescription: String? { attempt.map { "\(id):\($0.uuidString)" } }
    var context: AccountSessionContext { .init(scope: owner, generation: generation) }
    var response: PushTransportResponse? {
        guard let status = responseStatus, let body = responseBody else { return nil }
        return .init(statusCode: status, body: body)
    }
}

/// Only the upload actor accesses this journal. Payloads never change after their metadata commits.
final class CloudUploadJournal: @unchecked Sendable {
    let directory: URL
    let maximumBytes: Int
    private let fm = FileManager.default

    init(directory: URL, maximumBytes: Int = 1_073_741_824) throws {
        self.directory = directory
        self.maximumBytes = maximumBytes
        try fm.createDirectory(at: directory, withIntermediateDirectories: true,
                               attributes: [.posixPermissions: 0o700])
        var excluded = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try excluded.setResourceValues(values)
        #if os(iOS)
        try fm.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                             ofItemAtPath: directory.path)
        #endif
    }

    func load() throws -> [String: CloudUploadJob] {
        var jobs: [String: CloudUploadJob] = [:]
        for url in try fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            where url.pathExtension == "json" {
            let job = try JSONDecoder().decode(CloudUploadJob.self, from: Data(contentsOf: url))
            guard job.id == url.deletingPathExtension().lastPathComponent,
                  Self.validID(job.id), jobs[job.id] == nil else { throw CloudUploadError.corruptJournal }
            if let name = job.payloadName {
                guard name == "\(job.id).body" else { throw CloudUploadError.corruptJournal }
            }
            jobs[job.id] = job
        }
        return jobs
    }

    func save(_ job: CloudUploadJob) throws {
        guard Self.validID(job.id) else { throw CloudUploadError.corruptJournal }
        try durableWrite(JSONEncoder().encode(job), to: directory.appendingPathComponent("\(job.id).json"))
    }

    func persistBody(_ body: Data, job: inout CloudUploadJob) throws {
        let hash = Self.digest(body)
        if let prior = job.payloadSHA256 {
            guard prior == hash, job.payloadBytes == body.count else { throw CloudUploadError.changedPayload }
            try verifyBody(job)
            return
        }
        let name = "\(job.id).body"
        let url = directory.appendingPathComponent(name)
        // A crash after body creation but before metadata commit leaves an adoptable immutable file.
        if fm.fileExists(atPath: url.path) {
            guard try Self.digest(Data(contentsOf: url)) == hash else { throw CloudUploadError.changedPayload }
        } else {
            let files = try fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey])
            let used = try files.reduce(0) { $0 + (try $1.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) }
            guard body.count <= maximumBytes, used <= maximumBytes - body.count else { throw CloudUploadError.storageFull }
            try durableWrite(body, to: url)
        }
        job.payloadName = name
        job.payloadSHA256 = hash
        job.payloadBytes = body.count
    }

    func bodyURL(_ job: CloudUploadJob) throws -> URL {
        guard let name = job.payloadName, name == "\(job.id).body" else { throw CloudUploadError.corruptJournal }
        return directory.appendingPathComponent(name)
    }

    func verifyBody(_ job: CloudUploadJob) throws {
        let url = try bodyURL(job)
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        var bytes = 0
        while let data = try handle.read(upToCount: 256 * 1024), !data.isEmpty {
            bytes += data.count
            hasher.update(data: data)
        }
        let hash = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        guard hash == job.payloadSHA256, bytes == job.payloadBytes else { throw CloudUploadError.changedPayload }
    }

    func emptyBodyURL() throws -> URL {
        let url = directory.appendingPathComponent("completion.body")
        if !fm.fileExists(atPath: url.path) { try durableWrite(Data(), to: url) }
        return url
    }

    func removeCommitted(_ job: CloudUploadJob) throws {
        guard job.acknowledged, Self.validID(job.id) else { throw CloudUploadError.invalidReceipt }
        if job.payloadName != nil {
            try unlinkFile(bodyURL(job))
        }
        let metadata = directory.appendingPathComponent("\(job.id).json")
        try unlinkFile(metadata)
        try syncDirectory()
    }

    private func unlinkFile(_ url: URL) throws {
        // Unlike removeItem, unlink cannot recursively erase an unexpected directory at this path.
        guard Darwin.unlink(url.path) != 0 else { return }
        let code = errno
        guard code != ENOENT else { return }
        throw POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO)
    }

    func durableWrite(_ data: Data, to url: URL) throws {
        try data.write(to: url, options: .atomic)
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        #if os(iOS)
        try fm.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
        #endif
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.synchronize()
        try syncDirectory()
    }

    private func syncDirectory() throws {
        let descriptor = Darwin.open(directory.path, O_RDONLY)
        guard descriptor >= 0 else { throw CloudUploadError.corruptJournal }
        defer { Darwin.close(descriptor) }
        guard Darwin.fsync(descriptor) == 0 else { throw CloudUploadError.corruptJournal }
    }

    static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    private static func validID(_ id: String) -> Bool {
        id.count == 64 && id.allSatisfy { "0123456789abcdef".contains($0) }
    }
}
