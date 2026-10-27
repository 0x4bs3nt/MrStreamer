# Agent workflows

Use the stack's installed skills for the task method and this repo's `verify-mrstreamer` skill for desktop and website runtime control. Keep them separate: this repo does not vendor implementation, bug-fix, investigation, performance, review, autopilot or shipping skills.

`AGENTS.md` remains the repository policy; `CLAUDE.md` imports it. Read the project README and matching card before implementation. Runtime verification does not authorize publishing, deployment or touching a daily-driver profile. Questions are read-only.

## Choose the task method

Follow the current global `AGENTS.md` skill routing: load matching installed skills, use `html-communication` and PostPlan for substantive human plans and reports, and use `paper` for nontrivial UI comparisons before editing components. Share the Paper link and wait for a choice; use `ui-ideas` only for a requested in-app comparison after Paper is rejected.

When available, the installed `poteto-mode` routes task requests to `feature-implementation`, `bug-fix`, `investigation`, `refactoring`, `performance`, planning and review workflows. Individual workflows can also be selected directly. Their descriptions support automatic selection; a prompt naming the workflow is useful when you want a particular method. If those skills are absent on another machine, follow repository policy and `docs/contributing/testing.md` directly rather than inventing a successful skill invocation.

For implementation or bug fixes, use the relevant desktop or website feature-map entry to reproduce and verify the changed user paths. For refactors, verify preserved behavior at those entry points. For independent review, inspect runtime evidence against the actual diff and run the relevant check when necessary. Performance work uses the existing `measure-app.ts` and comparison guidance in testing; the baseline verification helper does not measure performance. PR and release work retains its existing audit, permission and native acceptance gates.

## One project-specific skill

The maintained body, helper, feature map and maintenance loop are in `.cursor/skills/verify-mrstreamer/`, following pstack's template. `.agents/skills/verify-mrstreamer/` and `.claude/skills/verify-mrstreamer/` are small discovery entrypoints that read that same body. They contain no second workflow or copied helper. Plain files work on Windows as well as Unix, without Git symlink setup.

Use the MR Streamer checkout as the agent's workspace. A T3 thread attached to another repository will not discover MR Streamer's project-local skill. After adding the skill, refresh discovery or start a fresh agent in this checkout. No global install is needed.

Codex can invoke `$verify-mrstreamer`; Claude/Cursor can invoke `/verify-mrstreamer`. Example: "Use verify-mrstreamer to verify this playback change, including the Live TV list entry point." Normal discovery is enabled. The AGENTS pointer connects ordinary desktop coding/review tasks to the skill even when you do not name it.

## Prepare and prove

Run `pnpm check` for lint, formatting, type checks, unused code and workflow checks. `pnpm lint:fix` applies safe lint fixes with the same failure flags; run `pnpm check` after fixing. Run affected tests separately, and build before the runtime checks below.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm verify:desktop doctor
pnpm verify:desktop live-tv
```

On headless Linux use `xvfb-run -a pnpm verify:desktop live-tv`. Other baseline scenarios are `subscriptions`, `titles` and `watchlist`. Each starts a real built app against fake provider/TMDB services, captures UI and side effects, then tears down its isolated instance. Evidence remains in gitignored `.local/verification/`.

Inspect the relevant feature entry before treating a baseline as acceptance. For website changes, build with `pnpm build:marketing`, then use collaborative preview or, when unavailable, `xvfb-run -a pnpm verify:website`. The website entry documents routes, responsive checks, link proof and limits.

Use the installed `architect` skill when types, ownership and module boundaries need a design first; keep delivery sequencing in `multi-phase-plan`.

Use the installed `mac-mini` skill for native macOS checks, including its `onmac` synchronization and installed `cua-driver` controls. The verification skill has checkout-scoped command recipes and evidence pull/cleanup guidance. Real subscriptions, native audio/GPU behavior, installers/updates and TV receivers still need their own documented checks.

Keep the relevant feature entry current in a product change. To audit the entire map, ask "Use verify-mrstreamer to maintain its feature map" and follow its maintenance reference. This reuses the same skill and adds no global workflow or recurring schedule.

## Automated PR reviews

CodeRabbit and Cubic supplement CI and the independent-review/pr-audit gates. Use the free public OSS review path only. Do not enable paid seats, overflow/flex, API features, or trial-dependent tools. A free allowance can pause reviews, and CodeRabbit can report a passing rate-limit check without reviewing; batch pushes and wait for the reset instead of buying capacity.

CodeRabbit currently requires a manual trigger for each head on public repos below 10 stars. Use `@coderabbitai review` for the latest changes; avoid repeated full-review commands. It skips drafts, keeps its built-in generated/binary filters and explicitly includes pnpm lockfiles. Keep its coverage, including tests, and full independent Sol/Opus review of the entire diff. No custom exclusions hide accidentally committed local secrets. Fixes, generated tests/docstrings, automated approval and merge are disabled. Reviewers use AGENTS.md; CI owns formatting and lint.

Cubic is manual-only and excludes only the test/fixture paths in `cubic.yaml`. Complete local CI checks, applicable runtime proof, independent review and resulting fixes before the first hosted request. On the intended final head, request `@cubic-dev-ai review this PR` once. For necessary follow-up fixes, batch them and request `@cubic-dev-ai incremental review`, which reviews changes since the last completed review. Never routinely request another full review. If Cubic cannot establish a safe completed baseline, inspect its skip reason before deliberately requesting a replacement full review. Keep auto-fix, auto-approval and Ultrareview disabled. Wout keeps auto-resolution of addressed threads enabled; verify fixes before merging even when a thread is already resolved.

Before accepting a review, confirm its reviewed head matches the latest PR commit and inspect skipped paths. For Cubic, require continuous full-plus-incremental coverage of the retained diff through the latest head. For an excluded-only PR, record that Cubic has no retained diff and use CI, CodeRabbit and independent review without claiming a completed Cubic review. Verify findings against the source, fix real defects and record a written disposition for every finding, including false positives. An old green review is not evidence for a newer push. CodeRabbit's commit-count auto-pause is disabled, but manual pauses and rate limits still need attention.

CodeRabbit reads `.coderabbit.yaml` from the PR branch. Cubic reads `cubic.yaml` only from default `main`, so a configuration PR uses the old main settings. Validate the candidate against the live official JSON schema before merging, then inspect effective settings and validation errors after merge. Invalid Cubic YAML falls back to dashboard settings, so a completed review alone does not prove the YAML applied.

On the next genuine PR after the configuration merges, record the default-branch configuration SHA, effective settings, changed and skipped paths, absence of unsolicited opening/push reviews, and explicit full review's head on its matching project card. Record the completed baseline and final SHA for a naturally needed incremental follow-up; otherwise leave incremental adoption proof pending. Confirm free public entitlement without relying on a trial. Do not seed defects or open a throwaway PR to get a bot comment. Required-check or branch-protection changes need known check names and separate maintainer approval.

References: [CodeRabbit review limits](https://docs.coderabbit.ai/management/plans), [path-filter overrides](https://docs.coderabbit.ai/configuration/path-instructions), [Cubic configuration](https://docs.cubic.dev/configure/cubic-yaml), [manual-review FAQ](https://docs.cubic.dev/ai-review/ai-review-settings#faq), [review commands](https://docs.cubic.dev/ai-review/interactive-comments#trigger-reviews) and [public fair use](https://docs.cubic.dev/account/ai-review-usage).
