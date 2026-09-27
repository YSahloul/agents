import { Think } from "@cloudflare/think";
import { TextStreamCallback } from "@cloudflare/think/messengers";
import { getAgentByName } from "agents";

const MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const TAVUS_API = "https://tavusapi.com/v2";
const ANAM_API = "https://api.anam.ai/v1";
const THINK_SESSION_PATTERN =
  /<think-session>([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})<\/think-session>/i;
const encoder = new TextEncoder();

type ChatMessage = {
  role: "assistant" | "system" | "user";
  content: string;
};

type ChatCompletionRequest = {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  user?: string;
};

type WorkerEnv = Env & {
  ANAM_API_KEY: string;
  ANAM_AVATAR_ID: string;
  ANAM_LLM_API_KEY: string;
  ANAM_LLM_ID: string;
  ANAM_VOICE_ID: string;
  TAVUS_API_KEY: string;
  TAVUS_LLM_API_KEY: string;
  TAVUS_PAL_ID: string;
};

export class TavusThinkAgent extends Think<Env> {
  override getModel() {
    return MODEL;
  }

  override getSystemPrompt() {
    return "You are speaking through a live AI avatar. Reply briefly, naturally, and with text that is easy to speak aloud.";
  }
}

function errorResponse(message: string, status: number): Response {
  return Response.json(
    {
      error: {
        message,
        type: status === 401 ? "authentication_error" : "invalid_request_error"
      }
    },
    { status }
  );
}

async function secureEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all(
    [left, right].map((value) =>
      crypto.subtle.digest("SHA-256", encoder.encode(value))
    )
  );
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index++) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

async function providerFor(
  request: Request,
  env: WorkerEnv
): Promise<"anam" | "tavus" | null> {
  const authorization = request.headers.get("authorization") ?? "";
  const [tavus, anam] = await Promise.all([
    env.TAVUS_LLM_API_KEY
      ? secureEqual(authorization, `Bearer ${env.TAVUS_LLM_API_KEY}`)
      : false,
    env.ANAM_LLM_API_KEY
      ? secureEqual(authorization, `Bearer ${env.ANAM_LLM_API_KEY}`)
      : false
  ]);
  return tavus ? "tavus" : anam ? "anam" : null;
}

function sse(data: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

function chunk(
  id: string,
  model: string,
  delta: { role?: "assistant"; content?: string },
  finishReason: "stop" | null = null
) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }]
  };
}

function latestUserMessage(messages: ChatMessage[] | undefined): string | null {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user" && typeof message.content === "string") {
      const content = message.content.trim();
      if (content) return content;
    }
  }
  return null;
}

function sessionFromContext(
  messages: ChatMessage[] | undefined
): string | null {
  if (!Array.isArray(messages)) return null;
  for (const message of messages) {
    if (message.role !== "system") continue;
    const match = THINK_SESSION_PATTERN.exec(message.content);
    if (match) return match[1];
  }
  return null;
}

