import { AnamEvent, createClient } from "@anam-ai/js-sdk";
import type { AnamClient } from "@anam-ai/js-sdk";
import { Button, PoweredByCloudflare, Surface, Text } from "@cloudflare/kumo";
import {
  MoonIcon,
  PhoneCallIcon,
  PhoneDisconnectIcon,
  SunIcon,
  VideoCameraIcon
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Conversation = {
  conversation_id: string;
  conversation_url: string;
};

type SessionToken = {
  sessionToken?: string;
};

function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") || "light"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);

  return (
    <Button
      variant="ghost"
      shape="square"
      aria-label="Toggle theme"
      onClick={() => setMode((value) => (value === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

async function responseError(response: Response): Promise<string> {
  const data: unknown = await response.json().catch(() => null);
  if (data && typeof data === "object") {
    if ("message" in data && typeof data.message === "string") {
      return data.message;
    }
    if ("error" in data) {
      const error = data.error;
      if (typeof error === "string") return error;
      if (
        error &&
        typeof error === "object" &&
        "message" in error &&
        typeof error.message === "string"
      ) {
        return error.message;
      }
    }
  }
  return `Request failed (${response.status})`;
}

function Shell({
  children,
  provider
}: {
  children: ReactNode;
  provider: "anam" | "tavus";
}) {
  return (
    <main className="min-h-full bg-kumo-base text-kumo-default">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-5 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-kumo-brand text-white">
              <VideoCameraIcon size={22} weight="fill" />
            </span>
            <div>
              <Text size="lg" bold>
                Avatar Think
              </Text>
              <span className="block">
                <Text size="xs" variant="secondary">
                  Two avatar providers, one persistent Cloudflare Think agent
                </Text>
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <nav aria-label="Avatar provider" className="flex gap-1">
              <Button
                variant={provider === "tavus" ? "secondary" : "ghost"}
                onClick={() => {
                  window.location.href = "/";
                }}
              >
                Tavus
              </Button>
              <Button
                variant={provider === "anam" ? "secondary" : "ghost"}
                onClick={() => {
                  window.location.href = "/anam";
                }}
              >
                Anam
              </Button>
            </nav>
            <ModeToggle />
          </div>
        </header>

        {children}

        <footer className="flex justify-center pb-2">
          <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
        </footer>
      </div>
    </main>
  );
}

function TavusPage() {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [pending, setPending] = useState<"start" | "end" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function startConversation() {
    setPending("start");
    setError(null);
    try {
      const response = await fetch("/api/conversations", { method: "POST" });
      if (!response.ok) throw new Error(await responseError(response));
      const next = await response.json<Conversation>();
      if (!next.conversation_id || !next.conversation_url) {
        throw new Error("Tavus returned an incomplete conversation");
      }
      setConversation(next);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not start the call"
      );
    } finally {
      setPending(null);
    }
  }

  async function endConversation() {
    if (!conversation) return;
    setPending("end");
    setError(null);
    try {
      const response = await fetch(
        `/api/conversations/${encodeURIComponent(conversation.conversation_id)}/end`,
        { method: "POST" }
      );
      if (!response.ok) throw new Error(await responseError(response));
      setConversation(null);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not end the call"
      );
    } finally {
      setPending(null);
    }
  }

  return (
    <Shell provider="tavus">
      <Surface className="rounded-xl p-4 ring ring-kumo-line">
        <div className="flex gap-3">
          <VideoCameraIcon
            size={20}
            weight="bold"
            className="mt-0.5 shrink-0 text-kumo-accent"
          />
          <div>
            <Text size="sm" bold>
              Tavus handles the face and voice. Think handles the conversation.
            </Text>
            <span className="mt-1 block">
              <Text size="xs" variant="secondary">
                Start a private Tavus conversation. API keys stay inside the
                Worker.
              </Text>
            </span>
          </div>
        </div>
      </Surface>

      <Surface className="flex min-h-[32rem] flex-1 flex-col overflow-hidden rounded-2xl ring ring-kumo-line">
        {conversation ? (
          <iframe
            className="min-h-[32rem] w-full flex-1 border-0 bg-black"
            src={conversation.conversation_url}
            title="Tavus avatar conversation"
            allow="camera; microphone; fullscreen; display-capture; autoplay"
            allowFullScreen
          />
        ) : (
          <StartPanel
            description="Your browser will ask for camera and microphone permission after Tavus joins."
            label={
              pending === "start" ? "Starting…" : "Start Tavus conversation"
            }
            onStart={startConversation}
            disabled={pending !== null}
          />
        )}
      </Surface>

      <CallStatus
        active={conversation !== null}
        error={error}
        pending={pending === "end"}
        onEnd={endConversation}
      />
    </Shell>
  );
}

function AnamPage() {
  const client = useRef<AnamClient | null>(null);
  const [active, setActive] = useState(false);
  const [pending, setPending] = useState<"start" | "end" | null>(null);
  const [caption, setCaption] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () => () => {
      const current = client.current;
      client.current = null;
      if (current) void current.stopStreaming();
    },
    []
  );

  async function startConversation() {
    setPending("start");
    setError(null);
    try {
      const response = await fetch("/api/anam/session-token", {
        method: "POST"
      });
      if (!response.ok) throw new Error(await responseError(response));
      const { sessionToken } = await response.json<SessionToken>();
      if (!sessionToken) throw new Error("Anam returned an incomplete session");

      const next = createClient(sessionToken);
      client.current = next;
      next.addListener(AnamEvent.CONNECTION_CLOSED, () => {
        client.current = null;
        setCaption("");
        setActive(false);
      });
      next.addListener(AnamEvent.MESSAGE_STREAM_EVENT_RECEIVED, (event) => {
        setCaption(event.content);
      });
      await next.streamToVideoElement("anam-persona-video");
      setActive(true);
    } catch (caught) {
      const current = client.current;
      client.current = null;
      if (current) await current.stopStreaming().catch(() => undefined);
      setError(
        caught instanceof Error ? caught.message : "Could not start the call"
      );
    } finally {
      setPending(null);
    }
  }

  async function endConversation() {
    const current = client.current;
    if (!current) return;
    setPending("end");
    setError(null);
    try {
      await current.stopStreaming();
      client.current = null;
      setCaption("");
      setActive(false);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not end the call"
      );
    } finally {
      setPending(null);
    }
  }

  return (
    <Shell provider="anam">
      <Surface className="rounded-xl p-4 ring ring-kumo-line">
        <div className="flex gap-3">
          <VideoCameraIcon
            size={20}
            weight="bold"
            className="mt-0.5 shrink-0 text-kumo-accent"
          />
          <div>
            <Text size="sm" bold>
              Anam handles the face and voice. The same Think agent handles the
              conversation.
            </Text>
            <span className="mt-1 block">
              <Text size="xs" variant="secondary">
                The Worker exchanges the Anam API key for a short-lived browser
                session token.
              </Text>
            </span>
          </div>
        </div>
      </Surface>

      <Surface className="relative flex min-h-[32rem] flex-1 flex-col overflow-hidden rounded-2xl bg-black ring ring-kumo-line">
        <video
          id="anam-persona-video"
          className={`min-h-[32rem] w-full flex-1 object-cover ${active ? "block" : "hidden"}`}
          autoPlay
          playsInline
        >
          <track
            kind="captions"
            src="data:text/vtt,WEBVTT%0A"
            srcLang="en"
            label="Live captions"
            default
          />
        </video>
        {caption ? (
          <div
            aria-live="polite"
            className="absolute inset-x-4 bottom-4 rounded-lg bg-black/80 px-4 py-3 text-center text-sm text-white"
          >
            {caption}
          </div>
        ) : null}
        {!active ? (
          <StartPanel
            description="Your browser will ask for microphone permission while Anam connects over WebRTC."
            label={
              pending === "start" ? "Connecting…" : "Start Anam conversation"
            }
            onStart={startConversation}
            disabled={pending !== null}
          />
        ) : null}
      </Surface>

      <CallStatus
        active={active}
        error={error}
        pending={pending === "end"}
        onEnd={endConversation}
      />
    </Shell>
  );
}

function StartPanel({
  description,
  disabled,
  label,
  onStart
}: {
  description: string;
  disabled: boolean;
  label: string;
  onStart: () => void;
}) {
  return (
    <div className="grid flex-1 place-items-center bg-kumo-base p-8 text-center">
      <div className="max-w-md">
        <span className="mx-auto mb-5 grid size-20 place-items-center rounded-full bg-kumo-elevated text-kumo-accent ring ring-kumo-line">
          <VideoCameraIcon size={38} weight="duotone" />
        </span>
        <Text size="lg" bold>
          Ready for a face-to-face conversation?
        </Text>
        <span className="mt-2 block">
          <Text size="sm" variant="secondary">
            {description}
          </Text>
        </span>
        <div className="mt-6 flex justify-center">
          <Button
            onClick={onStart}
            disabled={disabled}
            icon={<PhoneCallIcon size={18} weight="fill" />}
          >
            {label}
          </Button>
        </div>
      </div>
    </div>
  );
}

function CallStatus({
  active,
  error,
  onEnd,
  pending
}: {
  active: boolean;
  error: string | null;
  onEnd: () => void;
  pending: boolean;
}) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-4">
      <div aria-live="polite">
        {error ? (
          <Text size="sm" variant="error">
            {error}
          </Text>
        ) : active ? (
          <Text size="sm" variant="secondary">
            Conversation active
          </Text>
        ) : null}
      </div>
      {active ? (
        <Button
          variant="secondary"
          onClick={onEnd}
          disabled={pending}
          icon={<PhoneDisconnectIcon size={18} />}
        >
          {pending ? "Ending…" : "End conversation"}
        </Button>
      ) : null}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  window.location.pathname === "/anam" ? <AnamPage /> : <TavusPage />
);
