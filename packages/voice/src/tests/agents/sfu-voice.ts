import { Agent } from "agents";
import { withSFUVoice, withSFUVoiceTransport } from "../../sfu-voice";
import { withVoice } from "../../voice";
import type { SFUVoiceState } from "../../sfu-transport";
import type { SFUConfig } from "../../sfu-utils";

const SFUBase = withSFUVoice(Agent);
const SFUTransportBase = withSFUVoiceTransport(withVoice(Agent));

export class TestSFUVoiceAgent extends SFUBase {
  static options = { hibernate: false };
  configCalls = 0;
  fetchCalls = 0;
  onRequestCalls = 0;

  getSFUConfig(): SFUConfig {
    this.configCalls++;
    return { appId: "test-app", apiToken: "test-token" };
  }

  async fetch(_request: Request): Promise<Response> {
    this.fetchCalls++;
    return new Response("consumer fetch");
  }

  async onRequest(_request: Request): Promise<Response> {
    this.onRequestCalls++;
    return new Response("consumer request");
  }

  async getStoredSFUStateForTest(): Promise<SFUVoiceState | null> {
    return (
      (await this.ctx.storage.get<SFUVoiceState>("cf_voice_sfu_state")) ?? null
    );
  }
}
export class TestSFUTransportVoiceAgent extends SFUTransportBase {
  static options = { hibernate: false };

  getSFUConfig(): SFUConfig {
    return { appId: "test-app", apiToken: "test-token" };
  }
}

export class TestMissingSFUConfigAgent extends withSFUVoice(Agent) {
  static options = { hibernate: false };

  async getStoredSFUStateForTest(): Promise<SFUVoiceState | null> {
    return (
      (await this.ctx.storage.get<SFUVoiceState>("cf_voice_sfu_state")) ?? null
    );
  }
}
