import { HeadAudio } from "@met4citizen/headaudio/dist/headaudio.min.mjs";
import headModelUrl from "@met4citizen/headaudio/dist/model-en-mixed.bin?url";
import headWorkletUrl from "@met4citizen/headaudio/dist/headworklet.min.mjs?url";
import type { TalkingHeadAvatar } from "@met4citizen/talkinghead";
import { TalkingHead } from "@met4citizen/talkinghead";
import { SpinnerGapIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

/**
 * The avatar to render.
 *
 * Run `pnpm run check:avatar public/avatars/<file>.glb` after swapping — a rig
 * missing the `Armature` root throws on load, and one missing the Oculus
 * visemes loads fine but never moves its mouth.
 *
 * `retarget` and `baseline` correct for quirks in the source rig. Avaturn
 * Type-2 avatars need the offsets below, taken from the upstream
 * `siteconfig.js`:
 *
 *   retarget: {
 *     Hips: { y: 0.03 }, Spine: { y: 0.02 }, Spine1: { y: 0.02, z: 0.01 },
 *     Spine2: { y: 0.02, z: 0.01 }, Neck: { z: 0.02, y: 0.01 }, Head: { z: 0.02 },
 *     LeftShoulder: { rx: -0.5 }, RightShoulder: { rx: -0.5 },
 *     scaleToHipsLevel: 1.0
 *   },
 *   baseline: { headRotateX: -0.05, eyeBlinkLeft: 0.15, eyeBlinkRight: 0.15 }
 */
const AVATAR: TalkingHeadAvatar = {
  url: "/avatars/brunette-t.glb",
  body: "F",
  avatarMood: "neutral"
};

type AvatarState = "loading" | "ready" | "error";

/**
 * Renders the assistant as a 3D avatar and lip-syncs it to the agent's audio.
 *
 * The visemes are derived from the live SFU playback stream rather than from
 * text, so nothing needs to cross the network for the avatar to animate: the
 * browser is animating the same audio it is already playing.
 */
export function TalkingAvatar({
  playbackStream
}: {
  playbackStream: MediaStream | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<TalkingHead | null>(null);
  const headAudioRef = useRef<HeadAudio | null>(null);
  const [state, setState] = useState<AvatarState>("loading");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;

    const head = new TalkingHead(container, {
      // Speech comes from the agent, so no text-driven lip-sync or TTS proxy.
      lipsyncModules: [],
      ttsEndpoint: null,
      cameraView: "upper",
      cameraZoomEnable: false,
      avatarMood: "neutral"
    });
    headRef.current = head;

    // The render loop calls this once per frame; the viseme node is attached
    // and detached as the call streams arrive.
    head.opt.update = (dt: number) => {
      headAudioRef.current?.update(dt);
    };

    head
      .showAvatar(AVATAR)
      .then(() => {
        if (disposed) return;
        head.start();
        setState("ready");
      })
      .catch((error: unknown) => {
        console.error("[TalkingAvatar] avatar failed to load", error);
        if (!disposed) setState("error");
      });

    return () => {
      disposed = true;
      head.stop();
      head.opt.update = undefined;
      headRef.current = null;
      // TalkingHead appends its own canvas; drop it so a remount starts clean.
      container.replaceChildren();
    };
  }, []);

  useEffect(() => {
    if (state !== "ready" || !playbackStream) return;
    const head = headRef.current;
    if (!head || playbackStream.getAudioTracks().length === 0) return;

    let disposed = false;
    let node: HeadAudio | null = null;
    const context = new AudioContext();

    const attach = async () => {
      // Both assets are emitted by Vite as URLs, so the worklet gets its own
      // module scope and the model downloads alongside the bundle.
      await context.audioWorklet.addModule(headWorkletUrl);
      const audio = new HeadAudio(context, {
        parameterData: { vadGateActiveDb: -40, vadGateInactiveDb: -60 }
      });
      await audio.loadModel(headModelUrl);
      if (disposed) return;

      // Classification costs 50-100ms, so the visemes land behind the audio.
      // `playbackDelayMs` on the audio input holds the audio back by the same
      // amount, which is what lines the mouth up with the voice.
      context.createMediaStreamSource(playbackStream).connect(audio);

      audio.onvalue = (key: string, value: number) => {
        const target = head.mtAvatar[key];
        if (!target) return;
        target.newvalue = value;
        target.needsUpdate = true;
      };

      // HeadAudio reports utterance boundaries. TalkingHead's own streaming
      // mode fires these internally, but we drive the morph targets directly,
      // so the idle-to-speaking behaviour has to be requested explicitly.
      let lastEndedAt = 0;
      audio.onstarted = () => {
        // Ignore intra-sentence gaps; only react to a fresh utterance.
        if (Date.now() - lastEndedAt < 150) return;
        head.lookAtCamera(500);
        // `speakWithHands` is documented as `prob=1` but the implementation
        // defaults to 0.5, so the gesture silently does nothing half the time.
        // Pass it explicitly; lower it for variety once it is visibly working.
        head.speakWithHands(0, 1);
      };
      audio.onended = () => {
        lastEndedAt = Date.now();
      };

      node = audio;
      headAudioRef.current = audio;
      await context.resume();
    };

    attach().catch((error: unknown) => {
      console.error("[TalkingAvatar] viseme engine failed", error);
    });

    return () => {
      disposed = true;
      if (headAudioRef.current === node) headAudioRef.current = null;
      node?.disconnect();
      void context.close();
    };
  }, [state, playbackStream]);

  return (
    <div className="relative mb-4 overflow-hidden rounded-2xl bg-kumo-base ring ring-kumo-line">
      <div ref={containerRef} className="aspect-video w-full" />
      {state !== "ready" && (
        <div className="absolute inset-0 flex items-center justify-center gap-2">
          {state === "loading" ? (
            <>
              <SpinnerGapIcon size={16} className="animate-spin" />
              <span className="text-xs">Loading avatar…</span>
            </>
          ) : (
            <span className="text-xs">Avatar failed to load</span>
          )}
        </div>
      )}
    </div>
  );
}