async function tavusRequest(
  env: WorkerEnv,
  path: string,
  init: RequestInit
): Promise<Response> {
  const response = await fetch(`${TAVUS_API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.TAVUS_API_KEY
    }
  });
  return new Response(response.body, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("Content-Type") ?? "application/json"
    }
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (
      request.method === "POST" &&
      url.pathname === "/api/anam/session-token"
    ) {
      if (
        !env.ANAM_API_KEY ||
        !env.ANAM_AVATAR_ID ||
        !env.ANAM_LLM_API_KEY ||
        !env.ANAM_VOICE_ID ||
        !env.ANAM_LLM_ID
      ) {
        return Response.json(
          {
            error:
              "ANAM_API_KEY, ANAM_AVATAR_ID, ANAM_LLM_API_KEY, ANAM_LLM_ID, and ANAM_VOICE_ID must be configured"
          },
          { status: 500 }
        );
      }
      const session = crypto.randomUUID();
      try {
        const response = await fetch(`${ANAM_API}/auth/session-token`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.ANAM_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            personaConfig: {
              name: "Anam Think",
              avatarId: env.ANAM_AVATAR_ID,
              avatarModel: "cara-4",
              voiceId: env.ANAM_VOICE_ID,
              llmId: env.ANAM_LLM_ID,
              systemPrompt: `You are speaking through a live AI avatar. Reply briefly and naturally. <think-session>${session}</think-session>`
            }
          })
        });
        return new Response(response.body, {
          status: response.status,
          headers: {
            "Content-Type":
              response.headers.get("Content-Type") ?? "application/json"
          }
        });
      } catch {
        return Response.json(
          { error: "Could not reach the Anam API" },
          { status: 502 }
        );
      }
    }

    if (request.method === "POST" && url.pathname === "/api/conversations") {
      if (!env.TAVUS_API_KEY || !env.TAVUS_PAL_ID) {
        return Response.json(
          { error: "TAVUS_API_KEY and TAVUS_PAL_ID must be configured" },
          { status: 500 }
        );
      }
      const session = crypto.randomUUID();
      try {
        return await tavusRequest(env, "/conversations", {
          method: "POST",
          body: JSON.stringify({
            pal_id: env.TAVUS_PAL_ID,
            conversation_name: "Tavus Think conversation",
            conversational_context: `<think-session>${session}</think-session>`
          })
        });
      } catch {
        return Response.json(
          { error: "Could not reach the Tavus API" },
          { status: 502 }
        );
      }
    }

    const endMatch = /^\/api\/conversations\/([A-Za-z0-9_-]+)\/end$/.exec(
      url.pathname
    );
    if (request.method === "POST" && endMatch) {
      if (!env.TAVUS_API_KEY) {
        return Response.json(
          { error: "TAVUS_API_KEY must be configured" },
          { status: 500 }
        );
      }
      try {
        return await tavusRequest(
          env,
          `/conversations/${encodeURIComponent(endMatch[1])}/end`,
          { method: "POST" }
        );
      } catch {
        return Response.json(
          { error: "Could not reach the Tavus API" },
          { status: 502 }
        );
      }
    }

    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({ status: "ok", model: MODEL });
    }

    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      return errorResponse("Not found", 404);
    }

    const provider = await providerFor(request, env);
    if (!provider) {
      return errorResponse("Invalid API key", 401);
    }

    let body: ChatCompletionRequest;
    try {
      body = await request.json<ChatCompletionRequest>();
    } catch {
      return errorResponse("Request body must be valid JSON", 400);
    }

    if (body.stream !== true) {
      return errorResponse("stream must be true", 400);
    }

    const text = latestUserMessage(body.messages);
    if (!text) {
      return errorResponse(
        "messages must contain a non-empty user message",
        400
      );
    }

    const session =
      sessionFromContext(body.messages) ??
      body.user?.trim() ??
      `probe-${crypto.randomUUID()}`;
    if (session.length > 128) {
      return errorResponse(
        "Think session marker or user must be at most 128 characters",
        400
      );
    }

    const agent = await getAgentByName(env.TavusThinkAgent, session);
    const callback = new TextStreamCallback();
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const model = body.model || "think";

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const turn = agent.chat(
          {
            id: crypto.randomUUID(),
            role: "user",
            parts: [{ type: "text", text }]
          },
          callback,
          { channel: provider }
        );
        void turn.catch((error: unknown) => callback.fail(error));

        try {
          controller.enqueue(sse(chunk(id, model, { role: "assistant" })));
          for await (const delta of callback.stream()) {
            controller.enqueue(sse(chunk(id, model, { content: delta })));
          }
          await turn;
          controller.enqueue(sse(chunk(id, model, {}, "stop")));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (error) {
          controller.enqueue(
            sse({
              error: {
                message:
                  error instanceof Error ? error.message : "Generation failed",
                type: "server_error"
              }
            })
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      },
      async cancel(reason) {
        const requestId = callback.requestId();
        if (requestId) {
          await agent.cancelChat(
            requestId,
            String(reason ?? "Client disconnected")
          );
        }
      }
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8"
      }
    });
  }
} satisfies ExportedHandler<WorkerEnv>;
