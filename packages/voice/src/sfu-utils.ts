/**
 * Pure utility functions for the Cloudflare Realtime SFU integration.
 *
 * Extracted from sfu.ts for testability. These handle:
 * - Protobuf varint encoding/decoding
 * - SFU WebSocket adapter protobuf packet encoding/decoding
 * - Audio format conversion (48kHz stereo ↔ 16kHz mono)
 */

// --- Protobuf helpers ---
// The SFU WebSocket adapter uses a simple protobuf message:
//   message Packet {
//     uint32 sequenceNumber = 1;
//     uint32 timestamp = 2;
//     bytes payload = 5;
//   }

export function decodeVarint(
  buf: Uint8Array,
  offset: number
): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;
  while (offset + bytesRead < buf.length) {
    const byte = buf[offset + bytesRead];
    value |= (byte & 0x7f) << shift;
    bytesRead++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value, bytesRead };
}

function readVarint(
  buf: Uint8Array,
  offset: number
): { value: number; bytesRead: number } | null {
  let value = 0;
  for (
    let bytesRead = 0;
    bytesRead < 5 && offset + bytesRead < buf.length;
    bytesRead++
  ) {
    const byte = buf[offset + bytesRead];
    value |= (byte & 0x7f) << (bytesRead * 7);
    if ((byte & 0x80) === 0) {
      return { value: value >>> 0, bytesRead: bytesRead + 1 };
    }
  }
  return null;
}

export function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7f);
  return new Uint8Array(bytes);
}

/** Extract the PCM payload from a protobuf Packet message. */
export function extractPayloadFromProtobuf(
  data: ArrayBuffer
): Uint8Array | null {
  const buf = new Uint8Array(data);
  let offset = 0;

  while (offset < buf.length) {
    const tag = readVarint(buf, offset);
    if (!tag) return null;
    offset += tag.bytesRead;

    const fieldNumber = tag.value >>> 3;
    const wireType = tag.value & 0x07;

    if (wireType === 0) {
      const value = readVarint(buf, offset);
      if (!value) return null;
      offset += value.bytesRead;
      continue;
    }

    if (wireType !== 2) return null;

    const length = readVarint(buf, offset);
    if (!length) return null;
    offset += length.bytesRead;
    if (length.value > buf.length - offset) return null;

    if (fieldNumber === 5) {
      return buf.slice(offset, offset + length.value);
    }
    offset += length.value;
  }

  return null;
}

/** Encode PCM payload into a protobuf Packet message (for ingest/buffer mode — just payload). */
export function encodePayloadToProtobuf(payload: Uint8Array): ArrayBuffer {
  // Field 5, wire type 2 (length-delimited): tag = (5 << 3) | 2 = 42
  const tagBytes = encodeVarint(42);
  const lengthBytes = encodeVarint(payload.length);

  const result = new Uint8Array(
    tagBytes.length + lengthBytes.length + payload.length
  );
  result.set(tagBytes, 0);
  result.set(lengthBytes, tagBytes.length);
  result.set(payload, tagBytes.length + lengthBytes.length);

  return result.buffer;
}

// --- Audio conversion ---

function alignedInt16(input: ArrayBuffer | Uint8Array): Int16Array {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const copy = bytes.slice(0, bytes.byteLength - (bytes.byteLength % 2));
  return new Int16Array(copy.buffer);
}

function resampleLinear(
  input: Int16Array,
  fromRate: number,
  toRate: number
): Int16Array {
  if (input.length === 0) return new Int16Array();
  const outputLength = Math.floor((input.length * toRate) / fromRate);
  const output = new Int16Array(outputLength);
  const ratio = fromRate / toRate;

  for (let i = 0; i < outputLength; i++) {
    const sourceIndex = i * ratio;
    const low = Math.floor(sourceIndex);
    const high = Math.min(low + 1, input.length - 1);
    const fraction = sourceIndex - low;
    output[i] = Math.round(
      input[low] * (1 - fraction) + input[high] * fraction
    );
  }
  return output;
}

/** Convert mono PCM16 at an arbitrary sample rate to 48kHz stereo PCM16. */
export function resampleMonoTo48kStereo(
  input: ArrayBuffer,
  inputSampleRate: number
): Uint8Array {
  const mono48k = resampleLinear(alignedInt16(input), inputSampleRate, 48000);
  const stereo = new Int16Array(mono48k.length * 2);
  for (let i = 0; i < mono48k.length; i++) {
    stereo[i * 2] = mono48k[i];
    stereo[i * 2 + 1] = mono48k[i];
  }
  return new Uint8Array(stereo.buffer);
}

