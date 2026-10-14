import { type } from "arktype";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";

export const BuildProperties = lazy(() =>
  type({
    app_version: /^(?:\d+\.\d+\.\d+(?:-nightly\.\d{8}\.\d+)?|unknown)$/,
    build_channel: "'stable' | 'nightly' | 'unknown'",
    update_channel: "'stable' | 'nightly' | 'none'",
    os: "'macos' | 'windows' | 'linux' | 'unknown'",
    arch: "'x64' | 'arm64' | 'ia32' | 'unknown'",
    distribution: "'direct' | 'store'",
  }).onUndeclaredKey("delete"),
);
export type BuildProperties = Infer<typeof BuildProperties>;

/** All capture dimensions participate; ordering of persisted object keys does not. */
export function sameProperties(left: BuildProperties, right: BuildProperties): boolean {
  return (
    left.app_version === right.app_version &&
    left.build_channel === right.build_channel &&
    left.update_channel === right.update_channel &&
    left.os === right.os &&
    left.arch === right.arch &&
    left.distribution === right.distribution
  );
}
