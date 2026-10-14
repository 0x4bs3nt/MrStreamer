# The website

Static pages for `https://mrstreamer.app`, built with Vite from HTML, CSS, TypeScript and the repository's Markdown. The homepage's pictures are captures of the real app, kept in `docs/assets` and described in [marketing artwork](../../docs/contributing/marketing-artwork.md).

| File                                                                         | Holds                                                                          |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `index.html`                                                                 | The homepage and its shortened Downloads section                               |
| `src/page.html`                                                              | The shared FAQ, privacy, guides, about, security, download and releases layout |
| `src/faq.html`                                                               | Grouped questions and answers, readable without scripts                        |
| `src/download.html`                                                          | Installer rows, requirements, checksum and source links                        |
| `faq/`, `privacy/`, `docs/`, `about/`, `security/`, `download/`, `releases/` | HTML entry points, expanded by the build                                       |
| `404.html`                                                                   | The page for a missing address                                                 |
| `src/styles.css`                                                             | Layout, download button visibility and finite homepage motion                  |
| `src/main.ts`                                                                | Starts website analytics, homepage motion and one download-feed refresh        |
| `src/analytics.ts`                                                           | Website analytics: the footer and policy switch and the fixed events           |
| `scripts/site-analytics.ts`                                                  | Which PostHog endpoint, if any, a build compiles in                            |
| `src/system.ts`                                                              | Which system a visitor is on, for the hero's one download button               |
| `src/downloads.ts`                                                           | Verified installer links, version metadata and the release's auxiliary links   |
| `scripts/pages.ts`                                                           | Page registry, metadata and Markdown rendering with public documentation links |
| `scripts/releases.ts`                                                        | Paginated stable release history from GitHub, with a bounded fallback          |
| `vite.config.ts`                                                             | Build inputs, HTML expansion and local routing                                 |
| `scripts/prepare-assets.ts`                                                  | Pictures, icons and the social picture in `public/generated/`                  |
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

`pnpm build:marketing` checks every listed page's metadata, sitemap entry, scripts, styles and referenced assets. It checks that every Markdown source's headings reached its page and that internal links and fragments exist. It also checks installer URLs and the homepage's system-selection script and structured data. `scripts/package-vercel.ts` lists the checks. The build reads paginated GitHub releases, selects the highest complete stable release and verifies four installers. The update feed is a fallback when history is unavailable. Network failure leaves truthful GitHub links and does not fail the build. The existing workflow token authenticates the release-history request in CI; a local build works anonymously when neither `GH_TOKEN` nor `GITHUB_TOKEN` is available. Tokens are never written to HTML or logged.

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

## Change it

- Keep the words true and few. Every claim on the page comes from the README or the docs. The app's limits are in [what plays](../../docs/user/playback.md).
- True black, white text, minimal copy. Screenshots describe the app, so a feature is its name and one sentence beside its window.
- The page order is the bar, the hero, the Home window, the four features, What you need, the FAQ link, Downloads, the footer. The hero has the page's one button. The bar links Downloads as text.
- The homepage title and description name the product and systems. Its single h1 names Mr. Streamer above the existing slogan. Structured data describes `SoftwareApplication` and `SoftwareSourceCode`, with the alternate product name, publisher, repository and five screenshots. `softwareVersion` comes only from a stable release with a verified installer. There are no invented ratings or reviews. Every document has its own metadata, canonical address and sitemap entry. Add no page for a single system or search phrase.
- Nothing moves by itself, and every animation runs once and ends:
  - As the page opens, the bar drops in, the headline and lead rise, the one button pops, its line rises and the Home window stands up, or only rises while the layout is stacked. This is CSS alone, so it runs without JavaScript.
  - As a part scrolls into view, a feature's text slides in from the page's edge while a black panel wipes off its window. What you need and each question rise in, and each download row slides in from the left, questions and rows one after another. What is on screen when the page opens stays as it is.
  - As the page scrolls, the Home window tips upright. Upright, it has no transform left.
  - The button lifts 2 px under the pointer or the keyboard's focus.

  Only `transform` and `opacity` change. `main.ts` adds `revealed` to a part once and takes it off when its animation ends or is dropped, so no class, panel or layer stays behind. Once the page is open, the script works only after a scroll, a resize or a changed preference. With reduced motion nothing moves, also when the preference changes while the page is open. Nothing waits hidden for the script. An animation only starts from hidden, and a part that never animates is in place.

