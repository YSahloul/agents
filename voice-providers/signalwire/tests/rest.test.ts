import { afterEach, describe, expect, it, vi } from "vitest";
import { redirectCall, startCallRecording } from "../src/index.js";

afterEach(() => vi.unstubAllGlobals());

describe("SignalWire call control", () => {
  it("starts dual-leg recording with completion callbacks", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({ sid: "recording-sid-1" })
    );
    vi.stubGlobal("fetch", fetch);

    await expect(
      startCallRecording(
        {
          spaceUrl: "example.signalwire.com",
          projectId: "proj-1",
          apiToken: "tok-1"
        },
        "call-sid-1",
        "https://agenticflows.co/signalwire/recording-status?callSid=call-sid-1"
      )
    ).resolves.toEqual({ sid: "recording-sid-1" });

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(
      "https://example.signalwire.com/api/laml/2010-04-01/Accounts/proj-1/Calls/call-sid-1/Recordings"
    );
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("RecordingTrack")).toBe("both");
    expect(body.get("RecordingChannels")).toBe("mono");
    expect(body.get("RecordingStatusCallbackEvent")).toBe("completed absent");
    expect(body.get("RecordingStatusCallback")).toBe(
      "https://agenticflows.co/signalwire/recording-status?callSid=call-sid-1"
    );
  });

  it("redirects an active call through the Compatibility API", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response("{}", { status: 200 })
    );
    vi.stubGlobal("fetch", fetch);

    await redirectCall(
      {
        spaceUrl: "example.signalwire.com",
        projectId: "proj-1",
        apiToken: "tok-1"
      },
      "call-sid-1",
      "https://agenticflows.co/signalwire/transfer?to=%2B15551234567"
    );

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(
      "https://example.signalwire.com/api/laml/2010-04-01/Accounts/proj-1/Calls/call-sid-1"
    );
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      `Basic ${btoa("proj-1:tok-1")}`
    );
    expect(String(init?.body)).toBe(
      "Url=https%3A%2F%2Fagenticflows.co%2Fsignalwire%2Ftransfer%3Fto%3D%252B15551234567&Method=POST"
    );
  });

  it("surfaces rejected call-control responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_input: string | URL | Request, _init?: RequestInit) =>
          new Response("bad request", { status: 400 })
      )
    );

    await expect(
      redirectCall(
        {
          spaceUrl: "example.signalwire.com",
          projectId: "proj-1",
          apiToken: "tok-1"
        },
        "call-sid-1",
        "https://agenticflows.co/signalwire/transfer?to=%2B15551234567"
      )
    ).rejects.toThrow("SignalWire call redirect failed (400): bad request");
  });
});
