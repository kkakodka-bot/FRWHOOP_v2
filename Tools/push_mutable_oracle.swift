#!/usr/bin/env swift
// Regenerate oracle literals in PushProtocolTests.swift and PushProtocolTest.kt.
// Run from repo root: swift Tools/push_mutable_oracle.swift

import Foundation
import CryptoKit

private let sourceA = "3a3486dd-5030-4e17-a00d-a781399890f9"
private let version = "1.0"
private let uuidPlaceholder = "00000000-0000-0000-0000-000000000000"
private let maxRecords = 5_000
private let maxBodyBytes = 4 * 1024 * 1024

enum PushJSONValue {
    case null, string(String), bool(Bool), int(Int64), double(Double), map([String: PushJSONValue])
}

struct PushMutableRecord {
    let key: [String: PushJSONValue]
    let data: [String: PushJSONValue]
}

struct PushWindow {
    let fromDay: String
    let toDay: String
    let startTsInclusive: Int64
    let endTsExclusive: Int64
}

enum PushMutableTable: String {
    case journal
    var wireName: String { rawValue }
}

private let registry: [String: (keys: [String], data: [String])] = [
    "journal": (["day", "question"], ["answeredYes", "notes", "numericValue"]),
]

func orderedObjectJson(_ value: [String: PushJSONValue]) -> String {
    var out = ""
    appendCanonical(.map(value), to: &out, sortMaps: false)
    return out
}

func appendCanonical(_ value: PushJSONValue?, to out: inout String, sortMaps: Bool) {
    switch value {
    case nil, .null: out.append("null")
    case .string(let s): appendQuoted(s, to: &out)
    case .bool(let b): out.append(b ? "true" : "false")
    case .int(let i): out.append(String(i))
    case .double(let d): out.append(String(d))
    case .map(let map):
        let entries = sortMaps ? map.sorted { $0.key < $1.key } : map.map { ($0.key, $0.value) }
        out.append("{")
        for (index, entry) in entries.enumerated() {
            if index > 0 { out.append(",") }
            appendQuoted(entry.0, to: &out)
            out.append(":")
            appendCanonical(entry.1, to: &out, sortMaps: sortMaps)
        }
        out.append("}")
    }
}

func appendQuoted(_ value: String, to out: inout String) {
    out.append("\"")
    for ch in value {
        switch ch {
        case "\"": out.append("\\\"")
        case "\\": out.append("\\\\")
        case "\u{8}": out.append("\\b")
        case "\u{C}": out.append("\\f")
        case "\n": out.append("\\n")
        case "\r": out.append("\\r")
        case "\t": out.append("\\t")
        default:
            if ch.unicodeScalars.first!.value < 0x20 {
                out.append(String(format: "\\u%04x", ch.unicodeScalars.first!.value))
            } else { out.append(ch) }
        }
    }
    out.append("\"")
}

func encodeLine(_ value: [String: PushJSONValue]) -> Data {
    var json = ""
    appendCanonical(.map(value), to: &json, sortMaps: true)
    json.append("\n")
    return Data(json.utf8)
}

func encodeRecordLine(_ record: PushMutableRecord) -> Data {
    encodeLine(["type": .string("record"), "key": .map(record.key), "data": .map(record.data)])
}

func dayAfter(_ day: String) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd"
    f.timeZone = TimeZone(secondsFromGMT: 0)
    let date = f.date(from: day)!
    let next = Calendar(identifier: .gregorian).date(byAdding: .day, value: 1, to: date)!
    return f.string(from: next)
}

func selectorBounds(_ table: PushMutableTable, _ window: PushWindow) -> [String: PushJSONValue] {
    switch table {
    case .journal:
        return [
            "endExclusive": .string(dayAfter(window.toDay)),
            "selector": .string("day"),
            "startInclusive": .string(window.fromDay),
        ]
    }
}

func stableUuid(header: [String: PushJSONValue], lines: [Data]) -> String {
    var hasher = SHA256()
    var json = ""
    appendCanonical(.map(header), to: &json, sortMaps: true)
    hasher.update(data: Data(json.utf8))
    hasher.update(data: Data([0x0A]))
    for line in lines { hasher.update(data: line) }
    var bytes = Array(hasher.finalize())
    bytes[6] = (bytes[6] & 0x0F) | 0x50
    bytes[8] = (bytes[8] & 0x3F) | 0x80
    let uuid = uuid_t(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                    bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15])
    return UUID(uuid: uuid).uuidString.lowercased()
}

func mutableSnapshotHash(_ table: PushMutableTable, _ records: [PushMutableRecord]) -> String {
    let lines = records.map { encodeRecordLine($0) }.sorted { compareBytes($0, $1) < 0 }
    var hasher = SHA256()
    hasher.update(data: Data("noop-push-day-hash\n\(version)\n\(table.wireName)\n".utf8))
    for line in lines { hasher.update(data: line) }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
}

