/**
 * Ambient types for the two browser avatar packages, which ship untyped ESM.
 *
 * Only the surface this example touches is declared. Consult the upstream
 * modules for the full API:
 * - https://github.com/met4citizen/TalkingHead
 * - https://github.com/met4citizen/HeadAudio
 */

declare module "@met4citizen/talkinghead" {
  export interface TalkingHeadOptions {
    /** Language modules to load for text-driven lip-sync. Unused here. */
    lipsyncModules?: string[];
    /** Google TTS proxy endpoint. Unused here: audio comes from the agent. */
    ttsEndpoint?: string | null;
    /** Initial camera framing. */
    cameraView?: "full" | "mid" | "upper" | "head";
    modelFPS?: number;
    avatarMood?: string;
    /** Scene object treated as the armature root. */
    modelRoot?: string;
    [key: string]: unknown;
  }

  export interface TalkingHeadAvatar {
    /** GLTF/GLB URL. */
    url: string;
    /** Body type, used to pick idle poses. */
    body?: "M" | "F";
    avatarMood?: string;
    /**
     * Per-bone pose offsets, for rigs whose bone axes or rolls differ from the
     * reference models. Keys are bone names; values are axis offsets.
     */
    retarget?: Record<string, Record<string, number> | number>;
    /** Blend-shape values the model rests at, overlaid on the neutral pose. */
    baseline?: Record<string, number>;
    [key: string]: unknown;
  }

  export interface TalkingHeadMorphTarget {
    newvalue?: number;
    needsUpdate?: boolean;
    [key: string]: unknown;
  }

  export class TalkingHead {
    constructor(node: HTMLElement, options?: TalkingHeadOptions);
    /** Morph targets by name, including Oculus visemes (`viseme_aa`, ...). */
    readonly mtAvatar: Record<string, TalkingHeadMorphTarget>;
    readonly audioCtx: AudioContext;
    /** Per-frame hook, invoked from the internal render loop. */
    opt: TalkingHeadOptions & { update?: (dt: number) => void };
    showAvatar(
      avatar: TalkingHeadAvatar,
      onprogress?: unknown
    ): Promise<unknown>;
    /** Starts the render loop. */
    start(): void;
    /** Stops the render loop. */
    stop(): void;
    setMood(mood: string): void;
    /** Turns the head toward the camera over `t` milliseconds. */
    lookAtCamera(t: number): void;
    /** Plays an idle-to-speaking hand gesture. */
    speakWithHands(delay?: number, probability?: number): void;
  }
}

declare module "@met4citizen/headaudio/dist/headaudio.min.mjs" {
  export interface HeadAudioOptions {
    processorOptions?: {
      vadEventsEnabled?: boolean;
      visemeEventsEnabled?: boolean;
      [key: string]: unknown;
    };
    parameterData?: Record<string, number>;
  }

  /**
   * AudioWorklet node that classifies visemes from a live audio stream.
   * Single mono input, no outputs.
   */
  export class HeadAudio extends AudioWorkletNode {
    constructor(audioCtx: AudioContext, options?: HeadAudioOptions | null);
    /** Fires per viseme with an Oculus name and a value in [0, 1]. */
    onvalue: ((key: string, value: number) => void) | null;
    onstarted: ((data: { event: string; t: number }) => void) | null;
    onended: ((data: { event: string; t: number }) => void) | null;
    loadModel(url: string, reset?: boolean): Promise<void>;
    /** Advances the viseme easing. Call once per frame with delta ms. */
    update(dt: number): void;
  }
}
