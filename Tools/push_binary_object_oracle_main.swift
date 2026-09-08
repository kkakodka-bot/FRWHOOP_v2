import Foundation

private let sourceA = "3a3486dd-5030-4e17-a00d-a781399890f9"
private let deviceA = "strap-a"

private func printCase(_ name: String, batch: PushBinaryBatch, decoded: Data) {
    print("=== \(name) ===")
    print("PACK_HEX=\(decoded.map { String(format: "%02x", $0) }.joined())")
    print("CONTENT_SHA256=\(batch.contentSha256)")
    print("BATCH_ID=\(batch.batchId)")
    print("OBJECT_ID=\(batch.objectId)")
    print("MANIFEST=\(String(data: batch.manifestJSON, encoding: .utf8) ?? "")")
    print("MANIFEST_ENCODE=\(String(data: try! PushObjectManifest(batch: batch).encode(), encoding: .utf8) ?? "")")
    print("SAMPLE_COUNT=\(batch.sampleCount)")
    print("")
}

@main
enum PushBinaryObjectOracle {
    static func main() {
        do {
            let ppgNoBurst = try PushProtocol.binaryObjectBatch(
                table: .ppgWaveformSample, sourceId: sourceA, deviceId: deviceA, startCursor: nil,
                rows: [.ppgWaveform(PushPpgWaveformRecord(rowId: 5, ts: 50, burstIndex: nil, samples: Data([0x0A])))],
                protocolVersion: PushProtocol.objectVersion,
                decodedLimit: PushProtocolLimits.maxObjectDecodedBytes,
            )
            let ppgDecoded = try PushBinaryCodec.pack(table: .ppgWaveformSample, rows: [
                .ppgWaveform(PushPpgWaveformRecord(rowId: 5, ts: 50, burstIndex: nil, samples: Data([0x0A]))),
            ])
            printCase("PPG_NO_BURST", batch: ppgNoBurst, decoded: ppgDecoded)

            let ppgBurst = try PushProtocol.binaryObjectBatch(
                table: .ppgWaveformSample, sourceId: sourceA, deviceId: deviceA, startCursor: nil,
                rows: [.ppgWaveform(PushPpgWaveformRecord(rowId: 10, ts: 100, burstIndex: 2, samples: Data([0x01, 0x02])))],
                protocolVersion: PushProtocol.objectVersion,
                decodedLimit: PushProtocolLimits.maxObjectDecodedBytes,
            )
            let ppgBurstDecoded = try PushBinaryCodec.pack(table: .ppgWaveformSample, rows: [
                .ppgWaveform(PushPpgWaveformRecord(rowId: 10, ts: 100, burstIndex: 2, samples: Data([0x01, 0x02]))),
            ])
            printCase("PPG_BURST", batch: ppgBurst, decoded: ppgBurstDecoded)

            let v18 = try PushProtocol.binaryObjectBatch(
                table: .v18AuxSample, sourceId: sourceA, deviceId: "strap", startCursor: nil,
                rows: [.v18Aux(PushV18AuxRecord(rowId: 1, ts: 10, fields: Data([0xAB])))],
                protocolVersion: PushProtocol.objectVersion,
                decodedLimit: PushProtocolLimits.maxObjectDecodedBytes,
            )
            let v18Decoded = try PushBinaryCodec.pack(table: .v18AuxSample, rows: [
                .v18Aux(PushV18AuxRecord(rowId: 1, ts: 10, fields: Data([0xAB]))),
            ])
            printCase("V18", batch: v18, decoded: v18Decoded)

            func imuColumns(seed: Int16) -> Data {
                var data = Data(count: PushBinaryCodec.imuRecordPayloadBytes)
                for index in 0..<PushBinaryCodec.imuColumnsPerRecord {
                    let value = Int16(truncatingIfNeeded: seed + Int16(index))
                    data[index * 2] = UInt8(truncatingIfNeeded: value)
                    data[index * 2 + 1] = UInt8(truncatingIfNeeded: value >> 8)
                }
                return data
            }
            let imuRow = PushRawImuRecord(rowId: 1_700_000_000, ts: 1_700_000_000, columns: imuColumns(seed: -1))
            let imu = try PushProtocol.binaryObjectBatch(
                table: .rawImuSession, sourceId: sourceA, deviceId: deviceA, startCursor: nil,
                rows: [.rawImuSession(imuRow)],
                protocolVersion: PushProtocol.objectVersion,
                decodedLimit: PushProtocolLimits.maxObjectDecodedBytes,
            )
            let imuDecoded = try PushBinaryCodec.pack(table: .rawImuSession, rows: [.rawImuSession(imuRow)])
            printCase("RAW_IMU", batch: imu, decoded: imuDecoded)

            let rawBatch = try PushProtocol.binaryObjectBatch(
                table: .rawBatch, sourceId: sourceA, deviceId: deviceA, startCursor: nil,
                rows: [.rawBatch(PushRawBatchRecord(
                    rowId: 1, batchId: "batch-1", capturedAt: 100, deviceClockRef: 90, wallClockRef: 100,
                    startTs: 100, endTs: 200, frameCount: 2, byteSize: 4, framesBlob: Data([0x01, 0x02, 0x03, 0x04])
                ))],
                protocolVersion: PushProtocol.objectVersion,
                decodedLimit: PushProtocolLimits.maxObjectDecodedBytes,
            )
            let rawBatchDecoded = try PushBinaryCodec.pack(table: .rawBatch, rows: [
                .rawBatch(PushRawBatchRecord(
                    rowId: 1, batchId: "batch-1", capturedAt: 100, deviceClockRef: 90, wallClockRef: 100,
                    startTs: 100, endTs: 200, frameCount: 2, byteSize: 4, framesBlob: Data([0x01, 0x02, 0x03, 0x04])
                )),
            ])
            printCase("RAW_BATCH", batch: rawBatch, decoded: rawBatchDecoded)

            let imuWindowRows: [PushBinaryRow] = (0..<3601).map { offset in
                let ts = 1_700_000_000 + Int64(offset)
                return .rawImuSession(PushRawImuRecord(rowId: ts, ts: ts, columns: imuColumns(seed: Int16(offset))))
            }
            let windowBatch = try PushProtocol.binaryObjectBatch(
                table: .rawImuSession, sourceId: sourceA, deviceId: deviceA, startCursor: nil, rows: imuWindowRows,
                protocolVersion: PushProtocol.objectVersion,
                decodedLimit: PushProtocolLimits.maxObjectDecodedBytes,
            )
            print("=== IMU_WINDOW_3601 ===")
            print("INPUT_COUNT=3601")
            print("SELECTED_COUNT=\(windowBatch.sampleCount)")
        } catch {
            fputs("oracle failed: \(error)\n", stderr)
            exit(1)
        }
    }
}
