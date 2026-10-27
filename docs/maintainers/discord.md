# Discord community

Wout owns the public [Mr. Streamer server](https://discord.gg/sR4tjEw6bQ). The invite never expires, has unlimited uses and does not grant temporary membership.

## Current server

Community, Rules Screening and native onboarding are enabled, with verified email, media scanning for all members and default notifications set to Only @mentions. `#rules` is the rules channel; private `#staff-chat` receives Community Updates. Preserve the manually arranged categories and the existing general, voice and update channels.

| Area      | Channels and behavior                                                                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry     | `#start-here` contains the pinned introduction; `#welcome` is configured for Carl's short greeting with start/help links, without welcome DMs or broad pings. New-member delivery is pending.           |
| Community | `Community > #general` is for chat; `#help` is a public forum. Existing tags: Bug, Feature Request, Help, Discussion, Needs Info, In Progress and Resolved. The three status tags are staff-controlled. |
| Updates   | `#releases` and `#nightly` carry announcements. `Updates > #general` is a separate announcement channel.                                                                                                |
| Staff     | `#staff-chat`, `#bot-logs` and `#ticket-transcripts` are private.                                                                                                                                       |
| Support   | `#contact-support` is restricted during verification. Tickets are private text channels in Tickets. Public launch requires the member checks below.                                                     |

Owner, Admin and Moderator are the existing staff roles. Carl and Ticket Tool remain below protected staff roles. Ticket Tool has its nine invite permissions without Administrator: Manage Channels, Manage Roles, View Channel, Send Messages, Manage Messages, Embed Links, Attach Files, Read Message History and Use Application Commands. It does not have the shared Bot role.

The **Mr. Streamer** provisioning bot owns the release webhooks and keeps Administrator. Removing it may break announcements. Like the server owner and administrator roles, it bypasses ticket and transcript channel denies. Tokens and webhook URLs stay private, never in commits, logs or evidence.

Members select Stable/Nightly announcement roles through native Channels & Roles onboarding. Announcements suppress mentions; members choose notifications per channel. No duplicate reaction-role panel is needed. Cross-server **Publish** stays manual.

## Support playbook

Use the searchable `#help` forum for ordinary questions. Search first, create one topic per problem and choose a relevant tag. Staff apply Needs Info, In Progress or Resolved as appropriate. Move reproducible product bugs to a redacted [GitHub bug report](https://github.com/Mr-Streamer-OSS/MrStreamer/issues/new/choose). Security reports go privately to **security@mrstreamer.app**, per [the security policy](../../.github/SECURITY.md).

Private tickets are for staff attention, not secret storage. Never ask for provider logins, passwords, tokens, playlist/stream URLs or unredacted settings. Support is best effort.

Ticket Tool's free panel uses Moderator as Support Team, with Additional Roles empty. The global and panel limits are one open ticket per member. The intake requires category, app version/OS, problem and expected result, and steps tried; a redacted diagnostics link is optional. Form answers are displayed inside the ticket.

Two Step Close and Two Step Ticket are enabled. Close confirms first and keeps a closed ticket; staff can reopen it. Delete and Transcript buttons and commands are Support Team Only. Automatic deletion, automatic transcript saves, transcript DMs, Google Drive storage and channel reuse are disabled.

Save a transcript **manually only when necessary**, to staff-only `#ticket-transcripts`, with the HTML attachment. Free transcripts cover the latest 1,000 messages; free attachment preservation is not guaranteed. Hosted viewer authorization is unverified. Do not promise that a forwarded file or link remains private, or that deleting its message recalls downloaded copies.

At resolution, staff record the resolution date and delete closed tickets and remove retained transcript messages and controlled exports **within 30 days**. This is a manual staff task, not automatic expiry. Avoid unnecessary exports; share a redacted copy individually only when appropriate. Decide whether a manual record is needed before deleting the closed ticket. Never delete unrelated member data as setup cleanup.

## Carl and native moderation

Carl uses `#bot-logs` for moderation actions and relevant member, role and channel events. Message edit/delete/purge logging and voice chatter are off. Tickets and transcripts deny Carl access; generated ticket overwrites were checked to deny `@everyone` and grant no shared Bot/Carl access. Keep message-content logging off and recheck new ticket overwrites after panel permission changes. Staff event logs may still include ticket names or opener IDs.

Native Discord AutoMod retains suspected-spam blocking with alerts to `#bot-logs` and mention-spam blocking at 20 mentions with raid protection. Carl's slowmode, mention-spam and attachment-spam rate limits are disabled to avoid duplicate spam enforcement. Existing moderation settings are otherwise preserved; no new automatic bans were added. Carl's moderation commands retain their staff permission requirements, with Admin as Bot Manager.

Carl has public, unrestricted saved replies named `download`, `guides`, `bug` and `nightly`. Invoke them by mentioning Carl followed by the name, for example `@Carl-bot guides`. Prefix commands were phased out in October 2026; do not teach `!download`. Ordinary-member invocation still needs the acceptance check below.

## Verification and launch gate

The [support setup project card](https://github.com/orgs/Mr-Streamer-OSS/projects/1?pane=issue&itemId=284454567) records the approved plan, settings, rollback instructions, PR and observed proof. Sanitized local snapshots support that record; keep them until acceptance. Wout has only the owner account available and will test ordinary-member paths later. Configuration readback and owner tests do not establish member privacy or Moderator permissions. Overall acceptance remains pending.

The entry point is [restricted #contact-support](https://discord.com/channels/1564289427230949517/1564550464198942720); transcripts are in [staff #ticket-transcripts](https://discord.com/channels/1564289427230949517/1564550461133160569). For the later check:

1. Both ordinary test members join through the invite, complete native onboarding and then accept Rules Screening before testing support. Confirm the new-member welcome and Stable/Nightly role selection. Neither member should have a staff or Administrator role.
2. Wout temporarily grants **only the test opener** View Channel, Read Message History and Use Application Commands in contact-support. Send Messages and thread creation stay denied by the channel's `@everyone` overwrite. Keep the entry hidden from everyone else.
3. The ordinary opener submits a clearly labelled, non-sensitive ticket. Confirm all five intake fields and try opening a second ticket while the first is open; it must be refused.
4. An unrelated ordinary member must not reach the ticket or transcript channel, in the channel list or through direct links. Owner access or role preview cannot substitute.
5. A Moderator replies, closes with confirmation, reopens, saves a manual transcript and deletes the setup ticket. The opener must be refused Transcript/Delete. Confirm the transcript lands only in the staff channel and Carl cannot see the ticket/transcript. A tester may get a temporary Moderator role after the ordinary phase; remove it afterward.
6. Test a public [help forum](https://discord.com/channels/1564289427230949517/1564320588808454305) post and staff status tag, the four helpful replies and a controlled native spam alert in [bot-logs](https://discord.com/channels/1564289427230949517/1564303920916996096). No duplicate Carl spam action or release publication is expected.
7. Record exact links/results on the same card, then remove deliberately created test artifacts and temporary access. Only after these checks pass, allow `@everyone` View Channel, Read Message History and Use Application Commands in contact-support while retaining its Send Messages and thread-creation denies; keep Tickets and transcripts private. Recheck ordinary access before marking the card Done.

Rollback starts by restricting contact-support or disabling its Create button. Restore changed Carl/onboarding settings using the support card's rollback contract and retained private snapshots. Remove only deliberately created setup artifacts. Existing announcements, user conversations and server layout are not rollback targets.

## Release webhooks

The bot created the release webhooks; setup stored their URLs as these **repository Actions secrets on GitHub**, `Mr-Streamer-OSS/MrStreamer`, where releases run:

- `DISCORD_STABLE_WEBHOOK_URL`: `#releases`
- `DISCORD_NIGHTLY_WEBHOOK_URL`: `#nightly`

The GitCafe source mirror does not run GitHub Actions. No new PAT is needed. Never commit or log webhook URLs; possession allows posting. To rotate one, create a replacement in the same channel, set its avatar to `apps/ios/assets/icon.png`, replace its GitHub secret, verify delivery and delete the old webhook in Discord. Remove the secret to disable that channel's announcements.

`publish.yml`'s Discord job runs only after its GitHub release job succeeds, including the nightly published first during a stable run. Both callers inherit secrets. Dry runs never call the publisher; skipped or failed publication sends nothing. Feed, Store and website results do not control announcements. A message means the GitHub notes/downloads are available, not that every distribution surface has updated.

`scripts/discord-release.ts` selects only that channel's webhook and posts the channel, version and GitHub release page. Mentions are explicitly suppressed with `allowed_mentions: { parse: [] }`. The single request waits for server confirmation, has a ten-second timeout and follows no redirects. Missing configuration, HTTP errors and network timeouts warn without failing publication. The job also tolerates infrastructure failures, so Discord cannot fail a nightly-first publisher and block stable. It can add up to its two-minute job timeout while GitHub waits for the reusable publisher to finish.

There are no automatic retries. A timeout may have delivered the message: inspect the channel before retrying, or rerunning the Discord job. Rerunning a successful announcement job can duplicate its post. Do not rerun publication or publish a release to test Discord.

## Setup proof

On 26 October 2026, both labelled setup posts were sent with `scripts/discord-release.ts --test` and confirmed by Discord with zero mentions: [Stable v0.0.20](https://discord.com/channels/1564289427230949517/1564291463183990784/1564291770303381584) and [Nightly v0.0.21-nightly.20261026.431](https://discord.com/channels/1564289427230949517/1564291465452986439/1564291774602678402). The [original community card](https://github.com/orgs/Mr-Streamer-OSS/projects/1?pane=issue&itemId=283580626) holds that setup evidence and its pending second-account check: rules acceptance, reading the read-only channels, writing in general/help and hidden staff channels.

For a labelled delivery check without publishing anything, privately supply the two webhook environment variables, then run the script with Node 24 once per channel with `--test`, `CHANNEL`, `VERSION`, `TAG` and `GITHUB_REPOSITORY=Mr-Streamer-OSS/MrStreamer`. Use existing published release tags and versions. Keep webhook values out of terminal history and recordings. Confirm both `[Setup test]` messages appear in the intended channels, link the correct release pages and create no mentions. Do not cross-server Publish test messages.

Keep the original webhook proof on that community card; record the new support setup and member results on the support setup card. Do not reopen the Done community card. These live checks are separate from the local webhook stub tests, which prove delivery payloads, routing, warnings and bounded failure handling.

References: [Community requirements](https://support.discord.com/hc/en-us/articles/360047132851-Enabling-Your-Community-Server), [invites](https://support.discord.com/hc/en-us/articles/208866998-Invites-101), [announcement channels](https://support.discord.com/hc/en-us/articles/360032008192-Announcement-Channel-FAQ), [webhook execution](https://docs.discord.com/developers/resources/webhook#execute-webhook).
