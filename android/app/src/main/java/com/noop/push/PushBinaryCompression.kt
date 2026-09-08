package com.noop.push

import com.github.luben.zstd.Zstd
import okio.Buffer
import okio.GzipSink
import okio.buffer

object PushBinaryCompression {
    fun compress(decoded: ByteArray, encoding: String): ByteArray = when (encoding) {
        "gzip" -> gzip(decoded, PushProtocol.MAX_BODY_BYTES, PushProtocol.MAX_WIRE_BODY_BYTES)
        "zstd" -> zstd(decoded, PushProtocol.MAX_BODY_BYTES, PushProtocol.MAX_WIRE_BODY_BYTES)
        else -> throw PushProtocolException("unsupported binary contentEncoding")
    }

    fun compressObject(decoded: ByteArray, encoding: String): ByteArray = when (encoding) {
        "gzip" -> gzip(decoded, PushProtocol.MAX_OBJECT_DECODED_BYTES, PushProtocol.MAX_OBJECT_WIRE_BYTES)
        "zstd" -> zstd(decoded, PushProtocol.MAX_OBJECT_DECODED_BYTES, PushProtocol.MAX_OBJECT_WIRE_BYTES)
        else -> throw PushProtocolException("unsupported binary contentEncoding")
    }

    private fun gzip(decoded: ByteArray, maxDecoded: Int, maxWire: Int): ByteArray {
        if (decoded.size > maxDecoded) throw PushProtocolException("binary payload exceeds decoded limit")
        val buffer = Buffer()
        GzipSink(buffer).buffer().use { it.write(decoded) }
        val output = buffer.readByteArray()
        if (output.size > maxWire) throw PushProtocolException("gzip payload exceeds wire limit")
        return output
    }

    private fun zstd(decoded: ByteArray, maxDecoded: Int, maxWire: Int): ByteArray {
        if (decoded.size > maxDecoded) throw PushProtocolException("binary payload exceeds decoded limit")
        val output = Zstd.compress(decoded)
        if (output.size > maxWire) throw PushProtocolException("zstd payload exceeds wire limit")
        return output
    }
}
