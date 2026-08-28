import { routeAgentRequest } from "agents";

export {
  TestVoiceAgent,
  TestPersistentVoiceAgent,
  TestEmptyResponseVoiceAgent,
  TestContextVoiceAgent,
  TestAiSdkFullStreamVoiceAgent,
  TestAiSdkTextStreamVoiceAgent,
  TestPcm24kVoiceAgent,
  TestStreamingTtsVoiceAgent,
  TestMinInterruptVoiceAgent
} from "./agents/voice";

export {
  TestVoiceInputAgent,
  TestRejectCallVoiceInputAgent
} from "./agents/voice-input";

export {
  TestSFUVoiceAgent,
  TestSFUTransportVoiceAgent,
  TestMissingSFUConfigAgent
} from "./agents/sfu-voice";

export type Env = {
  TestVoiceAgent: DurableObjectNamespace;
  TestPersistentVoiceAgent: DurableObjectNamespace;
  TestEmptyResponseVoiceAgent: DurableObjectNamespace;
  TestContextVoiceAgent: DurableObjectNamespace;
  TestAiSdkFullStreamVoiceAgent: DurableObjectNamespace;
  TestAiSdkTextStreamVoiceAgent: DurableObjectNamespace;
  TestPcm24kVoiceAgent: DurableObjectNamespace;
  TestStreamingTtsVoiceAgent: DurableObjectNamespace;
  TestMinInterruptVoiceAgent: DurableObjectNamespace;
  TestVoiceInputAgent: DurableObjectNamespace;
  TestSFUVoiceAgent: DurableObjectNamespace;
  TestSFUTransportVoiceAgent: DurableObjectNamespace;
  TestMissingSFUConfigAgent: DurableObjectNamespace;
};

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
