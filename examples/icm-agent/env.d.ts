/* eslint-disable */
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./src/server");
    durableNamespaces: "ICMAgent";
  }
  interface Env {
    AI: Ai;
    ICMAgent: DurableObjectNamespace<import("./src/server").ICMAgent>;
  }
}
interface Env extends Cloudflare.Env {}
