import {
  SFUVoiceAudioInput,
  useVoiceAgent,
  type VoiceStatus
} from "@cloudflare/voice/react";
import { useAgent, useAgentToolEvents } from "agents/react";
import type { AgentToolRunState } from "agents/chat";
import {
  MicrophoneIcon,
  MicrophoneSlashIcon,
  PhoneIcon,
  PhoneDisconnectIcon,
  WaveformIcon,
  SpinnerGapIcon,
  SpeakerHighIcon,
  ChatCircleDotsIcon,
  WifiHighIcon,
  WifiSlashIcon,
  WarningCircleIcon,
  UserSwitchIcon,
  PaperPlaneRightIcon,
  MoonIcon,
  SunIcon,
  RobotIcon
} from "@phosphor-icons/react";
import { Button, Input, Select, Surface, Text } from "@cloudflare/kumo";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

// --- Session ID ---
// Every page load gets a brand-new instance name, so each session hits a
// fresh Durable Object with no persisted conversation history. Nothing is
// stored in localStorage — a reload is a new session by design.

function getSessionId(): string {
  return crypto.randomUUID();
}

// --- Helpers ---

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function getStatusDisplay(status: VoiceStatus) {
  switch (status) {
    case "idle":
      return {
        text: "Ready",
        icon: PhoneIcon,
        color: "text-kumo-secondary"
      };
    case "listening":
      return {
        text: "Listening...",
        icon: WaveformIcon,
        color: "text-kumo-success"
      };
    case "thinking":
      return {
        text: "Thinking...",
        icon: SpinnerGapIcon,
        color: "text-kumo-warning"
      };
    case "speaking":
      return {
        text: "Speaking...",
        icon: SpeakerHighIcon,
        color: "text-kumo-info"
      };
  }
}

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
      onClick={() => setMode((m) => (m === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

// --- WebRTC voice app ---

type ModelOption = {
  id: string;
  reasoning: boolean;
};

// Fallback shown before / if the /models endpoint is unreachable. The API is
// the normal source; this just guarantees the picker is never empty.
const BASELINE_MODELS: ModelOption[] = [
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", reasoning: false },
  { id: "@cf/zai-org/glm-4.7-flash", reasoning: true },
  { id: "@cf/openai/gpt-oss-20b", reasoning: true },
  { id: "@cf/moonshotai/kimi-k2.7-code", reasoning: true }
];

type ReasoningEffort = "off" | "low" | "medium" | "high";

function getAudioOutputLabel(device: MediaDeviceInfo, index: number) {
  if (device.deviceId === "default") return "System default";
  if (device.deviceId === "communications") return "Communications default";
  return device.label || `Speaker ${index + 1}`;
}

function helperQuery(run: AgentToolRunState): string {
  let preview = run.inputPreview;
  if (typeof preview === "string") {
    const text = preview;
    try {
      preview = JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (
    preview &&
    typeof preview === "object" &&
    "query" in preview &&
    typeof preview.query === "string"
  ) {
    return preview.query;
  }
  return "Research task";
}

function helperStatus(run: AgentToolRunState): string {
  if (run.status === "completed") return "Done";
  if (run.status === "running") return run.progress?.message ?? "Working…";
  return run.error ?? run.status;
}

// --- Main App ---

function App() {
  const sessionId = useRef(getSessionId()).current;
  const thinkAgent = useAgent({
    agent: "my-think-agent",
    name: sessionId
  });
  const { runsByToolCallId } = useAgentToolEvents({ agent: thinkAgent });
  const helperRuns = useMemo(
    () => Object.values(runsByToolCallId).flat(),
    [runsByToolCallId]
  );
  const [models, setModels] = useState<ModelOption[]>(BASELINE_MODELS);
  const [llmModel, setLlmModel] = useState<string>(
    "@cf/moonshotai/kimi-k2.7-code"
  );
  const [reasoning, setReasoning] = useState<ReasoningEffort>("off");
  const [outputDeviceId, setOutputDeviceId] = useState("default");
  const audioInput = useMemo(
    () =>
      new SFUVoiceAudioInput({
        endpoint: `/agents/my-voice-agent/${encodeURIComponent(sessionId)}/voice`
      }),
    [sessionId]
  );

  const {
    status,
    transcript,
    interimTranscript,
    metrics,
    audioLevel,
    isMuted,
    connected,
    error,
    outputDeviceError,
    startCall,
    endCall,
    toggleMute,
    sendText,
    sendJSON,
    lastCustomMessage
  } = useVoiceAgent({
    agent: "my-voice-agent",
    name: sessionId,
    query: { llm: llmModel, reasoning },
    audioInput,
    outputDeviceId,
    onReconnect: () => {
      setToast("Reconnected to agent.");
    }
  });

  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const [textInput, setTextInput] = useState("");
  const [speakerConflict, setSpeakerConflict] = useState(false);
  const [kicked, setKicked] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [audioOutputDevices, setAudioOutputDevices] = useState<
    MediaDeviceInfo[]
  >([]);

  // Auto-clear toasts
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const refreshAudioOutputs = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;

    const devices = await navigator.mediaDevices.enumerateDevices();
    setAudioOutputDevices(
      devices.filter((device) => device.kind === "audiooutput")
    );
  }, []);

  useEffect(() => {
    refreshAudioOutputs().catch(() => {
      setToast("Could not list speakers for this browser.");
    });

    navigator.mediaDevices?.addEventListener(
      "devicechange",
      refreshAudioOutputs
    );
    return () => {
      navigator.mediaDevices?.removeEventListener(
        "devicechange",
        refreshAudioOutputs
      );
    };
  }, [refreshAudioOutputs]);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript, interimTranscript]);

  // Populate the model dropdown from the Worker's /models endpoint (backed by
  // env.AI.models()). Falls back to BASELINE_MODELS on any failure so the
  // picker is never empty.
  useEffect(() => {
    fetch("/models")
      .then((r) => (r.ok ? r.json() : Promise.resolve(null)))
      .then((data: unknown) => {
        if (Array.isArray(data) && data.length) {
          setModels(data as ModelOption[]);
        }
      })
      .catch(() => {});
  }, []);

  const handleStartCall = useCallback(async () => {
    await startCall();
    await refreshAudioOutputs().catch(() => {});
  }, [refreshAudioOutputs, startCall]);

  useEffect(() => {
    if (
      typeof lastCustomMessage !== "object" ||
      lastCustomMessage === null ||
      !("type" in lastCustomMessage)
    ) {
      return;
    }

    const message = lastCustomMessage as { type: string; message?: string };
    if (message.type === "speaker_conflict") {
      setSpeakerConflict(true);
    } else if (message.type === "kicked") {
      setKicked(true);
      setSpeakerConflict(false);
    } else if (message.type === "speaker_available") {
      setSpeakerConflict(false);
      setToast(message.message ?? "Speaker is available.");
    }
  }, [lastCustomMessage]);

  const handleKickSpeaker = useCallback(() => {
    sendJSON({ type: "kick_speaker" });
    setSpeakerConflict(false);
    setKicked(false);
    setToast("Attempting to take over as speaker...");
  }, [sendJSON]);

  const isInCall = status !== "idle";
  const statusDisplay = getStatusDisplay(status);
  const StatusIcon = statusDisplay.icon;

  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <Surface className="w-full max-w-lg rounded-2xl p-8 ring ring-kumo-line">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <ChatCircleDotsIcon
              size={28}
              weight="duotone"
              className="text-kumo-brand"
            />
            <Text variant="heading1" as="h1">
              Think Voice
            </Text>
          </div>
          <div className="flex items-center gap-3">
            {/* Connection status */}
            <span
              className={`flex items-center gap-1.5 text-xs ${connected ? "text-kumo-success" : "text-kumo-secondary"}`}
            >
              {connected ? (
                <WifiHighIcon size={14} weight="bold" />
              ) : (
                <WifiSlashIcon size={14} weight="bold" />
              )}
              {connected ? "Connected" : "Connecting..."}
            </span>
            <ModeToggle />
          </div>
        </div>

        <Surface className="mb-4 rounded-xl bg-kumo-fill px-4 py-3">
          <Text size="sm">
            Speak over WebRTC. Voice handles audio while Think owns the
            conversation, memory, and tools.
          </Text>
        </Surface>

        <div className="mb-4 flex items-center justify-between gap-3">
          <Text size="xs" variant="secondary">
            Run the same Researcher sub-agent used by the agents-as-tools
            example.
          </Text>
          <Button
            size="sm"
            variant="secondary"
            icon={<RobotIcon size={16} />}
            disabled={!connected || status === "thinking"}
            onClick={() =>
              sendText(
                "Delegate to the Researcher sub-agent: compare WebRTC voice and WebSocket voice in three concise bullets."
              )
            }
          >
            Try sub-agent
          </Button>
        </div>

        {helperRuns.length > 0 && (
          <Surface className="mb-4 rounded-xl p-4 ring ring-kumo-line">
            <div className="mb-3 flex items-center gap-2">
              <RobotIcon size={18} className="text-kumo-accent" />
              <Text size="sm" bold>
                Sub-agent activity
              </Text>
            </div>
            <div className="space-y-3">
              {helperRuns.map((run) => (
                <div key={run.runId} className="rounded-lg bg-kumo-fill p-3">
                  <div className="flex items-center justify-between gap-3">
                    <Text size="xs" bold>
                      {run.display?.name ?? run.agentType}
                    </Text>
                    <span className="flex items-center gap-1 text-xs text-kumo-secondary">
                      {run.status === "running" && (
                        <SpinnerGapIcon size={13} className="animate-spin" />
                      )}
                      {helperStatus(run)}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-kumo-secondary">
                    {helperQuery(run)}
                  </div>
                  {run.summary && (
                    <div className="mt-2 text-xs text-kumo-default">
                      {run.summary}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Surface>
        )}

        {/* Toast notification */}
        {toast && (
          <div className="mb-4 px-4 py-2.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-sm text-blue-600 dark:text-blue-400">
            {toast}
          </div>
        )}

        {/* Error banner */}
        {error && !speakerConflict && !kicked && (
          <div className="mb-4 px-4 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        {/* Speaker conflict banner */}
        {speakerConflict && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400 mb-2">
              <WarningCircleIcon size={16} weight="bold" />
              Another session is currently the active speaker.
            </div>
            <Button
              variant="secondary"
              size="sm"
              icon={<UserSwitchIcon size={16} />}
              onClick={handleKickSpeaker}
            >
              Take over as speaker
            </Button>
          </div>
        )}

        {/* Kicked banner */}
        {kicked && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/20">
            <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
              <WarningCircleIcon size={16} weight="bold" />
              Another session has taken over. You have been disconnected.
            </div>
          </div>
        )}

        {/* Status indicator */}
        <Surface className="rounded-xl px-4 py-3 text-center ring ring-kumo-line mb-4">
          <div
            className={`flex items-center justify-center gap-2 ${statusDisplay.color}`}
          >
            <StatusIcon
              size={20}
              weight="bold"
              className={status === "thinking" ? "animate-spin" : ""}
            />
            <span className={`text-lg ${statusDisplay.color}`}>
              {statusDisplay.text}
            </span>
          </div>
          {/* Audio level meter */}
          {isInCall && status === "listening" && (
            <div className="mt-2 h-1.5 bg-kumo-fill rounded-full overflow-hidden">
              <div
                className="h-full bg-kumo-success rounded-full transition-all duration-75"
                style={{ width: `${Math.min(audioLevel * 500, 100)}%` }}
              />
            </div>
          )}
        </Surface>

        {/* Transcript */}
        <Surface className="rounded-xl ring ring-kumo-line mb-6 h-72 overflow-y-auto">
          {transcript.length === 0 ? (
            <div className="h-full flex items-center justify-center text-kumo-secondary">
              <Text size="sm">
                {isInCall
                  ? "Start speaking..."
                  : connected
                    ? "Start a voice session when you're ready"
                    : "Connecting to agent..."}
              </Text>
            </div>
          ) : (
            <div className="p-4 space-y-3">
              {transcript.map((msg, i) => (
                <div
                  key={i}
                  className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div className="flex flex-col gap-0.5 max-w-[80%]">
                    <div
                      className={`rounded-xl px-3 py-2 text-sm ${
                        msg.role === "user"
                          ? "bg-kumo-brand/15 text-kumo-default"
                          : "bg-kumo-fill text-kumo-default"
                      }`}
                    >
                      {msg.text || (
                        <span className="text-kumo-secondary italic">...</span>
                      )}
                    </div>
                    {msg.timestamp && (
                      <span
                        className={`text-[10px] text-kumo-secondary px-1 ${msg.role === "user" ? "text-right" : "text-left"}`}
                      >
                        {formatTime(new Date(msg.timestamp))}
                      </span>
                    )}
                  </div>
                </div>
              ))}
              {/* Interim transcript — live preview of what the user is saying */}
              {interimTranscript && (
                <div className="flex justify-end">
                  <div className="flex flex-col gap-0.5 max-w-[80%]">
                    <div className="rounded-xl px-3 py-2 text-sm bg-kumo-brand/10 text-kumo-secondary italic border border-kumo-brand/20 border-dashed">
                      {interimTranscript}
                    </div>
                  </div>
                </div>
              )}
              <div ref={transcriptEndRef} />
            </div>
          )}
        </Surface>

        {/* Call controls */}
        <div className="flex items-center justify-center gap-3">
          {!isInCall ? (
            <Button
              onClick={handleStartCall}
              className="px-8 justify-center"
              variant="primary"
              disabled={!connected || speakerConflict}
              icon={<PhoneIcon size={20} weight="fill" />}
            >
              {connected ? "Start talking" : "Connecting..."}
            </Button>
          ) : (
            <>
              <Button
                onClick={toggleMute}
                variant={isMuted ? "destructive" : "secondary"}
                icon={
                  isMuted ? (
                    <MicrophoneSlashIcon size={20} weight="fill" />
                  ) : (
                    <MicrophoneIcon size={20} weight="fill" />
                  )
                }
              >
                {isMuted ? "Unmute" : "Mute"}
              </Button>
              <Button
                onClick={endCall}
                variant="destructive"
                icon={<PhoneDisconnectIcon size={20} weight="fill" />}
              >
                End Call
              </Button>
            </>
          )}
        </div>

        {/* Text input — type to the agent */}
        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (textInput.trim() && connected) {
              sendText(textInput.trim());
              setTextInput("");
            }
          }}
        >
          <Input
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder={connected ? "Type a message..." : "Connecting..."}
            disabled={!connected || status === "thinking"}
            className="flex-1"
          />
          <Button
            type="submit"
            variant="secondary"
            disabled={!connected || !textInput.trim() || status === "thinking"}
            icon={<PaperPlaneRightIcon size={16} weight="fill" />}
          >
            Send
          </Button>
        </form>

        <details hidden className="mt-6 border-t border-kumo-line pt-4">
          <summary className="cursor-pointer select-none text-sm text-kumo-secondary">
            Advanced settings
          </summary>
          <div className="mt-4 flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <span className="text-xs text-kumo-secondary">Model</span>
              <Select
                aria-label="LLM model"
                size="sm"
                value={llmModel}
                onValueChange={(v) => setLlmModel(v as string)}
                renderValue={(v) => String(v)}
                disabled={isInCall}
              >
                {models.some((m) => !m.reasoning) && (
                  <Select.Group>
                    <Select.GroupLabel>Fast (non-reasoning)</Select.GroupLabel>
                    {models
                      .filter((m) => !m.reasoning)
                      .map((m) => (
                        <Select.Option key={m.id} value={m.id}>
                          {m.id}
                        </Select.Option>
                      ))}
                  </Select.Group>
                )}
                {models.some((m) => m.reasoning) && (
                  <Select.Group>
                    <Select.GroupLabel>Reasoning</Select.GroupLabel>
                    {models
                      .filter((m) => m.reasoning)
                      .map((m) => (
                        <Select.Option key={m.id} value={m.id}>
                          {m.id}
                        </Select.Option>
                      ))}
                  </Select.Group>
                )}
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-xs text-kumo-secondary">
                Reasoning effort
              </span>
              <div className="flex flex-wrap gap-2">
                {(["off", "low", "medium", "high"] as const).map((effort) => (
                  <Button
                    key={effort}
                    variant={reasoning === effort ? "primary" : "ghost"}
                    size="sm"
                    disabled={isInCall}
                    onClick={() => setReasoning(effort)}
                  >
                    {effort === "off"
                      ? "Off"
                      : effort[0].toUpperCase() + effort.slice(1)}
                  </Button>
                ))}
              </div>
            </div>

            <label className="flex flex-col gap-2">
              <span className="text-xs text-kumo-secondary">Speaker</span>
              <select
                aria-label="Audio output"
                value={outputDeviceId}
                onChange={(event) => setOutputDeviceId(event.target.value)}
                className="min-w-0 rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default"
              >
                <option value="default">System default</option>
                {audioOutputDevices
                  .filter((device) => device.deviceId !== "default")
                  .map((device, index) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {getAudioOutputLabel(device, index)}
                    </option>
                  ))}
              </select>
              {outputDeviceError && (
                <span className="text-xs text-kumo-warning">
                  {outputDeviceError}
                </span>
              )}
            </label>

            {metrics && (
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-kumo-secondary font-mono">
                <span>
                  LLM{" "}
                  <span className="text-kumo-default">{metrics.llm_ms}ms</span>
                </span>
                <span>
                  TTS{" "}
                  <span className="text-kumo-default">{metrics.tts_ms}ms</span>
                </span>
                <span>
                  First audio{" "}
                  <span className="text-kumo-default">
                    {metrics.first_audio_ms}ms
                  </span>
                </span>
              </div>
            )}

            <div className="text-[10px] text-kumo-secondary font-mono">
              Session: {sessionId.slice(0, 8)}...
            </div>
          </div>
        </details>
      </Surface>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
