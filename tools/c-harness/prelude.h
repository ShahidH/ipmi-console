/* Dev-only: compile ASPEED's WASM-targeted decoder natively with 32-bit 'long'. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#define EMSCRIPTEN_KEEPALIVE
#define long int
/* ASPEED's colour conversion indexes up to ~-300 below its range-limit table,
 * which only reserves 256 bytes of negative headroom (reads heap garbage for
 * very dark pixels). Zero padding below every allocation makes those reads
 * return the intended clamp value 0 without changing the decoder's logic. */
static inline void *ojv_padded_malloc(size_t n) {
  char *p = (char *)calloc(n + 2048, 1);
  return p ? p + 1024 : 0;
}
#define malloc(n) ojv_padded_malloc(n)
