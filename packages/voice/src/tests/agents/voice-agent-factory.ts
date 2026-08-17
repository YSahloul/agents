import { Agent, type Connection } from "agents";
import { createVoiceAgent } from "../../voice-agent-factory";
import type { Transcriber, TranscriberSession, TTSProvider } from "../../types";

class StubTranscriberSession implements TranscriberSession {
  feed(_chunk: ArrayBuffer): void {}
  close(): void {}
}

class StubTranscriber implements Transcriber {
  createSession(): TranscriberSession {
    return new StubTranscriberSession();
  }
}

class StubTTS implements TTSProvider {
  async synthesize(_text: string): Promise<ArrayBuffer | null> {
    return null;
  }
}

export class TestVoiceAgentFactory extends createVoiceAgent(Agent, {
  stt: () => new StubTranscriber(),
  tts: () => new StubTTS(),
  greeting: "hi there"
}) {
  static options = { hibernate: false };
  speakCalls: Array<{ connectionId: string; text: string }> = [];

  async speak(connection: Connection, text: string) {
    this.speakCalls.push({ connectionId: connection.id, text });
  }
}
