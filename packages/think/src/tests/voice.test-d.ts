import type {
  StreamingTTSProvider,
  Transcriber,
  TTSProvider,
  VoiceTurnContext
} from "@cloudflare/voice";
import {
  createVoiceThink,
  voiceChannel,
  type CreateVoiceThinkOptions
} from "../voice";
import type { Think } from "../think";

type TestEnv = Cloudflare.Env & { AI: Ai };
declare const transcriber: Transcriber;
declare const tts: TTSProvider & Partial<StreamingTTSProvider>;

const options = {
  filterEchoedTranscripts: true,
  channel: "phone"
} satisfies CreateVoiceThinkOptions;
const VoiceThink = createVoiceThink<TestEnv>(options);

class Agent extends VoiceThink {
  configureChannels() {
    return {
      phone: voiceChannel({
        transcriber,
        tts,
        instructions: "Keep it short."
      })
    };
  }

  getModel() {
    return "@cf/meta/llama-3.1-8b-instruct";
  }

  async onTurn(_transcript: string, _context: VoiceTurnContext) {
    return "hello";
  }
}

const agent = null! as InstanceType<typeof Agent>;
const think: Think<TestEnv> = agent;
const transcriberMember: Transcriber | undefined = agent.transcriber;
const ttsMember: TTSProvider | undefined = agent.tts;
void think;
void transcriberMember;
void ttsMember;

// @ts-expect-error Think-backed Voice always owns persistence through Session.
const persisted: CreateVoiceThinkOptions = { persistMessages: true };
void persisted;

// @ts-expect-error voiceChannel requires a transcriber.
voiceChannel({ tts });

// @ts-expect-error voiceChannel requires tts.
voiceChannel({ transcriber });