/** Downsample 48kHz stereo interleaved PCM to 16kHz mono PCM (both 16-bit LE). */
export function downsample48kStereoTo16kMono(
  stereo48k: Uint8Array
): ArrayBuffer {
  const stereo = alignedInt16(stereo48k);
  const mono48k = new Int16Array(Math.floor(stereo.length / 2));
  for (let i = 0; i < mono48k.length; i++) {
    mono48k[i] = Math.round((stereo[i * 2] + stereo[i * 2 + 1]) / 2);
  }
  const samples = resampleLinear(mono48k, 48000, 16000);
  const output = new Uint8Array(samples.byteLength);
  output.set(new Uint8Array(samples.buffer));
  return output.buffer;
}

/** Upsample 16kHz mono PCM to 48kHz stereo interleaved PCM (both 16-bit LE). */
export function upsample16kMonoTo48kStereo(mono16k: ArrayBuffer): Uint8Array {
  return resampleMonoTo48kStereo(mono16k, 16000);
}

/** Resample 24kHz mono PCM to 48kHz stereo interleaved PCM (both 16-bit LE). */
export function resample24kMonoTo48kStereo(mono24k: ArrayBuffer): Uint8Array {
  return resampleMonoTo48kStereo(mono24k, 24000);
}

// --- SFU API helpers ---

export interface SFUConfig {
  appId: string;
  apiToken: string;
  apiBase?: string;
}

const DEFAULT_SFU_API_BASE = "https://rtc.live.cloudflare.com/v1";

type SFUMethod = "POST" | "PUT";

async function requestSFU(
  config: SFUConfig,
  operation: string,
  path: string,
  method: SFUMethod,
  body?: unknown
): Promise<unknown> {
  const response = await fetch(
    `${config.apiBase ?? DEFAULT_SFU_API_BASE}/apps/${config.appId}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    }
  );
  if (!response.ok) {
    throw new Error(
      `SFU ${operation} failed (${response.status}): ${await response.text()}`
    );
  }
  return response.json() as Promise<unknown>;
}

export function sfuFetch(
  config: SFUConfig,
  path: string,
  body: unknown
): Promise<unknown> {
  return requestSFU(config, "request", path, "POST", body);
}

export async function createSFUSession(
  config: SFUConfig
): Promise<{ sessionId: string }> {
  const result = await requestSFU(
    config,
    "create session",
    "/sessions/new",
    "POST"
  );
  if (
    typeof result !== "object" ||
    result === null ||
    !("sessionId" in result) ||
    typeof result.sessionId !== "string"
  ) {
    throw new Error("SFU create session response missing sessionId");
  }
  return { sessionId: result.sessionId };
}

export function addSFUTracks(
  config: SFUConfig,
  sessionId: string,
  body: unknown
): Promise<unknown> {
  return requestSFU(
    config,
    "add tracks",
    `/sessions/${sessionId}/tracks/new`,
    "POST",
    body
  );
}

export async function renegotiateSFUSession(
  config: SFUConfig,
  sessionId: string,
  sdp: string
): Promise<unknown> {
  const result = await requestSFU(
    config,
    "renegotiate session",
    `/sessions/${sessionId}/renegotiate`,
    "PUT",
    { sessionDescription: { type: "offer", sdp } }
  );
  if (
    typeof result !== "object" ||
    result === null ||
    !("sessionDescription" in result) ||
    typeof result.sessionDescription !== "object" ||
    result.sessionDescription === null ||
    !("sdp" in result.sessionDescription) ||
    typeof result.sessionDescription.sdp !== "string"
  ) {
    throw new Error(
      "SFU renegotiate session response missing sessionDescription.sdp"
    );
  }
  return result;
}

export function createSFUWebSocketAdapter(
  config: SFUConfig,
  tracks: unknown[]
): Promise<unknown> {
  return requestSFU(
    config,
    "create WebSocket adapter",
    "/adapters/websocket/new",
    "POST",
    { tracks }
  );
}

export async function closeSFUWebSocketAdapter(
  config: SFUConfig,
  adapterId: string
): Promise<{ alreadyClosed: boolean }> {
  const response = await fetch(
    `${config.apiBase ?? DEFAULT_SFU_API_BASE}/apps/${config.appId}/adapters/websocket/close`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ tracks: [{ adapterId }] })
    }
  );
  const text = await response.text();
  if (response.ok) return { alreadyClosed: false };

  if (response.status === 503) {
    try {
      const result: unknown = JSON.parse(text);
      if (
        typeof result === "object" &&
        result !== null &&
        "tracks" in result &&
        Array.isArray(result.tracks) &&
        typeof result.tracks[0] === "object" &&
        result.tracks[0] !== null &&
        "errorCode" in result.tracks[0] &&
        result.tracks[0].errorCode === "adapter_not_found"
      ) {
        return { alreadyClosed: true };
      }
    } catch {}
  }

  throw new Error(
    `SFU close WebSocket adapter failed (${response.status}): ${text}`
  );
}
