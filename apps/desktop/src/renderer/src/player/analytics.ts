import type {
  AnalyticsPlaybackKind,
  AnalyticsPlaybackState,
  AnalyticsFailure,
  PlaybackControl,
} from "@mrstreamer/contracts/analytics";
import type { AppError } from "@mrstreamer/contracts/errors";
import type { StreamFailure } from "@mrstreamer/contracts/playback";
import { call, listen } from "../lib/ipc.ts";

let controlOrder = 0;

/** One controller's current run/binding only. Main owns all events, clocks and consent. */
export class PlaybackObservation {
  private control: PlaybackControl | null = null;
  private binding: Promise<string | null> = Promise.resolve(null);
  private generation = 0;
  private sequence = 0;
  private session: string | null = null;
  private active = false;
  private onRemote = false;
  private eligible = true;
  private state: AnalyticsPlaybackState = "waiting";
  private pendingState: {
    generation: number;
    sequence: number;
    state: AnalyticsPlaybackState;
  } | null = null;
  private sendingState = false;

  private readonly kind: AnalyticsPlaybackKind;

  constructor(kind: AnalyticsPlaybackKind) {
    this.kind = kind;
    listen("analytics.reset", () => {
      if (!this.active || this.onRemote) return;
      const session = this.session;
      this.begin(true);
      if (session) this.bind(session);
    });
  }

  begin(ongoing = false): void {
    this.generation++;
    this.pendingState = null;
    this.active = true;
    this.onRemote = false;
    this.session = null;
    this.state = "waiting";
    this.binding = Promise.resolve(null);
    this.control = { control: crypto.randomUUID(), order: ++controlOrder, ongoing };
    void call("analytics.playbackBegin", { kind: this.kind, measurement: this.control }).catch(
      () => {},
    );
  }

  /** Gameplay carries this immediately; optional observation responses never gate it. */
  measurement(): PlaybackControl | null {
    return this.control;
  }
  hasRun(): boolean {
    return this.active;
  }

  bind(session: string): void {
    this.generation++;
    this.sequence = 0;
    this.session = session;
    this.onRemote = false;
    const generation = this.generation;
    const measurement = this.control;
    this.binding = (async () => {
      if (!measurement || generation !== this.generation) return null;
      const token = measurement.control;
      const binding = await call("analytics.playbackBind", {
        kind: this.kind,
        measurement,
        sessionId: session,
      }).catch(() => null);
      if (generation !== this.generation) return null;
      if (binding) {
        await call("analytics.playbackEligible", { token, eligible: this.eligible }).catch(
          () => {},
        );
        this.note(this.state);
      }
      return binding;
    })();
  }

  adoptRemote(): void {
    this.generation++;
    this.active = true;
    this.onRemote = true;
    this.session = null;
    this.binding = Promise.resolve(null);
    this.control = { control: crypto.randomUUID(), order: ++controlOrder, ongoing: true };
    void call("analytics.playbackResume", { kind: this.kind, measurement: this.control }).catch(
      () => {},
    );
  }

  remote(): void {
    this.unbind();
    this.onRemote = true;
  }

  unbind(): void {
    const sequence = ++this.sequence;
    const token = this.control?.control;
    void this.binding.then((binding) => {
      if (token && binding)
        return call("analytics.playbackState", {
          token,
          binding,
          sequence,
          state: "stopped",
        }).catch(() => {});
    });
    this.generation++;
    this.pendingState = null;
    this.session = null;
    this.binding = Promise.resolve(null);
    this.state = "waiting";
  }

  setEligible(eligible: boolean): void {
    this.eligible = eligible;
    const generation = this.generation;
    const token = this.control?.control;
    if (token && generation === this.generation && !this.onRemote)
      void call("analytics.playbackEligible", { token, eligible }).catch(() => {});
  }

  note(state: AnalyticsPlaybackState): void {
    this.state = state;
    this.pendingState = { generation: this.generation, sequence: ++this.sequence, state };
    this.sendState();
  }

  /** A stalled main process leaves one in-flight fact and one newest fact, never a history. */
  private sendState(): void {
    if (this.sendingState || !this.pendingState) return;
    const note = this.pendingState;
    this.pendingState = null;
    this.sendingState = true;
    const token = this.control?.control;
    void this.binding
      .then(async (binding) => {
        if (token && binding && note.generation === this.generation && !this.onRemote)
          await call("analytics.playbackState", {
            token,
            binding,
            sequence: note.sequence,
            state: note.state,
          }).catch(() => {});
      })
      .finally(() => {
        this.sendingState = false;
        this.sendState();
      });
  }

  failure(failure: AnalyticsFailure): void {
    const token = this.control?.control;
    void this.binding.then((binding) => {
      if (token && !this.onRemote)
        return call("analytics.playbackFailure", { token, binding, failure }).catch(() => {});
    });
  }

  end(): void {
    const token = this.control?.control;
    this.unbind();
    this.active = false;
    if (token) void call("analytics.playbackEnd", { token }).catch(() => {});
    this.control = null;
  }
}

export function playbackFailure(error: AppError): AnalyticsFailure {
  switch (error.kind) {
    case "stream":
      return streamFailure(error.failure);
    case "unreachable":
      return "network";
    case "invalid-login":
    case "account-inactive":
    case "needs-secret":
    case "keychain-refused":
      return "credentials";
    case "channel-not-found":
    case "title-not-found":
    case "no-subscription":
    case "provider-error":
      return "unavailable";
    case "output":
      return error.failure.kind === "stream" ? streamFailure(error.failure.failure) : "unavailable";
    default:
      return "app";
  }
}
export function streamFailure(failure: StreamFailure): AnalyticsFailure {
  switch (failure.kind) {
    case "network":
      return "network";
    case "unsupported":
      return "unsupported";
    case "refused":
      return failure.status === 401 || failure.status === 403 ? "credentials" : "unavailable";
    default:
      return "unavailable";
  }
}

/** Reports bounded facts only. Playing requires unpaused clock progress after a seek/wait. */
export function observeMediaPlayback(video: HTMLVideoElement) {
  let listener: ((state: AnalyticsPlaybackState) => void) | null = null;
  let position = video.currentTime;
  let state: AnalyticsPlaybackState = "waiting";
  let stopped = false;
  const say = (next: AnalyticsPlaybackState) => {
    state = next;
    listener?.(next);
  };
  const waiting = () => say("waiting");
  const paused = () => say("paused");
  const seeking = () => {
    position = video.currentTime;
    say("seeking");
  };
  const seeked = () => {
    position = video.currentTime;
    waiting();
  };
  const ended = () => say("stopped");
  const timer = setInterval(() => {
    const now = video.currentTime;
    say(
      video.ended
        ? "stopped"
        : video.paused
          ? "paused"
          : video.seeking
            ? "seeking"
            : now > position + 0.01
              ? "playing"
              : "waiting",
    );
    position = now;
  }, 1000);
  video.addEventListener("waiting", waiting);
  video.addEventListener("pause", paused);
  video.addEventListener("seeking", seeking);
  video.addEventListener("seeked", seeked);
  video.addEventListener("ended", ended);
  return {
    listen(next: (state: AnalyticsPlaybackState) => void) {
      listener = next;
      next(state);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      ended();
      clearInterval(timer);
      video.removeEventListener("waiting", waiting);
      video.removeEventListener("pause", paused);
      video.removeEventListener("seeking", seeking);
      video.removeEventListener("seeked", seeked);
      video.removeEventListener("ended", ended);
    },
  };
}
