export interface SignalWireRestConfig {
  spaceUrl: string;
  projectId: string;
  apiToken: string;
}

export interface CreateOutboundCallOptions {
  from: string;
  to: string;
  url: string;
  statusCallback?: string;
  timeout?: number;
}

const authorization = (config: SignalWireRestConfig): string =>
  `Basic ${btoa(`${config.projectId}:${config.apiToken}`)}`;

const callsBaseUrl = (
  config: SignalWireRestConfig,
  callSid?: string
): string => {
  const base = `https://${config.spaceUrl}/api/laml/2010-04-01/Accounts/${encodeURIComponent(config.projectId)}/Calls`;
  return callSid ? `${base}/${encodeURIComponent(callSid)}` : base;
};
export async function createOutboundCall(
  config: SignalWireRestConfig,
  options: CreateOutboundCallOptions
): Promise<{ sid: string; status: string }> {
  const body = new URLSearchParams({
    From: options.from,
    To: options.to,
    Url: options.url,
    Method: "POST",
    ...(options.statusCallback
      ? {
          StatusCallback: options.statusCallback,
          StatusCallbackMethod: "POST",
          StatusCallbackEvent: "completed"
        }
      : {}),
    ...(options.timeout ? { Timeout: String(options.timeout) } : {})
  });
  const response = await fetch(callsBaseUrl(config), {
    method: "POST",
    headers: {
      Authorization: authorization(config),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body
  });
  if (!response.ok) {
    throw new Error(
      `SignalWire outbound call failed (${response.status}): ${await response.text()}`
    );
  }
  const result = (await response.json()) as {
    sid?: unknown;
    status?: unknown;
  };
  if (typeof result.sid !== "string" || !result.sid) {
    throw new Error(
      "SignalWire outbound call response did not include a Call SID"
    );
  }
  return {
    sid: result.sid,
    status: typeof result.status === "string" ? result.status : "queued"
  };
}

export async function startCallRecording(
  config: SignalWireRestConfig,
  callSid: string,
  statusCallbackUrl: string
): Promise<{ sid: string }> {
  const response = await fetch(`${callsBaseUrl(config, callSid)}/Recordings`, {
    method: "POST",
    headers: {
      Authorization: authorization(config),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: new URLSearchParams({
      RecordingChannels: "mono",
      RecordingTrack: "both",
      RecordingStatusCallback: statusCallbackUrl,
      RecordingStatusCallbackEvent: "completed absent",
      RecordingStatusCallbackMethod: "POST",
      Trim: "do-not-trim"
    })
  });
  if (!response.ok) {
    throw new Error(
      `SignalWire recording start failed (${response.status}): ${await response.text()}`
    );
  }
  const result = (await response.json()) as { sid?: unknown };
  if (typeof result.sid !== "string" || !result.sid) {
    throw new Error(
      "SignalWire recording start response did not include a Recording SID"
    );
  }
  return { sid: result.sid };
}

export async function redirectCall(
  config: SignalWireRestConfig,
  callSid: string,
  redirectUrl: string
): Promise<void> {
  const response = await fetch(callsBaseUrl(config, callSid), {
    method: "POST",
    headers: {
      Authorization: authorization(config),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ Url: redirectUrl, Method: "POST" })
  });
  if (!response.ok) {
    throw new Error(
      `SignalWire call redirect failed (${response.status}): ${await response.text()}`
    );
  }
}
