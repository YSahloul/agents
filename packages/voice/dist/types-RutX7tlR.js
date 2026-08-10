//#region src/types.ts
/**
* Shared types for the voice pipeline.
*
* Used by both the server (voice.ts) and client (voice-client.ts)
* to ensure protocol consistency.
*/
/**
* Current voice protocol version.
* Bump this when making backwards-incompatible wire protocol changes.
* The server sends this in the initial `welcome` message so clients
* can detect version mismatches.
*/
const VOICE_PROTOCOL_VERSION = 1;
//#endregion
export { VOICE_PROTOCOL_VERSION as t };

//# sourceMappingURL=types-RutX7tlR.js.map