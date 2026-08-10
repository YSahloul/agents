/** SignalWire PCMU/8 kHz ↔ VoiceAgent PCM16/16 kHz conversion. */

function base64ToUint8Array(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

const MULAW_DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const mu = ~i & 0xff;
  const sign = mu & 0x80;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  MULAW_DECODE_TABLE[i] = sign ? -sample : sample;
}

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

function encodeMulaw(value: number): number {
  const sign = value < 0 ? 0x80 : 0;
  let sample = Math.min(Math.abs(value), MULAW_CLIP) + MULAW_BIAS;
  let exponent = 7;
  for (; exponent > 0; exponent--) {
    if (sample & 0x4000) break;
    sample <<= 1;
  }
  const mantissa = (sample >> 10) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function resample(
  input: Int16Array,
  fromRate: number,
  toRate: number
): Int16Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const output = new Int16Array(Math.floor(input.length / ratio));
  for (let i = 0; i < output.length; i++) {
    const source = i * ratio;
    const index = Math.floor(source);
    const fraction = source - index;
    const first = input[index] ?? 0;
    const second = input[Math.min(index + 1, input.length - 1)] ?? 0;
    output[i] = Math.round(first + fraction * (second - first));
  }
  return output;
}

export function signalWireMulawToPcm16(
  payload: string,
  sampleRate = 16000
): Int16Array {
  const mulaw = base64ToUint8Array(payload);
  const pcm8k = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++)
    pcm8k[i] = MULAW_DECODE_TABLE[mulaw[i]];
  return resample(pcm8k, 8000, sampleRate);
}

export function pcm16ToSignalWireMulaw(
  pcm: Int16Array,
  sampleRate = 16000
): string {
  const pcm8k = resample(pcm, sampleRate, 8000);
  const mulaw = new Uint8Array(pcm8k.length);
  for (let i = 0; i < pcm8k.length; i++) mulaw[i] = encodeMulaw(pcm8k[i]);
  return arrayBufferToBase64(mulaw.buffer as ArrayBuffer);
}

export function meanSquaredEnergy(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return sum / pcm.length;
}