- New pictures come from new captures. Follow the [artwork recipe](../../docs/contributing/marketing-artwork.md). A phone shows a part of each window, set in `prepare-assets.ts`, with its size repeated in `index.html`.
- Markdown remains the source for privacy, the seven guides, about and security. The site builds the checked-out `main`, rather than copying guides from a stable tag. Coordinate new feature documentation with its release. Relative guide links become public page links, retaining fragments. Documents that are not public pages link to GitHub, never to a nonexistent site route. Scripts are not needed to read any document. Merging a change to any rendered Markdown source starts the marketing publication workflow.

## Downloads

The hero offers one download for the visitor's system and keeps its existing button and per-system notes. The homepage Downloads section has a short line of installer links and points to `/download`, which holds the full rows and requirements.

### One button

`src/system.ts` names the visitor's system from the browser's user agent, its touch points and, in Chromium, the platform it reports. The build writes that function's own text into the head of `index.html`, where it runs before the page paints and sets `data-os` on `<html>`. `styles.css` shows the button and line that match, so the button never swaps after it shows.

| Visitor                                  | Button                  | Goes to                |
| ---------------------------------------- | ----------------------- | ---------------------- |
| Windows                                  | Microsoft's Store badge | The Store listing      |
| Mac                                      | Download for Mac        | The DMG                |
| Linux on a computer                      | Download for Linux      | The AppImage           |
| Anyone else, and anyone with scripts off | Downloads               | The list at the bottom |

Anyone else is a phone, a tablet, an iPad asking for the desktop site, ChromeOS, a console, a television, another Unix, or a browser whose reported platform and user agent disagree. A computer's Linux browser writes X11 or Wayland beside Linux in its user agent, and a television's doesn't. The setup .exe and the .deb are never in the hero.

The script knows the system and not the processor. An Intel Mac gets the Mac button, so the line under each button names the hardware its file needs and links the list. It asks the browser for no detailed hints, stores nothing and sends nothing.

### Which release the links point at

