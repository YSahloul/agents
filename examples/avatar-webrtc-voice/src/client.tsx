import { SFUVoiceAudioInput, useVoiceAgent } from "@cloudflare/voice/react";
import { useAgent, useAgentToolEvents } from "agents/react";
import type { AgentToolRunState } from "agents/chat";
import {
  CaretDownIcon,
  ChatCircleDotsIcon,
  FolderSimpleIcon,
  MicrophoneIcon,
  MicrophoneSlashIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  PhoneDisconnectIcon,
  PhoneIcon,
  SpinnerGapIcon,
  SunIcon,
  UserSwitchIcon,
  WarningCircleIcon,
  WaveformIcon,
  WifiHighIcon,
  WifiSlashIcon
} from "@phosphor-icons/react";
import { Button, Input, Select, Surface, Text } from "@cloudflare/kumo";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

// --- Browser persistence ---

const SESSION_ID_KEY = "avatar-voice-session-id";
const PANEL_STATE_KEY = "avatar-voice-panels";

type PanelState = {
  activity: boolean;
  files: boolean;
  transcript: boolean;
};

function getSessionId(): string {
  const stored = localStorage.getItem(SESSION_ID_KEY);
  if (stored) return stored;
  const sessionId = crypto.randomUUID();
  localStorage.setItem(SESSION_ID_KEY, sessionId);
  return sessionId;
}

function getPanelState(): PanelState {
  try {
    const stored = JSON.parse(
      localStorage.getItem(PANEL_STATE_KEY) ?? "{}"
    ) as Record<string, unknown>;
    return {
      activity: stored.activity === true,
      files: stored.files === true,
      transcript: stored.transcript === true
    };
  } catch {
    return { activity: false, files: false, transcript: false };
  }
}

// --- Helpers ---

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
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

type WorkspaceFile = {
  path: string;
  name: string;
  size: number;
  updatedAt: number;
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

const ROBOT_FRAMES = Array.from(
  { length: 25 },
  (_, index) => `/robot-frames/frame-${String(index + 1).padStart(2, "0")}.jpg`
);
const ROBOT_SPEAKING_FRAMES = [...ROBOT_FRAMES, ...[...ROBOT_FRAMES].reverse()];
const ROBOT_FRAME_DURATION_MS = 1000 / 30;

function RobotAvatar({ isTalking }: { isTalking: boolean }) {
  const imageRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    for (const src of ROBOT_FRAMES) {
      const image = new Image();
      image.src = src;
    }
  }, []);

  useEffect(() => {
    const image = imageRef.current;
    if (!image) return;
    image.src = ROBOT_FRAMES[0];
    if (
      !isTalking ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    let frame = 0;
    let previousTime = performance.now();
    let requestId = 0;
    const animate = (time: number) => {
      const elapsed = time - previousTime;
      if (elapsed >= ROBOT_FRAME_DURATION_MS) {
        const steps = Math.floor(elapsed / ROBOT_FRAME_DURATION_MS);
        frame = (frame + steps) % ROBOT_SPEAKING_FRAMES.length;
        image.src = ROBOT_SPEAKING_FRAMES[frame];
        previousTime += steps * ROBOT_FRAME_DURATION_MS;
      }
      requestId = requestAnimationFrame(animate);
    };
    requestId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(requestId);
  }, [isTalking]);

  return (
    <div className="mb-4 overflow-hidden rounded-2xl ring ring-kumo-line">
      <img
        ref={imageRef}
        src={ROBOT_FRAMES[0]}
        alt={isTalking ? "Robot assistant talking" : "Robot assistant waiting"}
        className="block aspect-video w-full object-cover"
      />
    </div>
  );
}

// --- Main App ---

