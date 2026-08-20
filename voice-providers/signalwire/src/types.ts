/**
 * SignalWire bidirectional cXML Stream WebSocket message types.
 *
 * See https://docs.signalwire.com/reference/compatibility-api/cxml/connect/stream
 * for the full protocol. Only the messages the adapter consumes are typed
 * here.
 */

export interface SignalWireStartMessage {
  event: "start";
  start: {
    streamSid: string;
    callSid: string;
    tracks: string[];
    mediaFormat: {
      encoding: string;
      sampleRate: number;
      channels: number;
    };
  };
}

export interface SignalWireMediaMessage {
  event: "media";
  streamSid?: string;
  media: {
    track: string;
    payload: string;
  };
}

export interface SignalWireDtmfMessage {
  event: "dtmf";
  streamSid?: string;
  dtmf: {
    digit: string;
    duration?: number;
  };
}
