// Native telemetry reuses the existing published-pair resolver and disposable NSIS runner.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readReceipt } from "./installed-upgrade-packages.ts";
import { disposableRunner, uninstall } from "./installed-upgrade-windows.ts";
import { installPublished } from "./installed-upgrade.ts";

export async function installedTelemetryPair(
  directory: string,
  evidence: string,
  candidate: { executable: string | undefined; version: string; source: string },
) {
  const runner = disposableRunner();
  assert.equal(
    process.env["GITHUB_REF"],
    "refs/heads/main",
    "Installed telemetry runs from main only",
  );
  assert.match(process.env["GITHUB_SHA"] ?? "", /^[a-f0-9]{40}$/);
  const receipt = readReceipt(JSON.parse(await readFile(join(directory, "receipt.json"), "utf8")));
  assert.equal(receipt.repository, process.env["GITHUB_REPOSITORY"]);
  assert.equal(
    receipt.resolved.stableTag,
    "v0.0.15",
    "Frozen compatibility requires actual published .15",
  );
  const [stable, next] = receipt.packages;
  assert.equal(next.version, candidate.version);
  assert.equal(next.source, candidate.source);
  assert.equal(candidate.executable?.toLowerCase(), runner.executable.toLowerCase());
  // Resolution already verifies tags, ancestry and published metadata. Recheck downloaded bytes
  // before the first installer and again before every replacement, not a second resolver.
  const validate = async (pkg: typeof stable) => {
    const bytes = await readFile(join(directory, pkg.file));
    if (pkg.provenance.assetDigest)
      assert.equal(pkg.provenance.assetDigest, `sha256:${pkg.sha256}`);
    assert.equal(bytes.length, pkg.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), pkg.sha256);
    assert.equal(
      createHash("sha512").update(bytes).digest("base64"),
      pkg.provenance.metadata.sha512,
    );
    return join(directory, pkg.file);
  };
  for (const pkg of receipt.packages) await validate(pkg);
  const installs: unknown[] = [];
  let current: string | null = null;
  let failed = true;
  return {
    prior: { executable: runner.executable, version: stable.version, source: stable.source },
    async select(which: "stable" | "candidate") {
      const pkg = which === "stable" ? stable : next;
      if (pkg.version === current) return;
      const installed = await installPublished(runner, await validate(pkg), pkg.version, current);
      current = pkg.version;
      installs.push(installed);
      await writeFile(
        join(evidence, "native-installs.json"),
        JSON.stringify({ receipt, installs }, null, 2),
      );
    },
    accepted() {
      failed = false;
    },
    async close() {
      if (!failed && current) {
        try {
          await uninstall(runner);
          await writeFile(
            join(evidence, "native-uninstall.json"),
            JSON.stringify({ status: "passed" }),
          );
        } catch (error) {
          await writeFile(
            join(evidence, "native-uninstall.json"),
            JSON.stringify({ status: "failed", error: String(error) }),
          );
          throw error;
        }
      }
    },
  };
}
