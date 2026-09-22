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

export function countTranscriptWords(transcript?: string): number {
  return transcript?.trim() ? transcript.trim().split(/\s+/).length : 0;
}
