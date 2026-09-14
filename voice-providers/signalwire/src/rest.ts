export interface SignalWireRestConfig {
  spaceUrl: string;
  projectId: string;
  apiToken: string;
}

const authorization = (config: SignalWireRestConfig): string =>
  `Basic ${btoa(`${config.projectId}:${config.apiToken}`)}`;

const callsBaseUrl = (config: SignalWireRestConfig, callSid: string): string =>
  `https://${config.spaceUrl}/api/laml/2010-04-01/Accounts/${encodeURIComponent(config.projectId)}/Calls/${encodeURIComponent(callSid)}`;

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
