# Desktop CPU and profiling probes

`measure-app.ts` owns optional diagnostics alongside its existing timing workload. They change
no product code and use the same disposable profile, fake providers, warmup, CDP connection and
cleanup. Run them separately from comparisons and the 126-second `--covered-idle` IPC capture.
They are manual release investigations, not per-PR benchmarks.

```sh
xvfb-run -a node apps/desktop/test/e2e/measure-app.ts \
  --runs 1 --subscriptions 2 --idle-probes --live-profile --diagnostics-only \
  --revision <measured-build-sha> --json .local/measurements/probes.json \
  apps/desktop/node_modules/electron/dist/electron -- --no-sandbox <frozen-app-directory>
```

On macOS use the native display and `--use-mock-keychain` instead of Xvfb and `--no-sandbox`.
The probes currently require a built checkout with its own immutable `package.json` and `out`
tree. An executable alone cannot identify a checkout build. Keep its dependency link valid.
`--diagnostics-only` skips ordinary measured interactions and cold starts after warmup, so its
output is not valid comparator input. Either probe can also run alone. The default
`--host-condition diagnostic` describes a busy or unverified host. `--host-condition quiet`
records the operator's assertion of quiet conditions, not an automated check or a calibration.

## What is measured

`--idle-probes` observes three separate requested 60-second windows after a two-second settle:

- Visible Live TV, All channels, with the chosen channel playing in its compact preview.
- That same mounted Live TV page covered by Watch, with playback continuing.
- That same Watch window hidden with Electron's `BrowserWindow.hide`, with playback continuing.

This is a steady playback workload, not a stopped-player CPU budget. The two-provider fixture
generates 26,000 channels; ordinary visibility and grouping can display fewer. Each window
retains the visible row count, document visibility and media-clock boundary observations.
A window state or playback mismatch fails the capture. Focus emulation is disabled for idle
windows. No renderer timer, requestAnimationFrame observer or V8 profiler runs during them.
A main-inspector snapshot every five seconds records the actual window state, every Electron
process metric and host load. Endpoint reads retain their actual monotonic times and latency.
The elapsed interval can exceed 60 seconds under scheduling delay; all CPU calculations use
the actual duration, not the requested one. A late probe is retained, not discarded.

CPU is the change in `cumulativeCPUUsage`, in seconds, divided by actual elapsed time. The
reported percentage uses one logical core as 100%; it is not divided by host CPU count. Missing,
non-finite or reset counters are unsupported, never zero. PID plus creation time identifies
each process. Main PID must match the launched child; renderer PID comes from the verified
BrowserWindow, not the first process with a matching name. Inspector profile and renderer
build URL must match the owned instance. Boundary snapshots include window focus and visibility.
Before login, the main PID/profile and the browser's actual profile/debug-port arguments must
match the launched child. Probes add `--enable-automation` for that public CDP command. The
disposable profile is resolved to its real path before launch, so macOS `/var` aliases do not fail
the same exact ownership checks. A URL
match alone cannot prove ownership when two checkouts load the same renderer. An unverified
page is closed without a failure screenshot or DOM capture.

Linux additionally inventories descendants through `/proc` parent links and start ticks, with
user plus system CPU ticks and the host's `CLK_TCK`. That includes external player tools which
Electron may omit. Process counters include their threads. This is not a complete lifetime
accounting system: children born and exited between snapshots can be missed, and a disappearing
child has no endpoint delta. There is no fabricated aggregate total. Other OS descendant
inventories are explicitly unsupported; Electron's process list is still retained.

Wakeups have a separate support field and units of wakeups/second. On macOS the genuine source
is Electron's task interrupt wakeup rate. Its interval is shared with other callers of
`app.getAppMetrics`, so raw rates and sample spans remain necessary. Linux's Electron field is
derived from voluntary context switches. It is retained as a raw Electron field but **not a
wakeup measurement**. Windows always returns zero for that field, which is also unsupported.
The harness does not relabel context switches, timer counts or CPU time as wakeups. A genuine
Linux scheduler trace would need a separately available, authorized source; this probe does
not change tracing permissions or host policy.

