export function isEchoOf(transcript: string, assistantText: string): boolean {
  if (!assistantText) return false;
  const assistant =
    assistantText
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.join(" ") ?? "";
  const heard = transcript.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (heard.length >= 3 && assistant.includes(heard.join(" "))) return true;
  const assistantWords = new Set(assistant.split(" "));
  const hits = heard.filter((word) => assistantWords.has(word)).length;
  return hits >= 4 && hits / heard.length >= 0.6;
}

/**
 * What a listener heard of `text` once `playedBytes` of its `totalBytes` of audio have played,
 * for speech whose audio carries no word timing: the same share of its characters, cut back to a
 * whole word. While the total is unknown (audio still being synthesized), nothing counts as heard.
 */
export function heardText(
  text: string,
  playedBytes: number,
  totalBytes: number | undefined
): string {
  if (!totalBytes || playedBytes <= 0) return "";
  if (playedBytes >= totalBytes) return text;
  const cut = Math.floor((text.length * playedBytes) / totalBytes);
  return text.slice(0, Math.max(0, text.lastIndexOf(" ", cut))).trim();
}
