import { useEffect, useState } from "react";
import { Platform, ScrollView, Text } from "react-native";
import { fetch as expoFetch } from "expo/fetch";
import { runCases } from "./proof/run.ts";
import { keychainProof } from "./proof/keychain.ts";
import { keychainSecrets } from "./secrets.ts";

// A development build's only screen until a design is picked: it runs the runtime proof and, when
// built with EXPO_PUBLIC_PROOF_URL, sends the report to scripts/proof-server.ts.
const PROOF_URL = process.env.EXPO_PUBLIC_PROOF_URL;

interface HermesRuntime {
  getRuntimeProperties?(): Record<string, unknown>;
}

/** What the app threw outside the cases, such as a shared module failing while it loads. */
const uncaught: string[] = [];
const previousHandler = ErrorUtils.getGlobalHandler();
ErrorUtils.setGlobalHandler((error: unknown, fatal?: boolean) => {
  uncaught.push(
    error instanceof Error ? `${error.name}: ${error.message}\n${error.stack}` : String(error),
  );
  previousHandler(error, fatal);
});

async function prove() {
  const fixture = PROOF_URL ?? "http://127.0.0.1:9";
  const results = await runCases({
    fixture,
    // expo/fetch implements fetch with types of its own; the cases use only what both share.
    fetches: { global: fetch, expo: expoFetch as unknown as typeof fetch },
  });
  const started = Date.now();
  const keychain = await keychainProof(keychainSecrets).then(
    (value) => ({ value }),
    (error: unknown) => ({ thrown: String(error) }),
  );
  results.push({ name: "keychain", compare: "record", ms: Date.now() - started, ...keychain });
  const hermes = (globalThis as { HermesInternal?: HermesRuntime }).HermesInternal;
  const report = {
    runtime: {
      hermes: hermes?.getRuntimeProperties?.() ?? null,
      platform: Platform.OS,
      constants: Platform.constants,
    },
    uncaught,
    results,
  };
  if (PROOF_URL) {
    await fetch(`${PROOF_URL}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
  }
  return results;
}

export function App() {
  const [lines, setLines] = useState<readonly string[]>(["Proving"]);
  useEffect(() => {
    prove().then(
      (results) =>
        setLines(
          results.map(
            (r) => `${r.thrown ? "threw" : "ran"}  ${r.name}${r.thrown ? `: ${r.thrown}` : ""}`,
          ),
        ),
      (error: unknown) =>
        setLines([
          `Proof failed: ${error instanceof Error ? `${String(error)}\n${error.stack}` : String(error)}`,
        ]),
    );
  }, []);
  return (
    <ScrollView
      style={{ backgroundColor: "#000" }}
      contentContainerStyle={{ padding: 16, paddingTop: 64 }}
    >
      {lines.map((line, index) => (
        <Text
          key={index}
          testID={`proof-${index}`}
          style={{ color: "#fff", fontSize: 12, fontFamily: "Menlo" }}
        >
          {line}
        </Text>
      ))}
    </ScrollView>
  );
}
