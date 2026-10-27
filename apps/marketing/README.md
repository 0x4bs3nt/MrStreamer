# The website

Static pages for `https://mrstreamer.app`, built with Vite from HTML, CSS, TypeScript and the repository's Markdown. The homepage's pictures are captures of the real app and cuts of them, kept in `docs/assets` and described in [marketing artwork](../../docs/contributing/marketing-artwork.md).

| File                                                                         | Holds                                                                          |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `index.html`                                                                 | The homepage: hero fan, two features, subscription, Download                   |
| `src/page.html`                                                              | The shared FAQ, privacy, guides, about, security, download and releases layout |
| `src/faq.html`                                                               | Grouped questions and answers, readable without scripts                        |
| `src/download.html`                                                          | The visitor's system first, installer rows, checksum and source links          |
| `faq/`, `privacy/`, `docs/`, `about/`, `security/`, `download/`, `releases/` | HTML entry points, expanded by the build                                       |
| `404.html`                                                                   | The page for a missing address                                                 |
| `src/styles.css`                                                             | Layout, the download page's system block and finite homepage motion            |
| `src/main.ts`                                                                | Starts website analytics, homepage motion and one download-feed refresh        |
| `src/analytics.ts`                                                           | Website analytics: the footer and policy switch and the fixed events           |
| `src/referrals.ts`                                                           | Where a visit entered, as fixed codes for page views and download clicks       |
| `scripts/site-analytics.ts`                                                  | Which PostHog endpoint, if any, a build compiles in                            |
| `src/system.ts`                                                              | Which system a visitor is on, for the download page's first block              |
| `src/downloads.ts`                                                           | Verified installer links, version metadata and the release's auxiliary links   |
| `scripts/pages.ts`                                                           | Page registry, metadata and Markdown rendering with public documentation links |
| `scripts/releases.ts`                                                        | Paginated stable release history from GitHub, with a bounded fallback          |
| `vite.config.ts`                                                             | Build inputs, HTML expansion and local routing                                 |
| `scripts/prepare-assets.ts`                                                  | Pictures, cuts, icons and the social picture; with `--readme`, the README's    |
| `scripts/package-vercel.ts`                                                  | Vercel's static package, routes and public page/link checks                    |
| `public/`                                                                    | `robots.txt` and the Store, Apple and Linux marks                              |
| `test/`                                                                      | Download, system detection, static document and release-history contracts      |

`public/generated/`, `dist/` and `.vercel/` are built and stay out of git.

## Run it

From the repository root, with Node 24 and pnpm 11:

```sh
pnpm install
pnpm dev:marketing       # the site with live reload, on http://localhost:5173
pnpm build:marketing     # pictures, pages and the Vercel package
pnpm preview:marketing   # the built site, on http://localhost:4173
```

`pnpm build:marketing` checks every listed page's metadata, sitemap entry, scripts, styles and referenced assets. It checks that every Markdown source's headings reached its page and that internal links and fragments exist. It also checks installer URLs, the system script on the home and download pages and the homepage's structured data. `scripts/package-vercel.ts` lists the checks. The build reads paginated GitHub releases, selects the highest complete stable release and verifies four installers. The update feed is a fallback when history is unavailable. Network failure leaves truthful GitHub links and does not fail the build. The existing workflow token authenticates the release-history request in CI; a local build works anonymously when neither `GH_TOKEN` nor `GITHUB_TOKEN` is available. Tokens are never written to HTML or logged.

`pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm knip` and `pnpm fmt:check` cover this folder with the rest of the repository.

## Addresses

Both local servers and Vercel answer the same addresses, with or without a query:

| Address                                                                                                                       | Answers                                                               |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `/`                                                                                                                           | Homepage                                                              |
| `/privacy`                                                                                                                    | Privacy policy from `docs/privacy.md`                                 |
| `/docs`                                                                                                                       | Six-guide index, with summaries from their metadata descriptions      |
| `/docs/subscriptions`, `/docs/live-tv`, `/docs/movies-and-series`, `/docs/updates`, `/docs/playback`, `/docs/troubleshooting` | The corresponding `docs/user/<slug>.md`                               |
| `/about`                                                                                                                      | Product facts from `docs/about.md`, with the verified stable version  |
| `/security`                                                                                                                   | Login storage, signing and checksums from `docs/security.md`          |
| `/download`                                                                                                                   | Current stable installers, requirements, checksums, notes and sources |
| `/releases`                                                                                                                   | Every published stable release and its date and notes, newest first   |
| Public files such as `/robots.txt` or `/sitemap.xml`                                                                          | The file                                                              |
| Any other address, including HTML aliases such as `/404.html`                                                                 | The 404 page, with status 404                                         |

Every document address also accepts a trailing slash. `scripts/pages.ts` is the address registry used by both local servers and Vercel packaging. Update `public/sitemap.xml` when adding a page; the build checks it against that registry.