func compareBytes(_ left: Data, _ right: Data) -> Int {
    let common = min(left.count, right.count)
    for i in 0..<common {
        let d = Int(left[i]) - Int(right[i])
        if d != 0 { return d }
    }
    return left.count - right.count
}

func mutableBatches(table: PushMutableTable, sourceId: String, deviceId: String, window: PushWindow, records: [PushMutableRecord]) -> [(batchId: String, replacementId: String, part: Int, parts: Int, count: Int, bodySha: String)] {
    let lines = records.map { encodeRecordLine($0) }
    let replacementIdentity: [String: PushJSONValue] = [
        "deviceId": .string(deviceId), "delivery": .string("replace_window"),
        "protocolVersion": .string(version), "sourceId": .string(sourceId),
        "stream": .string(table.wireName), "window": .map(selectorBounds(table, window)),
    ]
    let replacementId = stableUuid(header: replacementIdentity, lines: lines)
    var chunks: [[Data]] = []
    var current: [Data] = []
    var currentBytes = 0
    for line in lines {
        let nextCount = current.count + 1
        if nextCount > maxRecords { chunks.append(current); current = []; currentBytes = 0 }
        current.append(line)
        currentBytes += line.count
    }
    if !current.isEmpty || chunks.isEmpty { chunks.append(current) }
    let parts = chunks.count
    return chunks.enumerated().map { index, partLines in
        let part = index + 1
        var windowBounds = selectorBounds(table, window)
        windowBounds["part"] = .int(Int64(part))
        windowBounds["parts"] = .int(Int64(parts))
        windowBounds["replacementId"] = .string(replacementId)
        let identity: [String: PushJSONValue] = [
            "delivery": .string("replace_window"), "deviceId": .string(deviceId), "endCursor": .null,
            "protocolVersion": .string(version), "recordCount": .int(Int64(partLines.count)),
            "sourceId": .string(sourceId), "startCursor": .null, "stream": .string(table.wireName),
            "type": .string("batch"), "window": .map(windowBounds),
        ]
        let batchId = stableUuid(header: identity, lines: partLines)
        var header = identity
        header["batchId"] = .string(batchId)
        let body = encodeLine(header) + partLines.reduce(into: Data()) { $0.append($1) }
        let bodySha = SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
        return (batchId, replacementId, part, parts, partLines.count, bodySha)
    }
}

let testWindow = PushWindow(fromDay: "2026-08-05", toDay: "2026-08-18", startTsInclusive: 1_754_348_400, endTsExclusive: 1_755_558_000)

print("empty|", mutableBatches(table: .journal, sourceId: sourceA, deviceId: "device-a", window: testWindow, records: []).map { "\($0.batchId)|\($0.replacementId)|\($0.part)|\($0.parts)|\($0.count)|\($0.bodySha)" }.joined(separator: ";"))

let journalRecords = (1...5_001).map { index in
    PushMutableRecord(
        key: ["day": .string("2026-08-\(String(format: "%02d", index % 14 + 5))"), "question": .string("q\(index)")],
        data: ["answeredYes": .bool(true), "notes": .null, "numericValue": .null]
    )
}.sorted {
    let l = ($0.key["day"] as? PushJSONValue, $0.key["question"] as? PushJSONValue)
    let r = ($1.key["day"] as? PushJSONValue, $1.key["question"] as? PushJSONValue)
    func str(_ v: PushJSONValue?) -> String { if case .string(let s) = v { return s }; return "" }
    let cmp = str(l.0).compare(str(r.0))
    if cmp != .orderedSame { return cmp == .orderedAscending }
    return str(l.1) < str(r.1)
}

let split = mutableBatches(table: .journal, sourceId: sourceA, deviceId: "device-a", window: testWindow, records: journalRecords)
print("split|parts=\(split.count)|\(split.map { "\($0.part):\($0.count):\($0.batchId)" }.joined(separator: ","))")

let first = PushMutableRecord(
    key: ["day": .string("2026-08-18"), "question": .string("coffee")],
    data: ["answeredYes": .bool(true), "notes": .string("one"), "numericValue": .null]
)
let changed = PushMutableRecord(
    key: ["day": .string("2026-08-18"), "question": .string("coffee")],
    data: ["answeredYes": .bool(true), "notes": .string("two"), "numericValue": .null]
)
print("hash_first|", mutableSnapshotHash(.journal, [first]))
print("hash_same|", mutableSnapshotHash(.journal, [first]))
print("hash_changed|", mutableSnapshotHash(.journal, [changed]))
print("hash_empty|", mutableSnapshotHash(.journal, []))
