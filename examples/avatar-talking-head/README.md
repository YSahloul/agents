# Talking Head Avatar Voice Agent

The same Think voice agent as [`avatar-webrtc-voice`](../avatar-webrtc-voice), but
the assistant is a 3D avatar with real lip-sync instead of an animated robot.

Nothing about the agent changes. The browser receives the assistant's audio over
Cloudflare Realtime SFU as it already did, and feeds that same `MediaStream` into
[HeadAudio](https://github.com/met4citizen/HeadAudio), which classifies Oculus
visemes in an AudioWorklet. Those viseme values drive a
[TalkingHead](https://github.com/met4citizen/TalkingHead) GLB avatar rendered with
Three.js in the page.

Because the visemes come from the audio the user is already hearing, no extra
payload crosses the network: the avatar costs one renderer and one worklet on the
client, and nothing on the server.

## Run it

```bash
pnpm install
cp .env.example .env
pnpm run start
```

Set the required Realtime SFU credentials in `.env` for local development:

```bash
REALTIME_SFU_APP_ID=...
REALTIME_SFU_BEARER_TOKEN=...
```

Workers AI provides Flux turn detection, selectable LLMs, and Grok TTS through the unified model catalog. No direct xAI API key is required; AI Gateway Unified Billing must be funded.

## Local development needs a public URL

The SFU dials this Worker back over WebSocket to pull TTS audio, and it dials
from Cloudflare's network. A local dev server therefore cannot place a call —
the SFU rejects the callback outright:

```
SFU create WebSocket adapter failed (503):
  "errorCode": "websocket_localhost_not_allowed"
```

Either **deploy** (`pnpm run deploy`), or run a tunnel and tell the transport to
use it:

```bash
# 1. expose the dev server
cloudflared tunnel --url http://localhost:5173

# 2. point the SFU callback at the tunnel (add to .dev.vars)
SFU_CALLBACK_ORIGIN=https://your-tunnel.trycloudflare.com
```

`SFU_CALLBACK_ORIGIN` is read by `getSFUConfig()` and overrides the origin
derived from the incoming request. Leave it unset in production. `vite.config.ts`
already allows `.trycloudflare.com` hosts, because Vite otherwise rejects the
tunnel's Host header and the SFU reports a WebSocket handshake failure rather
than anything that points at Vite.

## Deploy

```bash
pnpm exec wrangler secret put REALTIME_SFU_APP_ID
pnpm exec wrangler secret put REALTIME_SFU_BEARER_TOKEN
pnpm run deploy
```

## Key pattern

`SFUVoiceAudioInput` hands the remote TTS stream to the caller through
`onPlaybackStream`, alongside the existing `onPlaybackAudioLevel`:

```tsx
const [playbackStream, setPlaybackStream] = useState<MediaStream | null>(null);

const audioInput = useMemo(
  () =>
    new SFUVoiceAudioInput({
      endpoint: `/agents/my-think-agent/${encodeURIComponent(sessionId)}/voice`,
      onPlaybackStream: setPlaybackStream
    }),
  [sessionId]
);

// ...
<TalkingAvatar playbackStream={playbackStream} />;
```

The avatar attaches a viseme node to that stream and mirrors the values onto the
model's morph targets:

```ts
await context.audioWorklet.addModule(headWorkletUrl);
const audio = new HeadAudio(context, {
  parameterData: { vadGateActiveDb: -40, vadGateInactiveDb: -60 }
});
await audio.loadModel(headModelUrl);
context.createMediaStreamSource(playbackStream).connect(audio);

audio.onvalue = (key, value) => {
  const target = head.mtAvatar[key];
  if (!target) return;
  target.newvalue = value;
  target.needsUpdate = true;
};
```

Both the worklet and the classifier model are imported with Vite's `?url`
suffix, so they are emitted as assets rather than inlined.

## The avatar

`public/avatars/brunette-t.glb` is the `brunette-t` reference avatar from the
TalkingHead project (MIT). It is vendored because the npm package ships modules
only — no avatars, no Blender tooling.

### Swapping in your own

Any GLB works if it meets the contract in
[Appendix A](https://github.com/met4citizen/TalkingHead#appendix-a-create-your-own-3d-avatar):

1. **Mixamo-compatible rig**, root object named `Armature`
2. **52 ARKit blend shapes** — expressions, blinks, moods
3. **15 Oculus visemes** — `viseme_sil`, `viseme_PP`, … `viseme_U`

The visemes are not optional here. HeadAudio writes those morph targets
directly, so a rig without them loads and animates but never moves its mouth.

Check a model before wiring it up:

```bash
pnpm run check:avatar public/avatars/your-avatar.glb
```

Then point `AVATAR` in `src/talking-avatar.tsx` at it:

```ts
const AVATAR: TalkingHeadAvatar = {
  url: "/avatars/your-avatar.glb",
  body: "F",
  avatarMood: "neutral"
};
```

Some sources need per-rig corrections via `retarget` / `baseline`; the comment
above `AVATAR` has the Avaturn Type-2 block from the upstream `siteconfig.js`.

### Where to get one

| Source                                                        | Input                | Notes                                                                                             |
| ------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------- |
| [Avaturn](https://avaturn.me)                                 | photo                | Type-2 avatars are TalkingHead-compatible with the `retarget` block. Free for non-commercial use. |
| [MPFB](https://static.makehumancommunity.org/mpfb.html)       | parametric (Blender) | Free and open source, CC0/CC-BY assets. Most control, most work.                                  |
| [VRoid Studio](https://vroid.com/en/studio)                   | anime-style          | Free. Needs the Blender VRM → GLB conversion.                                                     |
| [Avatar SDK](https://avatarsdk.com)                           | photo                | Commercial. Needs Blender scripts.                                                                |
| [RocketBox](https://github.com/microsoft/Microsoft-Rocketbox) | prebuilt             | MIT, includes ARKit + Oculus, but must be re-rigged in Mixamo.                                    |

Compress before shipping — a photo-realistic export will be far larger than the
2.7 MB reference:

```bash
npx gltf-transform optimize in.glb out.glb --compress meshopt --texture-compress webp
```

Meshopt is supported by default; Draco needs `dracoEnabled: true`.

**Licensing.** The GLB is delivered to the browser and is effectively
downloadable. Check the terms of whatever produced it before shipping publicly —
many commercial avatar products prohibit exactly this.

## Notes and limits

- Audio-driven visemes are cheaper than text-driven lip-sync but less accurate;
  upstream recommends text-driven timing where it matters.
- HeadAudio measures audio ahead of the renderer by roughly 50-100ms. The
  viseme easing absorbs most of it; add a `DelayNode` on the speech path if the
  offset is visible.
- The avatar animates only while the assistant audio track is live, so it stays
  neutral between turns.
- `@met4citizen/headaudio` has no type declarations; `src/avatar-types.d.ts`
  declares the surface this example uses.