function App() {
  const sessionId = useRef(getSessionId()).current;
  const thinkAgent = useAgent({
    agent: "my-think-agent",
    name: sessionId
  });
  const { unboundRuns } = useAgentToolEvents({ agent: thinkAgent });
  const helperRuns = useMemo(() => unboundRuns, [unboundRuns]);
  const activeRun = helperRuns.find((run) => run.status === "running");
  const [panels, setPanels] = useState<PanelState>(getPanelState);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState(false);
  const [models, setModels] = useState<ModelOption[]>(BASELINE_MODELS);
  const [llmModel, setLlmModel] = useState<string>(
    "@cf/moonshotai/kimi-k2.7-code"
  );
  const [reasoning, setReasoning] = useState<ReasoningEffort>("off");
  const [outputDeviceId, setOutputDeviceId] = useState("default");
  const [hasPlaybackAudio, setHasPlaybackAudio] = useState(false);
  const playbackActive = useRef(false);
  const playbackSilenceTimer = useRef<number | undefined>(undefined);
  const sendVoiceJSON = useRef<(message: Record<string, unknown>) => void>(
    () => {}
  );
  const playbackStartedAt = useRef(0);
  const playbackPeakRms = useRef(0);
  const audioInput = useMemo(
    () =>
      new SFUVoiceAudioInput({
        endpoint: `/agents/my-voice-agent/${encodeURIComponent(sessionId)}/voice`,
        onPlaybackAudioLevel: (rms) => {
          if (rms > 0.01) {
            playbackPeakRms.current = Math.max(playbackPeakRms.current, rms);
            if (playbackSilenceTimer.current !== undefined) {
              clearTimeout(playbackSilenceTimer.current);
              playbackSilenceTimer.current = undefined;
            }
            if (!playbackActive.current) {
              playbackActive.current = true;
              playbackStartedAt.current = Date.now();
              playbackPeakRms.current = rms;
              sendVoiceJSON.current({ type: "playback_started", rms });
              setHasPlaybackAudio(true);
            }
          } else if (
            playbackActive.current &&
            playbackSilenceTimer.current === undefined
          ) {
            playbackSilenceTimer.current = window.setTimeout(() => {
              playbackActive.current = false;
              playbackSilenceTimer.current = undefined;
              sendVoiceJSON.current({
                type: "playback_stopped",
                durationMs: Date.now() - playbackStartedAt.current,
                peakRms: playbackPeakRms.current
              });
              playbackStartedAt.current = 0;
              playbackPeakRms.current = 0;
              setHasPlaybackAudio(false);
            }, 160);
          }
        }
      }),
    [sessionId]
  );

  useEffect(() => () => clearTimeout(playbackSilenceTimer.current), []);

  const {
    status,
    transcript,
    interimTranscript,
    metrics,
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

  useEffect(() => {
    sendVoiceJSON.current = sendJSON;
  }, [sendJSON]);

  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const [textInput, setTextInput] = useState("");
  const [speakerConflict, setSpeakerConflict] = useState(false);
  const [kicked, setKicked] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [audioOutputDevices, setAudioOutputDevices] = useState<
    MediaDeviceInfo[]
  >([]);

  const setPanelOpen = useCallback((panel: keyof PanelState, open: boolean) => {
    setPanels((current) => ({ ...current, [panel]: open }));
  }, []);

  const refreshWorkspaceFiles = useCallback(async () => {
    setFilesLoading(true);
    setFilesError(false);
    try {
      const files = await thinkAgent.call("listWorkspaceFiles", []);
      setWorkspaceFiles(Array.isArray(files) ? (files as WorkspaceFile[]) : []);
    } catch {
      setFilesError(true);
    } finally {
      setFilesLoading(false);
    }
  }, [thinkAgent]);

  useEffect(() => {
    localStorage.setItem(PANEL_STATE_KEY, JSON.stringify(panels));
  }, [panels]);

  useEffect(() => {
    if (connected) void refreshWorkspaceFiles();
  }, [connected, transcript.length, refreshWorkspaceFiles]);

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

  // Keep new text inside the transcript scroller without moving the page.
  useEffect(() => {
    const scroller = transcriptScrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
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
    const settings = audioInput.microphoneSettings;
    console.info("[VoiceTrace] microphone_settings", settings);
    sendJSON({
      type: "microphone_settings",
      settings: settings
        ? {
            autoGainControl: settings.autoGainControl ?? null,
            channelCount: settings.channelCount ?? null,
            echoCancellation: settings.echoCancellation ?? null,
            noiseSuppression: settings.noiseSuppression ?? null,
            sampleRate: settings.sampleRate ?? null
          }
        : null
    });
    await refreshAudioOutputs().catch(() => {});
  }, [audioInput, refreshAudioOutputs, sendJSON, startCall]);

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

  return (
    <div className="flex min-h-dvh items-start justify-center p-0 sm:items-center sm:p-6">
      <Surface className="min-h-dvh w-full max-w-3xl rounded-none p-4 ring-0 sm:min-h-0 sm:rounded-2xl sm:p-6 sm:ring sm:ring-kumo-line">
        {/* Header */}
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <ChatCircleDotsIcon
              size={28}
              weight="duotone"
              className="text-kumo-brand"
            />
            <Text variant="heading1" as="h1">
              Avatar Voice
            </Text>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* Connection status */}
            <span
              aria-label={connected ? "Connected" : "Connecting"}
              className={`flex items-center gap-1.5 text-xs ${connected ? "text-kumo-success" : "text-kumo-secondary"}`}
            >
              {connected ? (
                <WifiHighIcon size={14} weight="bold" />
              ) : (
                <WifiSlashIcon size={14} weight="bold" />
              )}
              <span className="hidden sm:inline">
                {connected ? "Connected" : "Connecting..."}
              </span>
            </span>
            <ModeToggle />
          </div>
        </div>

        <RobotAvatar isTalking={hasPlaybackAudio} />

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

        {/* Call controls */}
        <div className="flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
          {!isInCall ? (
            <Button
              onClick={handleStartCall}
              className="w-full justify-center px-8 sm:w-auto"
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
                className="w-full justify-center sm:w-auto"
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
                className="w-full justify-center sm:w-auto"
                variant="destructive"
                icon={<PhoneDisconnectIcon size={20} weight="fill" />}
              >
                End Call
              </Button>
            </>
          )}
        </div>

        <details
          open={panels.activity}
          onToggle={(event) =>
            setPanelOpen("activity", event.currentTarget.open)
          }
          className="group mt-6 overflow-hidden rounded-xl bg-kumo-base ring ring-kumo-line open:shadow-sm"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 marker:hidden [&::-webkit-details-marker]:hidden">
            <span className="flex min-w-0 items-center gap-2">
              {activeRun ? (
                <SpinnerGapIcon
                  size={16}
                  className="shrink-0 animate-spin text-kumo-accent"
                />
              ) : (
                <WaveformIcon
                  size={16}
                  className="shrink-0 text-kumo-secondary"
                />
              )}
              <span className="text-sm font-medium text-kumo-default">
                Activity
              </span>
              <span className="truncate text-xs text-kumo-secondary">
                {activeRun
                  ? helperStatus(activeRun)
                  : helperRuns.length > 0
                    ? `${helperRuns.length} ${helperRuns.length === 1 ? "run" : "runs"}`
                    : "Quiet"}
              </span>
            </span>
            <CaretDownIcon
              size={16}
              className="shrink-0 text-kumo-secondary transition-transform group-open:rotate-180"
            />
          </summary>
          <div className="max-h-72 overflow-y-auto border-t border-kumo-line p-3">
            {helperRuns.length === 0 ? (
              <div className="rounded-lg bg-kumo-fill px-3 py-4 text-center">
                <Text size="xs" variant="secondary">
                  Background work will appear here automatically.
                </Text>
              </div>
            ) : (
              <div className="space-y-2">
                {helperRuns.map((run) => (
                  <div key={run.runId} className="rounded-lg bg-kumo-fill p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <Text size="xs" bold>
                          {run.display?.name ?? run.agentType}
                        </Text>
                        <div className="mt-1 text-xs text-kumo-secondary">
                          {helperQuery(run)}
                        </div>
                      </div>
                      <span className="flex shrink-0 items-center gap-1 text-xs text-kumo-secondary">
                        {run.status === "running" && (
                          <SpinnerGapIcon size={13} className="animate-spin" />
                        )}
                        {helperStatus(run)}
                      </span>
                    </div>
                    {run.summary && (
                      <div className="mt-3 border-t border-kumo-line pt-3 text-xs text-kumo-default">
                        {run.summary}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </details>

        <details
          open={panels.files}
          onToggle={(event) => {
            const open = event.currentTarget.open;
            setPanelOpen("files", open);
            if (open) void refreshWorkspaceFiles();
          }}
          className="group mt-2 overflow-hidden rounded-xl bg-kumo-base ring ring-kumo-line open:shadow-sm"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 marker:hidden [&::-webkit-details-marker]:hidden">
            <span className="flex min-w-0 items-center gap-2">
              <FolderSimpleIcon
                size={16}
                className="shrink-0 text-kumo-secondary"
              />
              <span className="text-sm font-medium text-kumo-default">
                Files
              </span>
              {workspaceFiles.length > 0 && (
                <span className="text-xs text-kumo-secondary">
                  {workspaceFiles.length}
                </span>
              )}
            </span>
            <CaretDownIcon
              size={16}
              className="shrink-0 text-kumo-secondary transition-transform group-open:rotate-180"
            />
          </summary>
          <div className="max-h-64 overflow-y-auto border-t border-kumo-line p-3">
            {filesLoading ? (
              <div className="flex items-center justify-center gap-2 px-3 py-4 text-xs text-kumo-secondary">
                <SpinnerGapIcon size={14} className="animate-spin" />
                Loading files…
              </div>
            ) : filesError ? (
              <div className="rounded-lg bg-kumo-fill px-3 py-4 text-center text-xs text-kumo-secondary">
                Files could not be loaded.
              </div>
            ) : workspaceFiles.length === 0 ? (
              <div className="rounded-lg bg-kumo-fill px-3 py-4 text-center">
                <Text size="xs" variant="secondary">
                  Files created during the conversation will appear here.
                </Text>
              </div>
            ) : (
              <div className="space-y-1">
                {workspaceFiles.map((file) => (
                  <div
                    key={file.path}
                    className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 hover:bg-kumo-fill"
                  >
                    <span className="min-w-0 truncate text-xs text-kumo-default">
                      {file.path}
                    </span>
                    <span className="shrink-0 text-[11px] text-kumo-secondary">
                      {formatFileSize(file.size)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </details>

        <details
          open={panels.transcript}
          onToggle={(event) =>
            setPanelOpen("transcript", event.currentTarget.open)
          }
          className="group mt-2 overflow-hidden rounded-xl bg-kumo-base ring ring-kumo-line open:shadow-sm"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 marker:hidden [&::-webkit-details-marker]:hidden">
            <span className="flex min-w-0 items-center gap-2">
              <ChatCircleDotsIcon
                size={16}
                className="shrink-0 text-kumo-secondary"
              />
              <span className="text-sm font-medium text-kumo-default">
                Transcript
              </span>
              {transcript.length > 0 && (
                <span className="text-xs text-kumo-secondary">
                  {transcript.length}
                </span>
              )}
            </span>
            <CaretDownIcon
              size={16}
              className="shrink-0 text-kumo-secondary transition-transform group-open:rotate-180"
            />
          </summary>
          <div className="h-64 border-t border-kumo-line">
            <div
              ref={transcriptScrollRef}
              className="h-full overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
            >
              {transcript.length === 0 && !interimTranscript ? (
                <div className="flex h-full items-center justify-center px-4 text-center text-kumo-secondary">
                  <Text size="sm">
                    {isInCall
                      ? "Start speaking..."
                      : connected
                        ? "Start a voice session when you're ready"
                        : "Connecting to agent..."}
                  </Text>
                </div>
              ) : (
                <div className="space-y-3 p-4">
                  {transcript.map((msg, i) => (
                    <div
                      key={i}
                      className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                    >
                      <div className="flex min-w-0 max-w-[85%] flex-col gap-0.5">
                        <div
                          className={`break-words rounded-xl px-3 py-2 text-sm ${
                            msg.role === "user"
                              ? "bg-kumo-brand/15 text-kumo-default"
                              : "bg-kumo-fill text-kumo-default"
                          }`}
                        >
                          {msg.text || (
                            <span className="text-kumo-secondary italic">
                              ...
                            </span>
                          )}
                        </div>
                        {msg.timestamp && (
                          <span
                            className={`px-1 text-[10px] text-kumo-secondary ${msg.role === "user" ? "text-right" : "text-left"}`}
                          >
                            {formatTime(new Date(msg.timestamp))}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                  {interimTranscript && (
                    <div className="flex justify-end">
                      <div className="flex min-w-0 max-w-[85%] flex-col gap-0.5">
                        <div className="break-words rounded-xl border border-dashed border-kumo-brand/20 bg-kumo-brand/10 px-3 py-2 text-sm text-kumo-secondary italic">
                          {interimTranscript}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          <form
            className="flex gap-2 border-t border-kumo-line p-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (textInput.trim() && connected) {
                sendText(textInput.trim());
                setTextInput("");
              }
            }}
          >
            <Input
              value={textInput}
              onChange={(event) => setTextInput(event.target.value)}
              placeholder={connected ? "Type a message..." : "Connecting..."}
              disabled={!connected || status === "thinking"}
              className="min-w-0 flex-1"
            />
            <Button
              type="submit"
              variant="secondary"
              disabled={
                !connected || !textInput.trim() || status === "thinking"
              }
              className="shrink-0 justify-center"
              icon={<PaperPlaneRightIcon size={16} weight="fill" />}
            >
              Send
            </Button>
          </form>
        </details>

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
