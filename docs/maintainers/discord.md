# Discord community

Wout owns the public [Mr. Streamer server](https://discord.gg/sR4tjEw6bQ) and moderates initially. The invite never expires, has unlimited uses and does not grant temporary membership.

## Server configuration

Community is enabled, with verified email, media scanning for all members and default notifications set to Only @mentions. `#start-here` is the rules channel; private `#moderators` receives Community Updates. The server icon and bot avatar use `apps/ios/assets/icon.png`.

The **Mr. Streamer** bot configured the server through the Discord API and owns the release webhooks. It stays in the server: removing it may break announcements. It has Administrator permission; its token stays private with Wout, never in the repository, logs or evidence. Release delivery uses the GitHub Actions webhook secrets and needs no continuously hosted bot process.

Roles, in intended order below the bot's own role:

| Role       | Permissions                                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Admin      | Administrator                                                                                                                                                                                    |
| Soft Admin | Moderator rights plus Manage Server, Channels, Roles, Threads and Nicknames, Create and Manage Expressions and Events, and View Audit Log; no Administrator, Manage Webhooks or Mention Everyone |
| Moderator  | View Channels, Read Message History, Manage Messages, Moderate Members, Kick Members and Ban Members; no Administrator or server, role or webhook management                                     |

Wout is moving the bot role above Admin so this order can apply. All three roles can see `#moderators`.

| Channel       | Type         | Ordinary members |
| ------------- | ------------ | ---------------- |
| `#start-here` | Text, rules  | Read             |
| `#releases`   | Announcement | Read             |
| `#nightly`    | Announcement | Read             |
| `#general`    | Text         | Read and write   |
| `#help`       | Text         | Read and write   |
| `#moderators` | Private text | Hidden           |

The three read-only channels allow View Channel and Read Message History; their `@everyone` overrides deny Send Messages, Send Messages in Threads, Create Public Threads and Create Private Threads. `#moderators` denies `@everyone` View Channel and allows Moderator and Soft Admin View Channel, Send Messages and Read Message History. Helpers do not need permission to post release announcements.

**Mention @everyone, @here and All Roles** is off for `@everyone`, Moderator and Soft Admin. Members choose their own channel notifications. Do not use `@everyone` or `@here` pings. Cross-server **Publish** stays manual; webhook delivery does not publish to followers.

Rules Screening requires members to accept five rules before talking:

1. Be kind and respectful.
2. No spam or self-promotion.
3. No piracy requests. Never share subscriptions, credentials, provider addresses, stream URLs or viewing history.
4. Report bugs on GitHub with your app version, system and steps.
5. Moderators may remove messages or members that break these rules.

This welcome is pinned in `#start-here`:

> Welcome to Mr. Streamer. Get the app: https://mrstreamer.app/download
>
> Be kind. No spam, piracy requests or sharing subscriptions, credentials, provider addresses, stream URLs or viewing history.
>
> Chat in #general, ask questions in #help. #releases has Stable updates; #nightly has previews. Choose notifications per channel.
>
> Report reproducible bugs with your app version, system and steps: https://github.com/Mr-Streamer-OSS/MrStreamer/issues/new/choose

Wout's ordinary second-account check is pending: join through the invite, confirm the rules prompt and acceptance, read the three read-only channels, write in general/help and confirm moderators is hidden. Configuration and role preview do not prove this member path.

## Release webhooks

The bot created the release webhooks; setup stored their URLs as these **repository Actions secrets on GitHub**, `Mr-Streamer-OSS/MrStreamer`, where releases run:

- `DISCORD_STABLE_WEBHOOK_URL`: `#releases`
- `DISCORD_NIGHTLY_WEBHOOK_URL`: `#nightly`

The GitCafe source mirror does not run GitHub Actions. No new PAT is needed. Never commit or log webhook URLs; possession allows posting. To rotate one, create a replacement in the same channel, replace its GitHub secret, verify delivery and delete the old webhook in Discord. Remove the secret to disable that channel's announcements.

`publish.yml`'s Discord job runs only after its GitHub release job succeeds, including the nightly published first during a stable run. Both callers inherit secrets. Dry runs never call the publisher; skipped or failed publication sends nothing. Feed, Store and website results do not control announcements. A message means the GitHub notes/downloads are available, not that every distribution surface has updated.

`scripts/discord-release.ts` selects only that channel's webhook and posts the channel, version and GitHub release page. Mentions are explicitly suppressed with `allowed_mentions: { parse: [] }`. The single request waits for server confirmation, has a ten-second timeout and follows no redirects. Missing configuration, HTTP errors and network timeouts warn without failing publication. The job also tolerates infrastructure failures, so Discord cannot fail a nightly-first publisher and block stable. It can add up to its two-minute job timeout while GitHub waits for the reusable publisher to finish.

There are no automatic retries. A timeout may have delivered the message: inspect the channel before retrying, or rerunning the Discord job. Rerunning a successful announcement job can duplicate its post. Do not rerun publication or publish a release to test Discord.

## Setup proof

On 26 October 2026, both labelled setup posts were sent with `scripts/discord-release.ts --test` and confirmed by Discord with zero mentions: [Stable v0.0.20](https://discord.com/channels/1564289427230949517/1564291463183990784/1564291770303381584) and [Nightly v0.0.21-nightly.20261026.431](https://discord.com/channels/1564289427230949517/1564291465452986439/1564291774602678402). The project card holds setup evidence and the pending second-account check.

For a labelled delivery check without publishing anything, privately supply the two webhook environment variables, then run the script with Node 24 once per channel with `--test`, `CHANNEL`, `VERSION`, `TAG` and `GITHUB_REPOSITORY=Mr-Streamer-OSS/MrStreamer`. Use existing published release tags and versions. Keep webhook values out of terminal history and recordings. Confirm both `[Setup test]` messages appear in the intended channels, link the correct release pages and create no mentions. Do not cross-server Publish test messages.

Record the member check result and any new test message links on the existing project card. These live checks are separate from the local webhook stub tests, which prove delivery payloads, routing, warnings and bounded failure handling.

References: [Community requirements](https://support.discord.com/hc/en-us/articles/360047132851-Enabling-Your-Community-Server), [invites](https://support.discord.com/hc/en-us/articles/208866998-Invites-101), [announcement channels](https://support.discord.com/hc/en-us/articles/360032008192-Announcement-Channel-FAQ), [webhook execution](https://docs.discord.com/developers/resources/webhook#execute-webhook).