`/llms.txt` answers `public/llms.txt`, a short Markdown overview for agents, as UTF-8 plain text. Keep its claims true to the public guides and link stable pages rather than versioned installers; the build checks its site links. It informs agents; it is not a robots policy or an indexing promise.

## Change it

- Keep the words true and few. Every claim on the page comes from the README or the docs. The app's limits are in [what plays](../../docs/user/playback.md).
- True black, white text, minimal copy. Screenshots describe the app, so a feature is its name and one sentence beside its window.
- The page order is the bar, the hero, its fan of Home/Live TV/TV Guide with a legend, two features, Is it for you?, Get Mr. Streamer and the footer. Is it for you? keeps the `what-you-need` id: a table of needs, what Mr. Streamer does and the players whose own pages document each need, stacked rows under a line naming its two columns on phones, linking to the README's dated sources and full comparison. Name a player there only when its own pages document that need; a player left out is unknown, not a no. Every app screen appears once. Header Guides, FAQ and Download stay visible on phones, and every Home download link goes to `/download`. The old `/#downloads` destination remains.
- The fan uses the Home stage crop on phones and the full Home window on wider screens. Details and subtitles are the two remaining gallery entries. The removed standalone Home window has no stand-up animation or scroll-driven tilt listener.
- Motion changes only transform and opacity, once. The bar, mark, headline, lines and button have a CSS opening animation, including without JavaScript. Other content visible at open, including the fan, starts at rest. A feature or fan entering later can reveal; `main.ts` removes its animation class and will-change when finished, out of view, hidden or reduced motion is requested. The button lifts 2 px under the pointer or keyboard focus. Reduced motion skips the opening and reveals. No animation runs at idle.
- The homepage title and description name the product and systems. Its single h1 names Mr. Streamer above one line that says what it is and one that names the systems. Structured data describes `SoftwareApplication` and `SoftwareSourceCode`, with the alternate product name, publisher, repository and five screenshots. `softwareVersion` comes only from a stable release with a verified installer. There are no invented ratings or reviews. Every document has its own metadata, canonical address and sitemap entry. Add no page for a single system or search phrase.
- New pictures come from new captures. Follow the [artwork recipe](../../docs/contributing/marketing-artwork.md). The features, the stack and a phone's hero show cuts of the windows, set in `prepare-assets.ts`, with their sizes repeated in `index.html`.
- Markdown remains the source for privacy, the seven guides, about and security. The site builds the checked-out `main`, rather than copying guides from a stable tag. Coordinate new feature documentation with its release. Relative guide links become public page links, retaining fragments. Documents that are not public pages link to GitHub, never to a nonexistent site route. Scripts are not needed to read any document. Merging a change to any rendered Markdown source starts the marketing publication workflow.

## Downloads

The homepage's Download links lead to `/download`. Its `#downloads` section, Get Mr. Streamer, keeps old `/#downloads` links useful: each system's requirement and install routes, with the formats as plain words, the Homebrew tap and AUR links the build writes only while published (`scripts/pages.ts`), and one button. `/download` puts the visitor's own system first, then a row for every system with a drawing of its file, then the checksum and source links.

### The visitor's system first

`src/system.ts` names the visitor's system from the browser's user agent, its touch points and, in Chromium, the platform it reports. The build writes that function's own text into the head of every page, where it runs before the page paints and sets `data-os` on `<html>`. On `/download`, `styles.css` shows the block that matches, so it never swaps after it shows.

| Visitor                                  | First block                                       | Goes to                        |
| ---------------------------------------- | ------------------------------------------------- | ------------------------------ |
| Windows                                  | Microsoft's Store badge, and Setup .exe beside it | The Store listing, the .exe    |
| Mac                                      | Download the DMG                                  | The DMG                        |
| Linux on a computer                      | Download the AppImage, and .deb beside it         | The AppImage, the .deb         |
| Anyone else, and anyone with scripts off | None                                              | The rows below hold every file |

Anyone else is a phone, a tablet, an iPad asking for the desktop site, ChromeOS, a console, a television, another Unix, or a browser whose reported platform and user agent disagree. A computer's Linux browser writes X11 or Wayland beside Linux in its user agent, and a television's doesn't.

The script knows the system and not the processor. An Intel Mac gets the Mac block, so the line under each heading names the hardware its file needs. It asks the browser for no detailed hints, stores nothing and sends nothing.

### Which release the links point at

