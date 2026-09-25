/**
 * Newer macOS versions often leave `message.text` NULL and store the body only in
 * `message.attributedBody`, an NSArchiver "typedstream" of an NSAttributedString.
 * We don't need a full typedstream parser: the plain string follows the first
 * "NSString" class marker as a length-prefixed UTF-8 blob.
 */
export function decodeAttributedBody(blob: Uint8Array | null | undefined): string | null {
  if (!blob || blob.length === 0) return null;
  const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const marker = buf.indexOf("NSString");
  if (marker < 0) return null;
  // Skip "NSString" + 5 bytes of class/version preamble (01 94 84 01 2B).
  let i = marker + "NSString".length + 5;
  if (i >= buf.length) return null;
  let len: number;
  const lead = buf[i];
  if (lead === 0x81) {
    len = buf.readUInt16LE(i + 1);
    i += 3;
  } else if (lead === 0x82) {
    len = buf.readUInt32LE(i + 1);
    i += 5;
  } else {
    len = lead;
    i += 1;
  }
  if (len <= 0 || i + len > buf.length) return null;
  return buf.subarray(i, i + len).toString("utf8");
}

/** Build a minimal attributedBody-like blob (used by tests). */
export function encodeAttributedBodyForTest(text: string): Uint8Array {
  const body = Buffer.from(text, "utf8");
  let lenBytes: Buffer;
  if (body.length < 0x80) lenBytes = Buffer.from([body.length]);
  else {
    lenBytes = Buffer.alloc(3);
    lenBytes[0] = 0x81;
    lenBytes.writeUInt16LE(body.length, 1);
  }
  return Buffer.concat([
    Buffer.from([0x04, 0x0b]),
    Buffer.from("streamtyped"),
    Buffer.from([0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84]),
    Buffer.from("NSMutableAttributedString"),
    Buffer.from([0x00, 0x84, 0x84]),
    Buffer.from("NSString"),
    Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]),
    lenBytes,
    body,
    Buffer.from([0x86, 0x84, 0x02, 0x69, 0x49]),
  ]);
}
