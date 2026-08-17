/** SignalWire bidirectional cXML Stream messages consumed by the adapter. */

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
    /** Nested `<Stream>` `<Parameter name="..." value="..."/>` children from cXML. */
    customParameters?: Record<string, string>;
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
