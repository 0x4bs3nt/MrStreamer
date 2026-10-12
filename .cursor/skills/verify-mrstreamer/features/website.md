# Marketing website

## Sub-features

Home and system-specific download buttons, the full download page, seven user guides, the grouped FAQ, release history, About, Security and Privacy. Responsive layout and route/metadata correctness are part of the website contract.

## How to get to it (user POV)

Open Home. **Guides** opens `/docs`; select **Subscriptions** or another guide. **FAQ** in the header or footer opens `/faq`, with four groups of question/answer rows. The old `/#questions` destination is a one-line FAQ link. Header Guides, FAQ and Downloads remain visible on phones. **Downloads** opens `/download`, with verified installer links and requirements. Footer links open **Releases**, **Privacy**, **About** and **Security**. The homepage's hero button depends on the visitor's system; its Downloads link scrolls to the complete list. Unknown addresses show a 404.

## Driving it with browser/CDP

Preconditions: `pnpm install --frozen-lockfile`, then `pnpm build:marketing`. Build assets and route/link checks are local output only. The build may read public GitHub release metadata and installer headers; it does not deploy the site or download installers.

For interactive verification, use T3 collaborative preview first. Run the repo's `pnpm preview:marketing` with an unused loopback port and `--strictPort`, open that owned local URL, inspect a snapshot and click its semantic link handles. Capture Home, the changed route and the relevant narrow viewport. Verify actual link destinations, canonical/title metadata and status codes alongside the rendered page. Stop only the server you started. Do not attach to or deploy the production website.

When collaborative preview is absent or reports browser setup unavailable, run `pnpm verify:website`, or `xvfb-run -a pnpm verify:website` on headless Linux. This complete baseline session owns a Vite preview, isolated Electron browser and profile. It records real pointer navigation from Home through FAQ, the Downloads guide, Guides, Subscriptions, Downloads, Releases and Privacy, paired screenshots/accessibility trees and route metadata. It also disables page scripts and verifies FAQ content and navigation to the Downloads guide. Keep the full navigation flow at 390px without horizontal overflow. Require known routes to answer 200 and an unknown route to answer 404. Check all four displayed installer destinations or their GitHub Releases fallback and the Microsoft Store product; the helper inspects links without following them. Its live doctor checks browser and server identity before driving and after each navigation. The helper captures after navigation or scrolling; an unchanged viewport reuses its preceding capture, named in the before-click proof. Captures wait for fonts, finite animations and rendering to settle; visually inspect them before accepting the proof. All proof remains in `.local/verification/website-<unique>/` after both processes and scratch state are removed.

The existing `apps/marketing/test/` suites verify OS detection, link/feed fallback, page rendering and release-history contracts. Run those for changes to those behaviors. For FAQ/privacy changes, capture the changed pages at desktop and 390px, follow the FAQ links into the mapped-playlist, offline-download, update and privacy guides, and check their fragments. Check the header and footer on Home, generated pages and 404, keyboard focus, the retained `/#questions` destination and readable FAQ content with scripts disabled. The policy follows collection, use, recipients and choices; keep its statistics and download claims aligned with delivered app behaviour.

The baseline alone does not exercise Windows/Mac user-agent variants, all seven guides, About/Security, live feed refresh, no-script mode or Safari. Use the installed `mac-mini` skill's control tools for native Safari checks on the Mac mini, recording the real browser and viewport.

Source: `apps/marketing/README.md`, `apps/marketing/scripts/pages.ts`, `apps/marketing/src/downloads.ts`, `apps/marketing/src/system.ts`, `apps/marketing/vite.config.ts` and `apps/marketing/test/`.

## Screenshot assets

The four lossless masters and their checked capture manifest are under `docs/assets/marketing-*`. Follow `docs/contributing/marketing-artwork.md` for the licensed demo, Mac mini source capture and owned cleanup. `prepare-assets.ts` builds desktop/phone WebP sizes and the social PNG. Home's per-entry `provenance` records its Stage source build; the manifest's top-level provenance still describes the three unchanged PR 208 captures. Home keeps the complete Stage window on phones and social links; watching keeps the subtitle beside its current right-hand panel. Inspect these actual assets and the rendered site at wide and 390px widths after a refresh, checking each `<picture>` source's intrinsic dimensions and descriptions. Build output stays ignored.

## IndexNow deployment notifications

Vite generates the canonical sitemap, UTF-8 root ownership file and unique `indexnow-build.json` from `PAGES`. `package-vercel.ts` validates their contents against the registry and source commit. The separate marketing deployment notification job consumes artifacts from that run without owner secrets, after the actual non-superseded Publish step succeeds. It checks the literal public domain's ownership file and exact build marker before one bounded POST. Rollback pinning and propagation failures report failure with the deployment already complete. HTTP 200 means received; 202 means received with ownership validation pending. Neither proves indexing.

Run `pnpm vitest run apps/marketing/test/indexnow.test.ts test/marketing-workflow.test.ts`, then `pnpm build:marketing`. Inspect the actual packaged ownership file, marker/revision, sitemap and Vercel filesystem routes. Retain local fixture request counts, outcomes and original exits. Tests use loopback public/API fixtures only. Do not submit to IndexNow during verification. Actual production propagation, search-engine receipt and indexing require separately authorized deployment and observed results. See `apps/marketing/README.md` for stable public-key rotation and bounded failure behavior.

## Gotchas

Build-time release history can fall back to truthful GitHub links when unavailable. The isolated baseline browser blocks external requests, so it proves the built fallback/links, not successful live refresh, production analytics or installer downloads. Record what was observed rather than calling all network behavior verified. A 390px desktop-browser viewport is responsive evidence, not a physical-phone or Safari check. Native OS download choices require the matching user agent. Prefer the current page registry to guessing route aliases.
