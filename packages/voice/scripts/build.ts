import { build } from "tsdown";
import { copyPackageDocs } from "../../../scripts/copy-package-docs";
import { formatDeclarationFiles } from "../../../scripts/format-declarations";

async function main() {
  await build({
    clean: true,
    dts: true,
    entry: {
      voice: "src/index.ts",
      "voice-client": "src/voice-client.ts",
      "voice-react": "src/voice-react.tsx",
      errors: "src/errors.ts"
    },
    skipNodeModulesBundle: true,
    external: ["cloudflare:workers"],
    format: "esm",
    sourcemap: true,
    fixedExtension: false
  });

  // then run oxfmt on the generated .d.ts files
  formatDeclarationFiles();

  copyPackageDocs(import.meta.url, "voice");

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
