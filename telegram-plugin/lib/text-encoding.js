const WINDOWS_1252_BYTES = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
  [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f]
]);

function windows1252Byte(character) {
  const codePoint = character.codePointAt(0);
  if (codePoint <= 0xff) return codePoint;
  return WINDOWS_1252_BYTES.get(codePoint) ?? null;
}

function utf8SequenceLength(firstByte) {
  if (firstByte >= 0xc2 && firstByte <= 0xdf) return 2;
  if (firstByte >= 0xe0 && firstByte <= 0xef) return 3;
  if (firstByte >= 0xf0 && firstByte <= 0xf4) return 4;
  return 0;
}

function decodeMojibakePass(value) {
  const characters = Array.from(value);
  let changed = false;
  let output = "";

  for (let index = 0; index < characters.length;) {
    const firstByte = windows1252Byte(characters[index]);
    const length = firstByte == null ? 0 : utf8SequenceLength(firstByte);
    if (!length || index + length > characters.length) {
      output += characters[index++];
      continue;
    }

    const bytes = [firstByte];
    let valid = true;
    for (let offset = 1; offset < length; offset++) {
      const byte = windows1252Byte(characters[index + offset]);
      if (byte == null || byte < 0x80 || byte > 0xbf) {
        valid = false;
        break;
      }
      bytes.push(byte);
    }
    if (!valid) {
      output += characters[index++];
      continue;
    }

    const decoded = Buffer.from(bytes).toString("utf8");
    const roundTrip = Buffer.from(decoded, "utf8");
    if (decoded.includes("\uFFFD") || !roundTrip.equals(Buffer.from(bytes))) {
      output += characters[index++];
      continue;
    }

    output += decoded;
    index += length;
    changed = true;
  }

  return changed ? output : value;
}

export function repairMojibake(value) {
  let current = String(value ?? "");
  for (let pass = 0; pass < 3; pass++) {
    const repaired = decodeMojibakePass(current);
    if (repaired === current) break;
    current = repaired;
  }
  return current.normalize("NFC");
}
