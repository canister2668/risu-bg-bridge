/**
 * UUIDv7 generation for client job ids (design §7: the client creates
 * clientJobId = UUIDv7() BEFORE submitting, so a lost creation response can
 * never orphan the job identity).
 *
 * Layout (RFC 9562): 48-bit big-endian unix millisecond prefix, version 7,
 * 12-bit rand_a, RFC variant, 62-bit rand_b. Time-ordered ids keep Pocket's
 * model-jobs journal and sqlite rows locally sortable, and the Pocket 1.10.0
 * server's id validation —
 * /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
 * — accepts version 7 and variants 8/9/a/b, so the same id works on every
 * verified transport in this kit.
 *
 * Randomness comes from Web Crypto (globalThis.crypto.getRandomValues):
 * plugin code runs in the RisuAI app's JS context where node:crypto is not
 * available. An injectable source keeps this deterministic under tests.
 */

export interface RandomSource {
  getRandomValues<T extends Uint8Array>(array: T): T;
}

export const UUID_V7_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const HEX = "0123456789abcdef";

/** Generates a canonical lowercase UUIDv7 string for the given unix ms. */
export function uuidv7(
  nowMs: number = Date.now(),
  randomSource: RandomSource = globalThis.crypto
): string {
  if (!Number.isFinite(nowMs) || nowMs < 0 || !Number.isInteger(nowMs)) {
    throw new RangeError(`uuidv7 requires an integer unix millisecond timestamp, got ${nowMs}`);
  }
  const bytes = new Uint8Array(16);
  randomSource.getRandomValues(bytes);

  // 48-bit big-endian unix_ms
  const ms = Math.floor(nowMs);
  bytes[0] = (ms / 2 ** 40) & 0xff;
  bytes[1] = (ms / 2 ** 32) & 0xff;
  bytes[2] = (ms / 2 ** 24) & 0xff;
  bytes[3] = (ms / 2 ** 16) & 0xff;
  bytes[4] = (ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;

  // version 7 in the high nibble of byte 6
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  // RFC 4122 variant (10xx) in the high bits of byte 8
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  let out = "";
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) out += "-";
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f];
  }
  return out;
}

/** True when the value satisfies the id acceptance shape every verified transport uses. */
export function isAcceptableClientJobId(value: unknown): value is string {
  return typeof value === "string" && UUID_V7_REGEX.test(value);
}