// Types for the imports electron-vite resolves at build time, such as `?nodeWorker`.
/// <reference types="electron-vite/node" />

/** The app's TMDB key, built in from MR_STREAMER_TMDB_KEY; empty when the build had none. */
declare const __TMDB_KEY__: string;

/** The commit the build comes from (electron.vite.config.ts); empty when it isn't known. */
declare const __BUILD_COMMIT__: string;

/** Explicit release configuration. Null until the production project/region is authorized. */
declare const __ANALYTICS_CAPTURE__:
  import("./analytics/transport.ts").ProductionCaptureConfig | null;
/** False for development, tests, verification and all currently unconfigured builds. */
declare const __ANALYTICS_RELEASE_BUILD__: boolean;
