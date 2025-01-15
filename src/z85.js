const ENCODE = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#";
const DECODE = [-1, 68, -1, 84, 83, 82, 72, -1, 75, 76, 70, 65, -1, 63, 62, 69, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 64, -1, 73, 66, 74, 71, 81, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 77, -1, 78, 67, -1, -1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 79, -1, 80, -1, -1];
const POW_85 = [0, 1, 85, 7225, 614125, 52200625];
const POW_256 = [1, 256, 65536, 16777216];

/**
 * Encodes binary data into a Z85 string.
 * @param {ArrayBuffer} data - The binary data to encode
 * @returns {string} The Z85 encoded string
 */
export function encode85(data) {
  const dv = new DataView(data);
  const length = dv.byteLength;
  const padding = (4 - (length % 4)) % 4;

  let result = '', value = 0;
  for (let i = 0; i < length + padding; ++i) {
    const isPadding = i >= length;
    value = value * 256 + (isPadding ? 0 : dv.getUint8(i));
    if ((i + 1) % 4 === 0) {
      for (let j = 5; j > 0; --j) {
        if (isPadding && j <= padding)
          continue;

        result += ENCODE[Math.floor(value / POW_85[j]) % 85];
      }
      value = 0;
    }
  }

  return result;
};

/**
 * Decodes a Z85 string into binary data.
 * @param {string} string - The Z85 encoded string
 * @returns {ArrayBuffer} The decoded binary data
 */
export function decode85(string) {
  const remainder = string.length % 5;
  const padding = 5 - (remainder === 0 ? 5 : remainder);
  string = string.padEnd(string.length + padding, ENCODE[ENCODE.length - 1]);
  const length = string.length;

  let buffer = new Uint8Array((length * 4 / 5) - padding);
  let value = 0, char = 0, byte = 0;
  for (let i = 0; i < length; ++i) {
    value = value * 85 + DECODE[string.charCodeAt(char++) - 32];
    if (char % 5 !== 0) continue;

    for (let j = 3; j >= 0; --j)
      buffer[byte++] = Math.floor(value / POW_256[j]) % 256;
    value = 0;
  }

  return buffer.buffer;
}
