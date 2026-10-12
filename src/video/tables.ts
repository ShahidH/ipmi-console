/**
 * Lookup tables the decoder needs, computed from the standard JPEG tables in
 * tables-aspeed-mpl.ts: Huffman code lengths for fast decoding, and the zigzag
 * order's inverse.
 */
import { AC_CHR_NRCODES, AC_LUM_NRCODES, DC_CHR_NRCODES, DC_LUM_NRCODES } from './tables-aspeed-mpl';

export * from './tables-aspeed-mpl';

/**
 * Code-length lookup for a canonical Huffman table, as [threshold, length] pairs:
 * a 16-bit peek of the bitstream below `threshold` starts a code of `length`
 * bits. One pair per code, except that the longest length gets one pair with
 * threshold 65535, which also catches anything above the last code.
 */
function huffmanLengths(nrcodes: number[]): number[] {
  let longest = 0;
  for (let len = 1; len <= 16; len++) if (nrcodes[len]) longest = len;
  const out = [0, 0];
  let code = 0;
  for (let len = 1; len <= longest; len++) {
    if (len === longest) {
      out.push(65535, len);
      break;
    }
    for (let i = 0; i < nrcodes[len]; i++) out.push((++code) << (16 - len), len);
    code <<= 1;
  }
  return out;
}

export const DC_LUM_LENGTHS = huffmanLengths(DC_LUM_NRCODES);
export const DC_CHR_LENGTHS = huffmanLengths(DC_CHR_NRCODES);
export const AC_LUM_LENGTHS = huffmanLengths(AC_LUM_NRCODES);
export const AC_CHR_LENGTHS = huffmanLengths(AC_CHR_NRCODES);

