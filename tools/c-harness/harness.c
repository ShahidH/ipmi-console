/* Dev-only differential harness: runs ASPEED's aspeed_codec decoder (MPL-2.0,
 * hitsc-maintained copy) over frame files (86-byte AMI VideoHeader + data) and
 * writes width,height (int32 LE) + RGBA per frame. Not part of the application. */
void init(void);
void decode_ext(unsigned long *in, int len, unsigned char *out, int w, int h, unsigned m420,
                unsigned sel, unsigned csel, unsigned adv, unsigned cadv, unsigned mapping);

static unsigned rd16(const unsigned char *b) { return b[0] | (b[1] << 8); }
static unsigned rd32(const unsigned char *b) { return b[0] | (b[1] << 8) | (b[2] << 16) | ((unsigned)b[3] << 24); }

int main(int argc, char **argv) {
  FILE *out = fopen(argv[1], "wb");
  unsigned char *fb = calloc(4096 * 4096, 4);
  init();
  for (int i = 2; i < argc; i++) {
    FILE *f = fopen(argv[i], "rb");
    fseek(f, 0, SEEK_END);
    int n = (int)ftell(f);
    fseek(f, 0, SEEK_SET);
    unsigned char *buf = calloc(n, 1);
    if (fread(buf, 1, n, f) != (size_t)n) return 2;
    fclose(f);
    int w = rd16(buf + 4), h = rd16(buf + 6);
    int clen = n - 86;
    unsigned *words = calloc((clen + 3) / 4 + 4, 4);
    for (int k = 0; k < clen; k++) words[k / 4] |= (unsigned)buf[86 + k] << ((k % 4) * 8);
    unsigned sel = buf[44], map = buf[45], adv = buf[47], m420 = buf[55];
    if (clen > 0) decode_ext((unsigned long *)words, clen, fb, w, h, m420, sel, sel, adv, adv, map);
    fwrite(&w, 4, 1, out);
    fwrite(&h, 4, 1, out);
    fwrite(fb, 4, (size_t)w * h, out);
    free(words);
    free(buf);
    (void)rd32;
  }
  fclose(out);
  return 0;
}
