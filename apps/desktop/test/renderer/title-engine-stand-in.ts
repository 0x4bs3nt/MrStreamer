import type {
  TitleEngine,
  TitleError,
  TitleRun,
} from "../../src/renderer/src/player/title-engine.ts";

/** Manual title runs at the controller boundary. Each test clears its own isolated module's runs. */
export const runs: {
  readonly run: TitleRun;
  position: number;
  played: number;
  destroyed: boolean;
  start(): void;
  end(): void;
  fail(error: TitleError): void;
}[] = [];

/** Holds startup until the test starts or fails it; later failures use the registered listener. */
export function titleEngine(video: HTMLVideoElement, run: TitleRun): TitleEngine {
  const { promise: started, resolve, reject } = Promise.withResolvers<void>();
  started.catch(() => {});
  let playing = false;
  let failure = (_error: TitleError) => {};
  let ended = () => {};
  const entry = {
    run,
    position: run.start,
    played: 0,
    destroyed: false,
    start() {
      playing = true;
      if (run.paused) video.pause();
      else void video.play();
      resolve();
    },
    end: () => ended(),
    fail(error: TitleError) {
      if (playing) failure(error);
      else reject(error);
    },
  };
  runs.push(entry);
  return {
    started,
    onFailure(listener) {
      failure = listener;
    },
    onEnded(listener) {
      ended = listener;
    },
    position: () => entry.position,
    played: () => entry.played,
    seekWithin: () => false,
    onSubtitles() {},
    hideSubtitles() {},
    readingAhead() {},
    info: () => ({
      width: null,
      height: null,
      fps: null,
      videoCodec: null,
      audioCodec: null,
      audioChannels: null,
    }),
    destroy() {
      entry.destroyed = true;
    },
  };
}