Sources: [Electron CPUUsage](https://www.electronjs.org/docs/latest/api/structures/cpu-usage),
[ProcessMetric identity](https://www.electronjs.org/docs/latest/api/structures/process-metric),
[Chromium Linux counter](https://chromium.googlesource.com/chromium/src/+/main/base/process/process_metrics_linux.cc),
[Chromium macOS counter](https://chromium.googlesource.com/chromium/src/+/main/base/process/process_metrics_apple.mm).

## Calibration and retained profiles

Each diagnostic retains three back-to-back observer pairs and three 150 ms busy pulses in each
of main and renderer. Raw snapshots and CPU deltas check units, attribution and snapshot cost.
Playback continues during this diagnostic, so a pulse is not an isolated CPU standard. Linux
records the tick counter's boundary resolution floor separately from host variability. Neither
the counter floor nor a successful pulse establishes an idle regression threshold.

`--live-profile` retains paired main and renderer `.cpuprofile` files, sampled at 1,000 microseconds,
plus action timestamps and the busiest sampled frames. The selected UI path changes category,
scrolls All channels, opens and scrolls the grid, searches programmes for `news`, opens Watch's
channel overlay and returns to Live TV. It verifies UI readiness at the relevant transitions.
Search closes fully before Watch opens, so its ending dialog cannot retain the keyboard.
Returning from Watch waits for the channel overlay and then Watch itself to close before
addressing the underlying page. Profiles stop and retain partial captures even when an action fails. These are V8 isolate self
samples, including idle/program frames; they exclude other worker isolates, native stacks,
GPU and painted frames. The existing `pnpm verify:desktop guide-grid-scroll` remains the deeper
20k-channel/two-day renderer/frame diagnostic. Native scroll/paint acceptance stays separate.

`<json>.probes.json` checkpoints every raw sample and retains full hashes for the runtime
folder and the app's package/output files, process/runtime identity, calibration and failures.
The hashes are rechecked after success. The main output retains host/tool/build metadata,
workload and warmup observations; `<json>.cleanup.json` records teardown. A failed probe exits
nonzero with `invalid-instrumentation`, partial evidence and the existing failure screenshot.
No new percentage or speed claim is inferred automatically.

## Quiet follow-up after integration

Freeze baseline and candidate output independently, including renderer, preload, workers and
resources. Retain their source revisions and manifests. Do not rebuild either while measuring.
First repeat the unchanged baseline probes five times on a quiet host. Review counter floors,
snapshot cost, window lateness and observed per-state ranges. Record and freeze the selected
absolute CPU/wakeup observation limits, supported sources and rationale before any subsequent
hot-path optimization. An unavailable wakeup source cannot acquire a threshold. The probe
intentionally leaves thresholds unfrozen; its JSON has no guessed regression policy.

Run the regular comparator on the same quiet host, retaining all samples and failures:

```sh
xvfb-run -a node apps/desktop/test/e2e/compare-builds.ts \
  --rounds 5 --runs 1 --subscriptions 2 --search-runs 6 \
  --baseline-revision <baseline-sha> --candidate-revision <candidate-sha> \
  --baseline-app-dir <frozen-baseline-directory> \
  --candidate-app-dir <frozen-candidate-directory> \
  --output .local/measurements/final-comparison \
  <baseline-electron> <candidate-electron> -- --no-sandbox
```

That produces 30 search samples per query per side. Use the existing comparator rules for
latency, memory and admission counts. Separately run the fixed probes against baseline and
candidate in five alternating rounds using identical arguments and frozen calibrated limits.
Repeat observed separated regressions before calling them product changes. Run
`measure-app.ts --covered-idle --runs 1 --subscriptions 2 ...` separately; the comparator does
not forward `--covered-idle` or these optional probes. Reuse the Live TV feature map's
`live-tv`, `guide-grid`, `guide-grid-scroll` and 64k `live-categories` functional paths.
A noisy diagnostic is useful for support and failure handling, not a final before/after claim.
