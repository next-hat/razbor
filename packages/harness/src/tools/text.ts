/**
 * Returns a UTF-8 prefix within the byte budget, omitting an incomplete trailing
 * character.
 */
export function textPrefix(text: string, maxBytes: number): string {
  // Streaming decode omits an incomplete final UTF-8 sequence.
  return new TextDecoder().decode(Buffer.from(text).subarray(0, maxBytes), {
    stream: true,
  });
}
