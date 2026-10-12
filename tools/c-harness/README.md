# ASPEED C differential harness (development only)

Builds ASPEED's own decoder (`aspeed_codec`, MPL-2.0; the hitsc-maintained copy that
adds VQ support and fixes an IDCT shortcut bug) natively, so `src/video/decoder.ts`
in its default mode can be compared against the SoC vendor's implementation.
Sources are read from the directory named by `OJV_ASPEED_CODEC` (a local checkout's
`src/`); nothing here is shipped. Built automatically by `tests/decoder.aspeed.test.ts`
into `build/` (gitignored).