`index.html` is written with every installer link on the [Releases page](https://github.com/Mr-Streamer-OSS/MrStreamer/releases/latest), a label that says so, and no version. That is what the page shows when nothing is known. The homepage and `/download` share two steps that point links at files, both in `src/downloads.ts`:

1. **The build** reads the complete published stable release history from GitHub and uses the update feed's selection rule for the highest version with all three update manifests. A withdrawn release remains in the history with its sources but is not offered for download. If the history is unavailable, the validated [update feed](../../docs/maintainers/releasing.md#update-feed) is the fallback. A query string does not reliably bypass GitHub Pages' cache. It then asks GitHub for each of the four installers by its address, one HEAD request each. It writes the ones GitHub answers for into both pages, with a version beside known hero installers and in the download page's title and release line. The same verified version reaches the about page and homepage structured data. With no verified installer, all general version claims are omitted and the download title is versionless. The built pages link files without scripts.
2. **The open page** requests the feed once, with no retry and no polling. The feed lists the installers its stable release carries. A feed generated before the build verified release eligibility is ignored when it names a different release, so a cached old feed cannot undo a publication or withdrawal. This also applies when no eligible stable release remains. A feed naming the selected release can fill installer links that failed their build-time check. Home, download and about show a current feed's release, including the download title, release notes, checksums and source links and homepage structured data. A stable release reaches visitors this way without a new build of the site, once the release workflow has published the feed and GitHub's ten-minute cache of it has passed.

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

The homepage, download and about pages request the feed once to keep their displayed release consistent. The request goes to GitHub Pages. The [privacy policy](../../docs/privacy.md#the-website) says what GitHub receives.

### Release history

`/releases` requests the public GitHub Releases API at build time, 100 releases per page until it reaches the end. It excludes drafts, prereleases and non-stable tags, and sorts by the actual publication dates. Notes come directly from GitHub and render openly as Markdown, with HTML and unsafe URLs escaped or removed. Remote images become links so notes do not silently load third-party images.

The entire history request has a 20-second deadline and a 100-page limit. An HTTP error, malformed response, timeout or failure of a later page discards the partial history. The page then says history is unavailable here and links to GitHub Releases. It never claims a partial list is complete and never copies mock notes or dates. A later publish reads the complete history again without hand edits.

### The badge and the marks

`public/icons/` holds three files, served from the site so the page asks no one else for them. Each loads lazily, so only the visitor whose button shows it fetches it. With scripts off a browser fetches all three.

| File                  | From                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `microsoft-store.svg` | Microsoft's light Store badge, `https://get.microsoft.com/images/en-us%20light.svg`, byte for byte, 161 by 44  |
| `apple.svg`           | The Apple logo as [Simple Icons](https://simpleicons.org) 15.22.0 draws it, CC0 1.0. A trademark of Apple Inc. |
| `linux.svg`           | Tux as Simple Icons 15.22.0 draws it, CC0 1.0. Larry Ewing drew Tux. Linux is a trademark of Linus Torvalds    |

Keep the badge as Microsoft publishes it: no new colour, crop or redrawing, and its own proportions. There is no Mac App Store listing, so the Mac and Linux buttons are plain buttons with the system's mark and never a store badge.

## Website analytics

`src/analytics.ts` sends a few fixed events per page to PostHog's EU Cloud, in the same project as the app's statistics, without an SDK, in PostHog's cookieless mode, so PostHog's built-in Web analytics reads them. They are on by default. Global Privacy Control, Do Not Track, an explicit off and failing local storage keep them off, and GPC or DNT can't be overridden. The footer of every page and the policy's Website analytics section hold the switch. [The privacy policy](../../docs/privacy.md#website-analytics) is the promise the code keeps; change both together.

| Event                    | Properties                                                                                                                                                                                | When                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `$pageview`              | `route`: a `PAGES` address from the page's canonical link, or `/404`                                                                                                                      | The page opens                                                                      |
| `$pageleave`             | `route`, `visible`: `under_10s`, `10_30s`, `30s_2m`, `2_10m` or `over_10m` of time in view. Scroll depth, below                                                                           | First `pagehide` or hidden `visibilitychange`                                       |
| `$web_vitals`            | One of `$web_vitals_LCP_value`, `$web_vitals_INP_value` or `$web_vitals_CLS_value`, below                                                                                                 | As web-vitals reports the vital                                                     |
| `download_clicked`       | `download_type`: `stable`. `os_hint`: `mac`, `windows`, `linux`, the system the link installs on. `kind`: `dmg`, `exe`, `appimage`, `deb`, `store`. `route`. `location`: `hero` or `page` | A click on an installer link or the Store: a download intent, not an installed copy |
| `docs_link_clicked`      | `doc_section`: `index` for `/docs` or a guide's slug. `route`. `location`: `header`, `footer` or `page`                                                                                   | A click on a link to `/docs` or a guide. Its fragment is never read                 |
| `github_link_clicked`    | `route`, `link_location`: `footer_source`, `footer_bug`, `footer_license` or `page`                                                                                                       | A click on another link to this repository                                          |
| `guide_section_viewed`   | `guide`: the guide's slug. `section`: a heading id the build wrote                                                                                                                        | The heading enters view, once per page                                              |
| `feature_section_viewed` | `feature_name`: `live-tv`, `tv-guide`, `movies-and-series`, `sound-and-subtitles`, `what-you-need`, `questions` or `downloads`                                                            | A home section enters view, once per page                                           |
| `faq_question_viewed`    | `faq_question`: a row id in `src/faq.html`. `via`: `anchor` when the page opened on that id, else `scroll`                                                                                | The row enters view, once per page. FAQ rows are plain, so nothing is expanded      |
| `changelog_viewed`       | `version`: a stable version on `/releases`                                                                                                                                                | The release enters view, once per page                                              |

Scroll depth uses posthog-js's names: `$prev_pageview_pathname` is the `route`, `$prev_pageview_max_scroll_percentage` the deepest scroll over the scrollable height and `$prev_pageview_max_content_percentage` the deepest bottom edge of the view over the page's height. Each is 0 to 1 in hundredths, and 1 on a page that can't scroll. The page measures after a scroll or resize, at most once a frame, and once more as it is left. The vitals come from the standard build of [web-vitals](https://github.com/GoogleChrome/web-vitals) 6.2.3, one per event: LCP and INP in whole milliseconds, CLS as a score in thousandths. LCP is sent once final, CLS and INP as the page is hidden, and again at a later hide if they grew. A page without an interaction has no INP, a browser that can't measure a vital sends none, and a value that isn't finite, is negative or is 15 minutes or more is dropped. Neither measurement starts on a page that opened with analytics off. These are the properties PostHog's Web analytics and its scroll-depth and web vitals health checks read.

Every event also has:

- `$current_url`, `$pathname` and `$host`: `https://mrstreamer.app` and `route`, never `location`, so no query, fragment or other host. An unknown address is `/404`.
- `distinct_id` `$posthog_cookieless` and `$cookieless_mode: true`, posthog-js's cookieless placeholder and flag. With cookieless tracking on in the project, ingestion replaces the placeholder with a hash of the team, a daily salt, the IP address, user agent and host, and sets its own `$session_id` (a UUIDv7, 30 minutes of inactivity). Without that setting PostHog drops the events.
- `$raw_user_agent`: `navigator.userAgent`, the same string the browser sends as its `User-Agent` header. Ingestion drops a cookieless event without it, and deletes it and `$ip` after hashing, before transformations or storage.
- `source: "website"`, `$process_person_profile: false` and `$geoip_disable: true`.

Nothing else is sent: no referrer, query, fragment, typed text, screen, language, pixel position, element, resource address, web-vitals rating, id or attribution, `$session_id`, `$window_id` or device or browser property, and the page keeps no identifier. PostHog's Web analytics therefore shows every visit as direct, with no country, device or browser breakdown. A page makes at most 64 requests, each aborted after 10 seconds, with no retry or queue. Requests use `fetch` with `credentials: "omit"` and `referrerPolicy: "no-referrer"`, and a text body that needs no preflight. Leave, link-click and guide-link events, and anything sent while the page is hidden, add `keepalive` so they arrive as the page closes. Turning off sends nothing more, aborts open requests and stops measuring scroll depth. web-vitals can't be stopped, so its later reports go unsent, and a page restored from the back-forward cache reads the stored choice again. Chromium still completes a keepalive request already sent, whether turned off or past its deadline. Local storage holds only `mrstreamer.site-analytics`, set to `on` or `off` when the visitor chooses. The site links stable installers only, so nightly downloads show as GitHub clicks from `/download` or `/releases`, and there is no separate installation guide to count. Earlier events used `site_` names and a random per-page `site_` id. They stay as they were, with nothing renamed or backfilled.

A build compiles analytics in from these variables only (`scripts/site-analytics.ts`):

| Variable                                    | Value                                                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `MR_STREAMER_SITE_ANALYTICS_RELEASE_BUILD`  | `1`, set only by the publishing build in `publish.yml`                                                |
| `MR_STREAMER_SITE_ANALYTICS_HOST`           | `https://eu.i.posthog.com`, from the repository variable `POSTHOG_HOST`. Any other host sends nothing |
| `MR_STREAMER_SITE_ANALYTICS_PROJECT_TOKEN`  | The project's public `phc_` key, from the repository variable `POSTHOG_PROJECT_TOKEN`                 |
| `MR_STREAMER_SITE_ANALYTICS_LOCAL_ENDPOINT` | A literal `http://127.0.0.1:<port>/i/v0/e/` for verification. It replaces production                  |

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
