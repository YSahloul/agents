import { routeAgentRequest } from "agents";

export {
  TestVoiceAgent,
  TestEmptyResponseVoiceAgent,
  TestContextVoiceAgent,
  TestAiSdkFullStreamVoiceAgent,
  TestAiSdkTextStreamVoiceAgent,
  TestPcm24kVoiceAgent
} from "./agents/voice";

export {
  TestVoiceInputAgent,
  TestRejectCallVoiceInputAgent
} from "./agents/voice-input";

export type Env = {
  TestVoiceAgent: DurableObjectNamespace;
  TestEmptyResponseVoiceAgent: DurableObjectNamespace;
  TestContextVoiceAgent: DurableObjectNamespace;
  TestAiSdkFullStreamVoiceAgent: DurableObjectNamespace;
  TestAiSdkTextStreamVoiceAgent: DurableObjectNamespace;
  TestPcm24kVoiceAgent: DurableObjectNamespace;
  TestStreamingTtsVoiceAgent: DurableObjectNamespace;
  TestVoiceInputAgent: DurableObjectNamespace;
  TestRejectCallVoiceInputAgent: DurableObjectNamespace;
  TestSFUVoiceAgent: DurableObjectNamespace;
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