`src/download.html` is written with every installer link on the [Releases page](https://github.com/Mr-Streamer-OSS/MrStreamer/releases/latest), a label that says so, and no version. That is what the page shows when nothing is known. Two steps point links at files, both in `src/downloads.ts`:

1. **The build** reads the complete published stable release history from GitHub and uses the update feed's selection rule for the highest version with all three update manifests. A withdrawn release remains in the history with its sources but is not offered for download. If the history is unavailable, the validated [update feed](../../docs/maintainers/releasing.md#update-feed) is the fallback. A query string does not reliably bypass GitHub Pages' cache. It then asks GitHub for each of the four installers by its address, one HEAD request each. It writes the ones GitHub answers for into the download page, with the version in the page's title and release line. The same verified version reaches the about page and the homepage's structured data. With no verified installer, all general version claims are omitted and the download title is versionless. The built pages link files without scripts.
2. **The open page** requests the feed once, with no retry and no polling. The feed lists the installers its stable release carries. A feed generated before the build verified release eligibility is ignored when it names a different release, so a cached old feed cannot undo a publication or withdrawal. This also applies when no eligible stable release remains. A feed naming the selected release can fill installer links that failed their build-time check. Download and about show a current feed's release, including the download title, release notes, checksums and source links. The homepage holds no installer link or release line, so it never asks for the feed, and its structured data names the version the build verified. A stable release reaches visitors this way without a new build of the site, once the release workflow has published the feed and GitHub's ten-minute cache of it has passed.

A stable release rebuilds the site in its own run: once **Record the stable version on main** has succeeded, `publish.yml`'s website jobs build current `main` and publish it. Nightlies and dry runs never get there, and a later Store upload failure does not undo publication or prevent the rebuild. Deployment still requires `MARKETING_DEPLOY_ENABLED`, the protected `marketing-production` environment and the main/revision checks. A manual **Publish** run from `main` with target **website** also rebuilds the site.

| When                                                    | The page links                                                                                     |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| The build and the feed name the same release            | That release's files                                                                               |
| A stable release came out after the build               | With scripts, the new release. Without, the one the build found, whose files stay on GitHub        |
| The build couldn't read history or the feed             | The Releases page, until the open page reads the feed. The build prints a warning and still passes |
| The release lacks an installer, or GitHub didn't answer | The Releases page for that installer, files for the others                                         |
| The visitor's browser can't reach the feed              | What the build wrote                                                                               |
| The feed was written before feeds listed installers     | What the build wrote                                                                               |
| The feed names a nightly, or files outside this project | The open page keeps what the build wrote. A build links the Releases page                          |
| A stable release was withdrawn and the feed moved back  | A fresh build excludes it; scripts accept a newer feed that names its replacement                  |

A link is never guessed and never taken from the feed. Its address is this repository's release folder, a version shaped like a stable one, and a file name from `INSTALLERS` in `downloads.ts`, which follow `artifactName` in `apps/desktop/electron-builder.yml`. Rename an installer there and the page links the Releases page for it until `INSTALLERS` follows. The version shows only beside a button whose file is linked.

The download and about pages request the feed once to keep their displayed release consistent. The request goes to GitHub Pages. The [privacy policy](../../docs/privacy.md#the-website) says what GitHub receives.

### Release history

`/releases` requests the public GitHub Releases API at build time, 100 releases per page until it reaches the end. It excludes drafts, prereleases and non-stable tags, and sorts by the actual publication dates. Notes come directly from GitHub and render openly as Markdown, with HTML and unsafe URLs escaped or removed. Remote images become links so notes do not silently load third-party images.

The entire history request has a 20-second deadline and a 100-page limit. An HTTP error, malformed response, timeout or failure of a later page discards the partial history. The page then says history is unavailable here and links to GitHub Releases. It never claims a partial list is complete and never copies mock notes or dates. A later publish reads the complete history again without hand edits.

### The badge and the marks

`public/icons/` holds three files, served from the site so the page asks no one else for them. Each loads lazily, so only the visitor whose block shows it fetches it. With scripts off a browser fetches all three.

| File                  | From                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `microsoft-store.svg` | Microsoft's light Store badge, `https://get.microsoft.com/images/en-us%20light.svg`, byte for byte, 161 by 44  |
| `apple.svg`           | The Apple logo as [Simple Icons](https://simpleicons.org) 15.22.0 draws it, CC0 1.0. A trademark of Apple Inc. |
| `linux.svg`           | Tux as Simple Icons 15.22.0 draws it, CC0 1.0. Larry Ewing drew Tux. Linux is a trademark of Linus Torvalds    |

Keep the badge as Microsoft publishes it: no new colour, crop or redrawing, and its own proportions. There is no Mac App Store listing, so the Mac and Linux buttons are plain buttons with the system's mark and never a store badge. The rows' file drawings are plain lines in `src/download.html`, not system marks.

## Website analytics

`src/analytics.ts` sends a few fixed events per page to PostHog's EU Cloud, in the same project as the app's statistics, without an SDK, in PostHog's cookieless mode, so PostHog's built-in Web analytics reads them. Pages send to the site's own route, `https://mrstreamer.app/ingest/i/v0/e/`, below. They are on by default. Global Privacy Control, Do Not Track, an explicit off and failing local storage keep them off, and GPC or DNT can't be overridden. The footer of every page and the policy's Website analytics section hold the switch. [The privacy policy](../../docs/privacy.md#website-analytics) is the promise the code keeps; change both together.

| Event                    | Properties                                                                                                                                                                                                                                                                                                                    | When                                                                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$pageview`              | `route`: a `PAGES` address from the page's canonical link, or `/404`. The entry codes, below                                                                                                                                                                                                                                  | The page opens                                                                                                                                                    |
| `$pageleave`             | `route`, `visible`: `under_10s`, `10_30s`, `30s_2m`, `2_10m` or `over_10m` of time in view. Scroll depth, below                                                                                                                                                                                                               | First `pagehide` or hidden `visibilitychange`                                                                                                                     |
| `$web_vitals`            | One of `$web_vitals_LCP_value`, `$web_vitals_INP_value` or `$web_vitals_CLS_value`, below                                                                                                                                                                                                                                     | As web-vitals reports the vital                                                                                                                                   |
| `download_clicked`       | `download_type`: `stable`. `os_hint`: `mac`, `windows`, `linux`, the system the link installs on. `kind`: `dmg`, `exe`, `appimage`, `deb`, `store`. `route`: `/download`, where every installer link and the Store sit. `location`: `page`; `hero` is kept for events from before the homepage's links moved. The entry codes | A click on an installer link or the Store: a download intent, not an installed copy. The homepage's Download links lead to `/download` and count as its page view |
| `docs_link_clicked`      | `doc_section`: `index` for `/docs` or a guide's slug. `route`. `location`: `header`, `footer` or `page`                                                                                                                                                                                                                       | A click on a link to `/docs` or a guide. Its fragment is never read                                                                                               |
| `github_link_clicked`    | `route`, `link_location`: `footer_source`, `footer_bug`, `footer_license` or `page`                                                                                                                                                                                                                                           | A click on another link to this repository                                                                                                                        |
| `guide_section_viewed`   | `guide`: the guide's slug. `section`: a heading id the build wrote                                                                                                                                                                                                                                                            | The heading enters view, once per page                                                                                                                            |
| `feature_section_viewed` | `feature_name`: `movies-and-series`, `sound-and-subtitles`, `what-you-need` or `downloads`. `live-tv`, `tv-guide` and `questions` remain historical reporting values; new page views no longer emit them                                                                                                                      | A home section enters view, once per page                                                                                                                         |
| `faq_question_viewed`    | `faq_question`: a row id in `src/faq.html`. `via`: `anchor` when the page opened on that id, else `scroll`                                                                                                                                                                                                                    | The row enters view, once per page. FAQ rows are plain, so nothing is expanded                                                                                    |
| `changelog_viewed`       | `version`: a stable version on `/releases`                                                                                                                                                                                                                                                                                    | The release enters view, once per page                                                                                                                            |

Scroll depth uses posthog-js's names: `$prev_pageview_pathname` is the `route`, `$prev_pageview_max_scroll_percentage` the deepest scroll over the scrollable height and `$prev_pageview_max_content_percentage` the deepest bottom edge of the view over the page's height. Each is 0 to 1 in hundredths, and 1 on a page that can't scroll. The page measures after a scroll or resize, at most once a frame, and once more as it is left. The vitals come from the standard build of [web-vitals](https://github.com/GoogleChrome/web-vitals) 6.2.3, one per event: LCP and INP in whole milliseconds, CLS as a score in thousandths. LCP is sent once final, CLS and INP as the page is hidden, and again at a later hide if they grew. A page without an interaction has no INP, a browser that can't measure a vital sends none, and a value that isn't finite, is negative or is 15 minutes or more is dropped. Neither measurement starts on a page that opened with analytics off. These are the properties PostHog's Web analytics and its scroll-depth and web vitals health checks read.

Every event also has:

- `$current_url`, `$pathname` and `$host`: `https://mrstreamer.app` and `route`, never `location`, so no query, fragment or other host. An unknown address is `/404`.
- `distinct_id` `$posthog_cookieless` and `$cookieless_mode: true`, posthog-js's cookieless placeholder and flag. With cookieless tracking on in the project, ingestion replaces the placeholder with a hash of the team, a daily salt, the IP address, user agent and host, and sets its own `$session_id` (a UUIDv7, 30 minutes of inactivity). Without that setting PostHog drops the events.
- `$raw_user_agent`: `navigator.userAgent`, the same string the browser sends as its `User-Agent` header. Ingestion drops a cookieless event without it, and deletes it and `$ip` after hashing, before transformations or storage.
- `source: "website"`, `$process_person_profile: false` and `$geoip_disable: true`.
- `$lib_custom_api_host: "https://mrstreamer.app/ingest"` in a production build, as posthog-js sends behind a proxy. PostHog's Web analytics reverse proxy check looks for it. A loopback verification build sends to its own endpoint and omits it.

Nothing else is sent: no referrer, query or fragment beyond the entry codes, no typed text, screen, language, pixel position, element, resource address, web-vitals rating, id or attribution, `$session_id`, `$window_id` or device or browser property, and the page keeps no identifier. PostHog's Web analytics therefore shows every visit as direct, with no country, device or browser breakdown; break down by the entry codes in Product analytics instead. A page makes at most 64 requests, each aborted after 10 seconds, with no retry or queue. Requests use `fetch` with `credentials: "omit"` and `referrerPolicy: "no-referrer"`, and a text body that needs no preflight. Leave, link-click and guide-link events, and anything sent while the page is hidden, add `keepalive` so they arrive as the page closes. Turning off sends nothing more, aborts open requests and stops measuring scroll depth. web-vitals can't be stopped, so its later reports go unsent, and a page restored from the back-forward cache reads the stored choice again. Chromium still completes a keepalive request already sent, whether turned off or past its deadline. Local storage holds only `mrstreamer.site-analytics`, set to `on` or `off` when the visitor chooses, and session storage only the entry codes. The site links stable installers only, so nightly downloads show as GitHub clicks from `/download` or `/releases`, and there is no separate installation guide to count. Earlier events used `site_` names and a random per-page `site_` id. They stay as they were, with nothing renamed or backfilled.

### Where a visit entered

`src/referrals.ts` gives `$pageview` and `download_clicked` three codes from fixed lists, `entry_source`, `entry_medium` and `entry_campaign`. The page reads its own query and `document.referrer` only to pick them; a referrer is reduced to its host and matched whole. No address, host, tag value or click id is sent, stored or logged, and `$current_url`, `$referrer` and PostHog's `utm_*` properties are not set from them.

| `entry_source`                                                                                              | Default `entry_medium` | From                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `google`, `bing`, `duckduckgo`, `yahoo`, `yandex`, `ecosia`, `brave`, `startpage`, `qwant`, `kagi`, `baidu` | `search`               | The engine's search host, such as `www.google.de`, `search.brave.com`. Not its mail, maps or other hosts                                                                  |
| `github`                                                                                                    | `referral`             | `github.com`, `gist.github.com`, or `utm_source=github`                                                                                                                   |
| `microsoft_store`                                                                                           | `referral`             | `apps.microsoft.com`, or `utm_source=microsoft_store`                                                                                                                     |
| `ai_assistant`                                                                                              | `referral`             | `chatgpt.com`, `chat.openai.com`, `perplexity.ai`, `claude.ai`, `gemini.google.com`, `copilot.microsoft.com`                                                              |
| `reddit`, `hacker_news`, `x`, `bluesky`, `youtube`                                                          | `social`               | `reddit.com` and its subdomains, `news.ycombinator.com`, `t.co`/`x.com`/`twitter.com`, `bsky.app`, `youtube.com`/`youtu.be`, or the same `utm_source`                     |
| `mastodon`                                                                                                  | `social`               | `utm_source=mastodon` only: its servers have no common host                                                                                                               |
| `app`                                                                                                       | `app`                  | `utm_source=app` only: the app's links open the browser with no referrer                                                                                                  |
| `other`                                                                                                     | `referral`             | Any other referrer, including a non-web or unreadable one                                                                                                                 |
| `unknown`                                                                                                   | `unknown`              | No referrer and nothing kept: a typed address, a bookmark, an untagged app link, a site that hides its address, or a tab whose entry was removed while analytics were off |

UTM tags count only when `utm_source` has exactly one value, compared lowercase, from `github`, `microsoft_store`, `app`, `reddit`, `hacker_news`, `x`, `bluesky`, `mastodon` or `youtube`. Then `utm_medium` may be `readme`, `release_notes`, `docs`, `store_listing`, `app`, `social` or `referral`, else the source's default, and `utm_campaign` may be `release` or `launch`, else `none`. Any other `utm_source` drops every tag and the referrer decides. `utm_content`, `utm_term`, click ids and other parameters are never read. A referrer-only entry has `entry_campaign: "none"`. To add a code, add it to `src/referrals.ts`, this table and its test, then tag the link, for example `https://mrstreamer.app/?utm_source=github&utm_medium=readme`.

The first counted page of a tab picks the entry and keeps it in session storage under `mrstreamer.site-entry` as those three codes, for the tab's life. A later page opened from a tagged link or another site replaces it; a page opened from this site or without a referrer keeps it, so typed addresses mid-visit don't reset the entry. A stored value that isn't three listed codes is ignored. A page that opens off, refused or without local storage, and turning off here or in another tab, removes it, so a page counted after turning on again starts from `unknown` rather than the earlier entry. An off from another tab stops the page even when it arrives after that tab turned on again, as a frozen tab hears it; the on doesn't restart the page. A page restored from the back-forward cache takes the tab's entry as stored then. If session storage can't take a new entry, the old one is removed: the page still sends its own entry and later pages say `unknown`. Download conversion compares `download_clicked` with visits, both broken down by `entry_source`. It counts clicks on a download link, never finished downloads or installations.

### The ingest route

`scripts/site-analytics.ts` names `INGEST_ROUTE` and `scripts/package-vercel.ts` packs it first in `config.json`: a `POST` to exactly `/ingest/i/v0/e/` on the site goes on to `https://eu.i.posthog.com/i/v0/e/`. Any other method, including `OPTIONS`, or any other path under `/ingest` answers the site's 404, so the route carries capture alone: no SDK, flags, config, recordings or other PostHog paths. Pages send a text body with `credentials: "omit"` and `referrerPolicy: "no-referrer"`, so there is no preflight, cookie or Referer for the route to pass on, and the body is the allowlisted event above. For external rewrites Vercel sends the visitor's IP address to the destination as `x-forwarded-for` and `x-real-ip` ([Vercel rewrites](https://vercel.com/docs/rewrites#identifying-the-visitor-at-your-origin)), which PostHog's [proxy reference](https://posthog.com/docs/advanced/proxy/proxy-reference) asks a proxy to forward, so ingestion's cookieless hash and its IP setting see the visitor rather than Vercel. The package check fails if a script names an `i.posthog.com` host, so pages can't bypass the route. The website analytics scenario resolves every capture through the packaged routes. Vercel's own forwarding, the hash over it and PostHog's reverse proxy check are only observable on the published site.

A build compiles analytics in from these variables only (`scripts/site-analytics.ts`):

| Variable                                    | Value                                                                                                                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MR_STREAMER_SITE_ANALYTICS_RELEASE_BUILD`  | `1`, set only by the publishing build in `publish.yml`                                                                                                                       |
| `MR_STREAMER_SITE_ANALYTICS_HOST`           | `https://eu.i.posthog.com`, from the repository variable `POSTHOG_HOST`, which the app also uses. It selects EU; pages still send to `/ingest`. Any other host sends nothing |
| `MR_STREAMER_SITE_ANALYTICS_PROJECT_TOKEN`  | The project's public `phc_` key, from the repository variable `POSTHOG_PROJECT_TOKEN`                                                                                        |
| `MR_STREAMER_SITE_ANALYTICS_LOCAL_ENDPOINT` | A literal `http://127.0.0.1:<port>/i/v0/e/` for verification. It replaces production                                                                                         |

The key is public: every page carries it, as the app does. It is the value of the release workflow's `POSTHOG_PROJECT_TOKEN` secret, kept as a variable so the build job holds no secrets. Never use a personal API key. Without the variables the publishing build warns and the site sends nothing. Development, previews and pull request builds send nothing, and their footer reads "Site analytics: off."

The Vercel project's Web Analytics is no longer used and can be turned off in its Analytics tab.

## How it gets published

The website jobs of `.github/workflows/publish.yml` publish the page from GitHub Actions. Vercel only serves it.

1. A push to `main` changing site inputs, a recorded stable release, or a manual run from `main` with target **website** starts a build. Nightlies and dry runs never do.
2. The build job has no owner secrets. It uses the workflow's read-only GitHub token for release history, builds `main`, checks the package and hands over `.vercel/output` alone.
3. The publish job holds the Vercel token. It checks out nothing and runs the pinned Vercel CLI on that package: `vercel deploy --prebuilt --archive=tgz --prod`.

4. After the Publish step succeeds, IndexNow verifies the matching build on the public domain and notifies canonical pages in a separate job without owner secrets.

Publications queue without replacing pending ones and none is cancelled halfway, using the same `queue: max` policy as the release workflow. Builds don't wait for each other: each builds `main` as it is when it starts. Before it publishes, a run asks git whether `main` has changed the website since its build, over the push trigger's paths. If it has, the run leaves publishing to the run that change started. If git can't tell, the run fails and publishes nothing.

Publishing is off until you turn it on. Until then a run builds, says publishing is off, and stops. Every pull request also builds the page in the **Website** job of `.github/workflows/checks.yml`, without secrets.

## IndexNow notifications

After an actual successful, non-superseded production publication, a separate job consumes that run's checked static package and dependency-free notification CLI. It has no Vercel token, owner secrets, environment or checkout. Disabled publishing, previews, failed publications and superseded builds send nothing. Ordinary PR CI only builds and tests.

Vite generates `sitemap.xml`, the root ownership file and `indexnow-build.json` from the canonical `PAGES` registry. The marker names the source commit and a unique build ID. Packaging checks the exact registry/sitemap set and ownership contents before uploading artifacts. The notifier checks both the literal `https://mrstreamer.app` ownership file and the complete matching public build marker before sending one POST to `https://api.indexnow.org/indexnow`. Redirects fail. A rollback-pinned domain or delayed propagation gets six bounded readiness attempts, five seconds per request and ten seconds between attempts, within a two-minute total deadline. Each attempt makes at most two GETs. The POST is never retried, including on throttling or ambiguous network failure; `Retry-After` cannot extend the bounds. The job has a three-minute runner limit.

HTTP 200 records receipt. HTTP 202 records receipt with ownership validation pending. Neither guarantees crawling or indexing. API rejection, timeout, cancellation or an unmatched public build fails the notification job and tells the maintainer the website is already deployed. It never undoes publication. Check the Publish summary separately, especially while Instant Rollback pins the domain. A manual local publication does not run this Actions notification job.

The IndexNow value in `scripts/indexnow.ts` is intentionally public proof of domain ownership, hosted verbatim in UTF-8 at `/{key}.txt`. It is not a private account token and needs no repository secret or new account setup. Never substitute GitHub, Vercel or analytics credentials. The value stays stable across builds. To rotate it, generate a new 8-128-character value using only letters, digits or hyphens, replace `INDEXNOW_KEY`, and review/build/deploy normally. The generated filename, contents and `keyLocation` follow the new value together; the next notification waits for that new file and marker on the domain. The new deployment removes the old file, so do not delete an ownership file separately before the replacement deploy. A rollback to an old build keeps its old ownership value and prevents notification of the new candidate.

Protocol reference: [IndexNow documentation](https://www.indexnow.org/documentation) and [FAQ](https://www.indexnow.org/faq). `apps/marketing/test/indexnow.test.ts` exercises public HTTP behavior only against loopback fixtures, including non-acceptance and time bounds. No real API submission is part of verification. A passing local build does not establish production propagation or indexing.

## Set it up, once

These steps need the owner's accounts. Nothing here costs money. Stop if a step asks for a paid plan.

### 1. Check that the free plan fits

Vercel's Hobby plan is for personal, non-commercial use. Its [fair use guidelines](https://vercel.com/docs/limits/fair-use-guidelines#commercial-usage) count a site as commercial when it takes payment, sells something or shows ads, and say that asking for donations doesn't count. The page does none of those. If that changes, or you are unsure, ask Vercel before you rely on Hobby.

### 2. Create the Vercel project

Use the CLI. The dashboard's New Project flow starts from a Git repository, which this project must not have.

```sh
npx --yes vercel@62.2.0 login
npx --yes vercel@62.2.0 project add mrstreamer-marketing
npx --yes vercel@62.2.0 link --yes --project mrstreamer-marketing --cwd apps/marketing
```

Then open the project's Settings and confirm all three:

| Setting                                 | Must be |
| --------------------------------------- | ------- |
| Build and Deployment > Root Directory   | Empty   |
| Build and Deployment > Framework Preset | Other   |
| Git > Connected Git Repository          | None    |

The workflow runs the CLI with `--cwd apps/marketing`, and the CLI adds the project's Root Directory to that. A Root Directory of `apps/marketing` would send it looking for `apps/marketing/apps/marketing`. A Git connection would make Vercel build and publish on its own, beside the workflow.

`link` writes `apps/marketing/.vercel/project.json`, which is not committed. It holds the two ids the next step needs: `projectId` and `orgId`.

### 3. Make a token

On [vercel.com/account/tokens](https://vercel.com/account/tokens), create a token named for its use, such as `mrstreamer-marketing-github`. Scope it to the `mrstreamer-marketing` project alone and give it an expiry you will keep. Vercel shows the token once.

### 4. Give GitHub the token and the ids

In the repository's Settings > Environments, create `marketing-production`. Under Deployment branches and tags choose Selected branches and tags, and add `main`. Then add:

| Kind                 | Name                | Value                                   |
| -------------------- | ------------------- | --------------------------------------- |
| Environment secret   | `VERCEL_TOKEN`      | The token                               |
| Environment variable | `VERCEL_ORG_ID`     | `orgId` from `.vercel/project.json`     |
| Environment variable | `VERCEL_PROJECT_ID` | `projectId` from `.vercel/project.json` |

Or from a terminal, where `gh` asks for the token without showing it:

```sh
gh secret set VERCEL_TOKEN --env marketing-production --repo Mr-Streamer-OSS/MrStreamer
gh variable set VERCEL_ORG_ID --env marketing-production --repo Mr-Streamer-OSS/MrStreamer --body "<orgId>"
gh variable set VERCEL_PROJECT_ID --env marketing-production --repo Mr-Streamer-OSS/MrStreamer --body "<projectId>"
```

The token goes nowhere else: not in a file, a commit, an issue or a log. Leave required reviewers off this environment, or every publication waits for a click.

### 5. Publish the first time by hand

From an up-to-date `main`, build the same package the workflow builds and publish it with your own login:

```sh
pnpm install
pnpm build:marketing
npx --yes vercel@62.2.0 deploy --prebuilt --archive=tgz --prod --cwd apps/marketing
```

A project's first deployment is its production deployment. No domain is attached yet, so it is live only at the project's `vercel.app` address. Check there:

- The homepage, `/download`, `/releases`, `/about`, `/security`, `/faq`, `/docs` and a guide on a wide screen and a phone, also without JavaScript.
- `/privacy` and `/privacy/` both show the whole policy.
- An address with no page, such as `/nothing/here`, shows Page not found.
- `/robots.txt`, `/sitemap.xml` and `/generated/social.png` answer.

### 6. Move the domain

If moving a domain that still redirects to GitHub, remove those redirects when it points to Vercel. The steps below preserve Cloudflare's email routing.

1. In Cloudflare, export the DNS records so you can put them back.
2. In Vercel, open the project's Settings > Domains and add `mrstreamer.app`. Accept the offer to add `www.mrstreamer.app` too.
3. Select Edit on `www.mrstreamer.app` and set Redirect to `mrstreamer.app`. The redirect keeps the path.
4. In Cloudflare DNS, replace the records for `mrstreamer.app` and `www` with the A and CNAME records Vercel shows for this project. Set both to DNS only, the grey cloud, so Vercel can issue the certificates.
5. Leave the MX records and the TXT records for mail as they are. `hello@`, `privacy@` and `security@` keep arriving through Cloudflare.
6. Turn off Cloudflare's rules that redirect `mrstreamer.app` and `mrstreamer.app/privacy`. They sit under Rules, as a redirect rule, a page rule or a bulk redirect.

Then check:

```sh
curl -sI https://mrstreamer.app/ | head -1                             # 200
curl -sI "https://www.mrstreamer.app/x?y=1" | grep -i location         # https://mrstreamer.app/x?y=1
curl -sI https://mrstreamer.app/privacy | head -1                      # 200
curl -sI https://mrstreamer.app/privacy/ | head -1                     # 200
curl -sI "https://mrstreamer.app/nothing/here?y=1" | head -1           # 404
```

Send a message to `hello@mrstreamer.app` and see it arrive. Open Settings > About in the app and follow its Website and Privacy links.

### 7. Turn on automatic publishing

```sh
gh variable set MARKETING_DEPLOY_ENABLED --repo Mr-Streamer-OSS/MrStreamer --body true
gh workflow run publish.yml --repo Mr-Streamer-OSS/MrStreamer --ref main -f target=website
```

Watch that run publish. From then on, a merge to `main` that changes any of the paths under `on.push.paths` in `.github/workflows/publish.yml`, what the page is built from, publishes the page.

Recorded stable releases also publish it, from their own run. The build always reads current `main` and never writes source files back to the repository.

## Turn it off, or go back

To stop publishing, set the variable to anything but `true`. The page stays as it is.

```sh
gh variable set MARKETING_DEPLOY_ENABLED --repo Mr-Streamer-OSS/MrStreamer --body false
```

To go back one publication, open the project in Vercel and choose Instant Rollback on the production deployment. The Hobby plan goes back to the deployment before the current one. After a rollback Vercel holds the domain on that deployment. The workflow still runs and its summary names each new deployment, but none of them goes live until you choose Undo Rollback.

To go back further, revert the commit on `main`. The workflow publishes the reverted page.

To take the site away, remove the two domains from the Vercel project and restore the DNS records you exported.

When the token expires, make a new one and set `VERCEL_TOKEN` again. A run without a token, or without either id, fails and names what is missing.

## Later, if you want Vercel to build from Git

Not set up, and not tried. It replaces the workflow, so do both of these first:

1. Set `MARKETING_DEPLOY_ENABLED` to `false`.
2. Confirm on a preview deployment that `/privacy` shows the policy and an address with no page answers 404.

Only then connect the repository in the project's Settings > Git, and give the project these settings:

| Setting                                  | Value                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| Root Directory                           | `apps/marketing`                                                                    |
| Include files outside the Root Directory | On, for the captures in `docs/assets`                                               |
| Framework Preset                         | Other                                                                               |
| Node.js Version                          | 24.x                                                                                |
| Install Command                          | `npx --yes pnpm@11.24.0 install --filter mrstreamer-marketing... --frozen-lockfile` |
| Build Command                            | `npx --yes pnpm@11.24.0 --filter mrstreamer-marketing build`                        |
| Output Directory                         | `dist`                                                                              |

Never run both. Two publishers on one project overwrite each other.

## Package availability

`src/packages.ts` owns approved package destinations, exact commands, supported systems/architectures and independent publication receipts. Homebrew and AUR are published, last verified at 0.0.19. AUR's `mrstreamer-bin` package revision is 0.0.19-1, maintained by 4bs3nt; its registry receipt points to the planning card's separate native-package and user-reported public-install evidence. `scripts/pages.ts` omits unpublished or withdrawn package links and commands from built HTML. Withdrawal keeps the last verified version. The direct release feed never activates or changes package metadata.

The selected download A layout keeps the visitor's direct installer first and adds checked package alternatives to the matching system rows. OS detection selects neither an architecture nor an Arch distribution. Package links name their actual platform and architecture. Package links add no analytics collection; existing installer and Store events retain their vocabulary. The FAQ names the published route, and the public update guide explains quitting before replacement, version comparisons and reinstall limits. Never activate a route from a candidate recipe or an unpublished tap/AUR entry.

Home B's small availability line beside Download and the FAQ use the same registry and omit withdrawn routes. Homebrew uses the original signed stable Apple silicon DMG, with macOS 13 or later required. This is a maintained tap, with no claim of inclusion in Homebrew's main catalogue.

Change a route's version and receipt only after its public install is verified on the matching project card. The [0.0.19 verification receipt](https://github.com/Mr-Streamer-OSS/homebrew-tap/blob/main/docs/verification/0.0.19.md) records Homebrew's stable artifact checks and accepted native limits.
