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

## Attribution probes

The idle windows say how much CPU each process uses; they cannot say what runs. Two optional
probes attribute recurring work and retained query data in the same instance, after any idle
windows and before `--live-profile`. Both read Electron's private `ipcMain` invoke registry
for diagnosis only, as `--covered-idle` does. Only `--query-retention` also reads React's root
container fiber. A missing required structure fails that capture instead of reporting zero.
Both probes restore the original invoke handlers on success or failure. If the session prevents
restoration, its cleanup error is retained alongside any capture failure.

`--steady-profile` keeps a channel playing and observes three states in turn: Live TV All
channels with its compact preview, Watch over that page, and Home's muted preview. Each gets a
60-second main and renderer V8 profile at 1,000 microseconds with the invoke calls made during it,
then a separate 20-second Chromium trace with the profiler stopped. Profiles are summarized by
function self time with their three heaviest stacks; `(idle)`, `(program)` and
`(garbage collector)` stay separate. Program time is outside attributed JS and does not identify
a native CPU owner. Invalid intervals, missing nodes/sample references, or empty, mismatched or
non-finite time deltas fail the capture. Traces
report each thread's outer-task thread time and the renderer main thread's inclusive timeline
events and script entry points. Thread time covers traced tasks only; work outside them is not
attributed. A thread with missing task durations reports partial or unsupported CPU, retaining
observed time, observed/missing task counts and the missing tasks' wall time. Only a thread with
all outer-task durations has a complete CPU total. Timeline/script
aggregates retain wall time and count when thread durations are missing. Their `cpuMs` is null,
with an explicit unsupported/partial CPU observation and its observed/missing event counts.
Complete CPU totals rank first; incomplete aggregates follow by wall time. Equal-start nested
tasks count their outermost interval once, independent of input order. A trace without a unique
expected renderer main thread and task observations fails, as does an empty trace. Completion
has a 30-second deadline and rejects session closure. Explicit CDP data loss fails the capture
after retaining the supplied raw stream. Listeners are removed on success or failure. Stream
reads have a separate 120-second total deadline, and stream close has a 10-second bound. A close
failure also fails the capture; if reading failed too, both errors are retained. The profiler and
tracing add work, so these windows explain where time goes, not how much an idle window costs.

Each steady window and individual profile has ISO `startedAt`/`endedAt` wall-clock brackets;
the separate trace has its own brackets. These span the start/stop protocol commands, including
their response latency. For main-profile load alignment use that profile's brackets. Select the
nearest unique load-log sample at or before each boundary, at most 10 seconds old. Missing,
stale or ambiguous samples make a window ineligible. Historical action timestamps around
`Begin <state> steady profile` and `Trace <state> for 20 seconds` are stronger anchors than file
mtimes; an mtime-derived interval is a labeled historical fallback only. Load alignment alone
does not approve a clean reference set, exclusions or a floor. Freeze the unchanged-parent
reference samples and twice-clean-median rule before candidate data; retain every rejection.

`--query-retention` browses All channels, every topic, the first four provider lists of the
first country, the guide grid and one country filter applied and cleared, then opens one details
sheet in Movies and in Series. At each lifecycle point it records the renderer's React Query
entries with their observers, activity, `gcTime` and the JSON UTF-8 size of their data; renderer
and main V8 heaps after two collections; main's `process.memoryUsage()`; Electron's per-process
working sets; and the invoke calls and JSON reply sizes since the previous point. The points are
the churn's start and end, Home, Home after a timed warm return to Live TV, Home once the longest
inactive query's own `gcTime` plus 15 seconds has passed, and Live TV after a timed cold return.
One renderer heap snapshot is retained at the point of most inactive data. JSON size is a
serialization measure, not heap retention; heaps exclude worker isolates; working sets include
native allocations and are not heap. The fixture holds only synthetic data.

Timed returns use the existing renderer mutation observer and bounded 5 ms probe, with the
click and rows-ready predicate in the same renderer observation. `retention.returnTiming`
retains that configured resolution and the known-delay calibration samples. Calibration of an
idle simple predicate does not establish observation error under load. Reply sizing is disabled
during timed returns, while call counting stays on; `ipcReplySizing: false` records that choice.
Zero reply bytes in those counts mean sizing was disabled. Other retention intervals size replies.
Historical returns without renderer timing metadata used a harness clock and a 250 ms `waitFor`
poll; keep them labeled
quantized and recollect unchanged-parent timings before applying R3. Its existing timing rule
and floor remain unchanged.

Query inventory hashes are truncated to 240 characters. A full-catalogue count requires a
complete parseable All key, all four filters empty, and successful populated data. Truncated
or unparseable keys cannot establish that count. These counts do not prove content identity.
Local aggregates retain unavailable observations and their capture IDs. A rule range is
unavailable if any required completed capture lacks the observation; its sample count cannot
silently shrink. Partial and unsupported trace threads stay in the inventory, with no complete
CPU total for a group containing either. Missing load logs retain every affected window as
ineligible and list the missing input. These reducers select no exclusions or thresholds.

Future stream-filter bench outputs carry no historical numerical floor. The v1 recipe keeps
output hashing and byte counting inside the timed loop. Preserve historical receipts with their
original identities; current-parent floors require fresh unchanged-parent calibration.

Run them separately from the idle calibration when CPU windows matter, for example:

```sh
xvfb-run -a node apps/desktop/test/e2e/measure-app.ts \
  --runs 1 --subscriptions 2 --steady-profile --query-retention --diagnostics-only \
  --revision <measured-build-sha> --json .local/measurements/attribution.json \
  apps/desktop/node_modules/electron/dist/electron -- --no-sandbox <frozen-app-directory>
```

Profiles, traces and the snapshot sit beside the probe file as
`<json>.probes.json.steady-<state>.<main|renderer>.cpuprofile`,
`<json>.probes.json.steady-<state>.trace.json` and `<json>.probes.json.retention.heapsnapshot`.
Each steady window and retention point is saved to the probe file as it completes, so a failed
capture keeps what it observed.

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
