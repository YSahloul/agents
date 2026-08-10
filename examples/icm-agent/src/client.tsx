import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { UIMessage } from "ai";
import { Button, InputArea } from "@cloudflare/kumo";
import {
  PaperPlaneRightIcon,
  StopIcon,
  SparkleIcon,
  PlusIcon
} from "@phosphor-icons/react";
import { Streamdown } from "streamdown";

const STORAGE_KEY = "studio-user-id";

function getUserId(): string {
  if (typeof window === "undefined") return "default";
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) return stored;
  const id = crypto.randomUUID();
  localStorage.setItem(STORAGE_KEY, id);
  return id;
}

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { type: "text"; text: string }).text)
    .join("");
}

const STARTERS = [
  "Make a short video explaining why caching is hard",
  "Explain how DNS works in under a minute",
  "A 30s video about what an API actually is",
  "Show why passwords should be long, not complex"
];

function Studio() {
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const agent = useAgent({
    agent: "ICMAgent",
    name: getUserId(),
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), [])
  });

  const { messages, sendMessage, clearHistory, stop, status } = useAgentChat({
    agent
  });

  const isStreaming = status === "streaming";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(
    (text?: string) => {
      const value = (text ?? input).trim();
      if (!value || isStreaming) return;
      setInput("");
      sendMessage({ role: "user", parts: [{ type: "text", text: value }] });
    },
    [input, isStreaming, sendMessage]
  );

  const empty = messages.length === 0;

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      {/* Header */}
      <header className="px-6 py-4 bg-kumo-base border-b border-kumo-line flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="size-8 rounded-xl bg-kumo-accent flex items-center justify-center">
            <SparkleIcon size={18} weight="fill" className="text-white" />
          </div>
          <h1 className="text-lg font-semibold text-kumo-default">
            Animation Studio
          </h1>
        </div>
        {!empty && (
          <Button
            variant="ghost"
            icon={<PlusIcon size={16} />}
            onClick={clearHistory}
          >
            New video
          </Button>
        )}
      </header>

      {/* Conversation */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-5 py-8">
          {empty ? (
            <div className="flex flex-col items-center text-center pt-16">
              <div className="size-14 rounded-2xl bg-kumo-accent flex items-center justify-center mb-5">
                <SparkleIcon size={28} weight="fill" className="text-white" />
              </div>
              <h2 className="text-2xl font-semibold text-kumo-default mb-2">
                What should we make?
              </h2>
              <p className="text-kumo-subtle max-w-md mb-8">
                Tell me an idea and I'll turn it into a short animated video.
                We'll shape it together, step by step.
              </p>
              <div className="grid sm:grid-cols-2 gap-2.5 w-full">
                {STARTERS.map((s) => (
                  <button
                    type="button"
                    key={s}
                    onClick={() => send(s)}
                    disabled={!connected}
                    className="text-left text-sm text-kumo-default px-4 py-3 rounded-xl border border-kumo-line bg-kumo-base hover:border-kumo-accent hover:bg-kumo-elevated transition-colors disabled:opacity-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              {messages.map((message, index) => {
                const isUser = message.role === "user";
                const isLastAssistant =
                  message.role === "assistant" &&
                  index === messages.length - 1;

                if (isUser) {
                  return (
                    <div key={message.id} className="flex justify-end">
                      <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-accent text-white leading-relaxed">
                        {getMessageText(message)}
                      </div>
                    </div>
                  );
                }

                const text = getMessageText(message);
                if (!text) {
                  // Assistant is working in the background; show a subtle pulse
                  // instead of exposing tool calls / file reads.
                  return (
                    <div key={message.id} className="flex justify-start">
                      <div className="flex items-center gap-1.5 px-4 py-3">
                        <span className="size-2 rounded-full bg-kumo-accent animate-pulse" />
                        <span
                          className="size-2 rounded-full bg-kumo-accent animate-pulse"
                          style={{ animationDelay: "0.2s" }}
                        />
                        <span
                          className="size-2 rounded-full bg-kumo-accent animate-pulse"
                          style={{ animationDelay: "0.4s" }}
                        />
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={message.id} className="flex justify-start">
                    <div className="max-w-[90%] px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                      <Streamdown
                        className="sd-theme"
                        controls={false}
                        isAnimating={isLastAssistant && isStreaming}
                      >
                        {text}
                      </Streamdown>
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="border-t border-kumo-line bg-kumo-base">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="max-w-2xl mx-auto px-5 py-4"
        >
          <div className="flex items-end gap-3 rounded-2xl border border-kumo-line bg-kumo-base p-2.5 pl-4 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring transition-shadow">
            <InputArea
              value={input}
              onValueChange={setInput}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Describe the video you want to make..."
              disabled={!connected || isStreaming}
              rows={1}
              className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none"
            />
            {isStreaming ? (
              <Button
                type="button"
                variant="secondary"
                shape="square"
                aria-label="Stop"
                onClick={stop}
                icon={<StopIcon size={18} weight="fill" />}
              />
            ) : (
              <Button
                type="submit"
                variant="primary"
                shape="square"
                aria-label="Send"
                disabled={!input.trim() || !connected}
                icon={<PaperPlaneRightIcon size={18} />}
              />
            )}
          </div>
          <p className="text-center text-[11px] text-kumo-inactive mt-2">
            {connected ? "Ready" : "Connecting..."}
          </p>
        </form>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen text-kumo-inactive">
          Loading...
        </div>
      }
    >
      <Studio />
    </Suspense>
  );
}
