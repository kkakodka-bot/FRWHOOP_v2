import Foundation
#if canImport(Compression)
import Compression
#endif
import zlib

public enum PushBinaryCompression {
    public static func compress(_ decoded: Data, encoding: String) throws -> Data {
        switch encoding {
        case "gzip":
            return try gzip(decoded)
        case "zstd":
            return try zstd(decoded)
        default:
            throw PushProtocolException("unsupported binary contentEncoding")
        }
    }

    /// Object-lane variant: same codecs, but bounded by the 1.2 object limits instead of the
    /// inline 4 MiB body limit. The negotiated ceiling (`PushObjectLane.maxObjectBytes`) is
    /// enforced by the coordinator against the result.
    public static func compressObject(_ decoded: Data, encoding: String) throws -> Data {
        switch encoding {
        case "gzip":
            return try gzip(decoded, maxDecoded: PushProtocolLimits.maxObjectDecodedBytes, maxWire: PushProtocolLimits.maxObjectWireBytes)
        case "zstd":
            return try zstd(decoded, maxDecoded: PushProtocolLimits.maxObjectDecodedBytes, maxWire: PushProtocolLimits.maxObjectWireBytes)
        default:
            throw PushProtocolException("unsupported binary contentEncoding")
        }
    }

    public static func gzip(_ decoded: Data) throws -> Data {
        try gzip(decoded, maxDecoded: PushProtocolLimits.maxBodyBytes, maxWire: PushProtocolLimits.maxWireBodyBytes)
    }

    private static func gzip(_ decoded: Data, maxDecoded: Int, maxWire: Int) throws -> Data {
        guard decoded.count <= maxDecoded else {
            throw PushProtocolException("binary payload exceeds decoded limit")
        }
        var stream = z_stream()
        var status = deflateInit2_(
            &stream, Z_DEFAULT_COMPRESSION, Z_DEFLATED, MAX_WBITS + 16, MAX_MEM_LEVEL, Z_DEFAULT_STRATEGY,
            ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)
        )
        guard status == Z_OK else { throw PushProtocolException("gzip init failed") }
        defer { deflateEnd(&stream) }

        var output = Data(capacity: decoded.count)
        try decoded.withUnsafeBytes { input in
            stream.next_in = UnsafeMutablePointer<Bytef>(mutating: input.bindMemory(to: Bytef.self).baseAddress!)
            stream.avail_in = uInt(decoded.count)
            let chunk = 64 * 1024
            var buffer = [UInt8](repeating: 0, count: chunk)
            repeat {
                stream.next_out = UnsafeMutablePointer<Bytef>(&buffer)
                stream.avail_out = uInt(chunk)
                status = deflate(&stream, Z_FINISH)
                let produced = chunk - Int(stream.avail_out)
                if produced > 0 { output.append(buffer, count: produced) }
            } while status == Z_OK
        }
        guard status == Z_STREAM_END else { throw PushProtocolException("gzip failed") }
        guard output.count <= maxWire else {
            throw PushProtocolException("gzip payload exceeds wire limit")
        }
        return output
    }

    public static func zstd(_ decoded: Data) throws -> Data {
        try zstd(decoded, maxDecoded: PushProtocolLimits.maxBodyBytes, maxWire: PushProtocolLimits.maxWireBodyBytes)
    }

    private static func zstd(_ decoded: Data, maxDecoded: Int, maxWire: Int) throws -> Data {
        #if canImport(Compression)
        guard decoded.count <= maxDecoded else {
            throw PushProtocolException("binary payload exceeds decoded limit")
        }
        let algorithm = compression_algorithm(rawValue: 9) // COMPRESSION_ZSTD
        // compression_encode_buffer fails outright when dst is too small, and zstd can EXPAND
        // incompressible input (rawBatch's already-zlib'd frames) by more than a flat 64 bytes.
        let dstCapacity = decoded.count + max(4_096, decoded.count / 64)
        var dst = [UInt8](repeating: 0, count: dstCapacity)
        let written = decoded.withUnsafeBytes { src -> Int in
            guard let srcPtr = src.baseAddress else { return 0 }
            return compression_encode_buffer(
                &dst, dstCapacity, srcPtr, decoded.count, nil, algorithm
            )
        }
        guard written > 0 else { throw PushProtocolException("zstd failed") }
        let output = Data(dst.prefix(written))
        guard output.count <= maxWire else {
            throw PushProtocolException("zstd payload exceeds wire limit")
        }
        return output
        #else
        throw PushProtocolException("zstd unavailable")
        #endif
    }
}
