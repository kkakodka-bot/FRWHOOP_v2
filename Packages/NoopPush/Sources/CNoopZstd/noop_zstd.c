#include "noop_zstd.h"
#include <stdlib.h>
#include <zstd.h>

int noop_zstd_compress(const uint8_t *src, size_t src_len, uint8_t **out, size_t *out_len) {
    if (src == NULL || out == NULL || out_len == NULL) return -1;
    size_t bound = ZSTD_compressBound(src_len);
    uint8_t *dst = (uint8_t *)malloc(bound);
    if (dst == NULL) return -1;
    size_t written = ZSTD_compress(dst, bound, src, src_len, ZSTD_defaultCLevel());
    if (ZSTD_isError(written)) {
        free(dst);
        return -1;
    }
    *out = dst;
    *out_len = written;
    return 0;
}

void noop_zstd_free(uint8_t *out) {
    free(out);
}
