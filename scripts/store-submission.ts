// The Microsoft side of a Store submission, through Microsoft's Store submission API: what the
// Store holds, sending a checked package, and reading what Microsoft did with it.
// scripts/store-release.ts is the GitHub side; docs/maintainers/microsoft-store.md describes both.
//
//   node scripts/store-submission.ts preflight [--release <file> [--draft <id> [--draft-metadata-sha256 <hex>]]]
//   node scripts/store-submission.ts submit --release <file> [--draft <id> --draft-metadata-sha256 <hex>]
//   node scripts/store-submission.ts status --release <file>
//
// The credential comes from the environment: STORE_TENANT_ID, STORE_CLIENT_ID and
// STORE_CLIENT_SECRET, with STORE_CLIENT_SECRET_EXPIRES for the day the key ends.
//
// preflight and status only read. submit follows these rules:
//
// - A new submission is Microsoft's copy of the published one. It goes back as it came, fields
//   this script doesn't know included, with two changes: the package, and "What's new". The
//   description, screenshots, trailers, price and markets stay as they are.
// - A listing has to carry its package's name. With a package named STORE_NAME, every listing
//   titled otherwise gets that name as its title, which happens once. A package built before
//   that name changes no title.
// - It never sets who sees the app or when it is published. The published submission must be
//   Public and publish as soon as it is certified (Immediate), or nothing is created.
// - A package is uploaded under a name that carries the release's commit and the file's checksum.
//   That name is how a later run finds its own submission, so repeating a run adds nothing.
// - The Store takes one submission at a time. One that doesn't hold this release's package stops
//   the run, whoever made it, and so does a published package this one doesn't sort after.
//   Nothing is ever deleted, and a submission Microsoft is checking is never changed.
// - A release goes into a draft someone made in Partner Center only when the run names it, with
//   --draft, and never into a new submission then. submit also takes the draft's fingerprint, which
//   a preflight with the draft prints: the SHA-256 of all the draft holds that a release leaves
//   alone. The draft must be the one named, still have that fingerprint and hold no package but
//   the published ones and this release's. It is read again once the release is in it and once
//   the package is uploaded, and nothing is uploaded or committed unless the rest is as it was.
// - In such a draft the package's name also carries the draft's ID and the start of that
//   fingerprint. Only a run that names both looks for that name, so a release's own run and a
//   plain submit stop at the draft however far an earlier run got with it.
// - Only requests that change nothing by being repeated are sent again. When creating or
//   committing gets no clear answer, the script reads what happened instead of asking twice.
// - Nothing of a token, the key or an upload address is printed, and of Microsoft's answers only
//   what this script knows the shape of.
//
// The Store job runs it with plain node and installs no packages, so it imports only node: modules
// and dependency-free files, by relative path.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { comparePackageVersions } from "../packages/contracts/src/package-version.ts";
import {
  isRecord,
  readStoreRelease,
  STORE_APP,
  STORE_ENVIRONMENT,
  STORE_NAME,
  storeFilePrefix,
  type StorePackage,
  type StoreRelease,
} from "./store-release.ts";
import { storedZip } from "./zip.ts";

const LOGIN = "https://login.microsoftonline.com";
const API = "https://manage.devcenter.microsoft.com";
const APP = `${API}/v1.0/my/applications/${STORE_APP.id}`;

/** How often a request that changes nothing by being repeated is sent before giving up. */
const ATTEMPTS = 3;
const REQUEST_MS = 120_000;
/** Azure takes a file in blocks, and 4 MiB fits every version of its API. */
const BLOCK_BYTES = 4 * 1024 * 1024;
/** After a commit Microsoft checks the upload: asked every 15 seconds, for ten minutes at most. */
const COMMIT_POLL_MS = 15_000;
const COMMIT_POLLS = 40;
/** The Store's "What's new in this version" takes 1500 characters. */
const NOTES_MAX = 1500;
/** Approved listing text. The app interface and the change titles remain English. */
const NOTES_INTRO = {
  nl: "Nieuwe versie met verbeteringen en oplossingen. De volledige wijzigingen staan in het Engels op github.com/Mr-Streamer-OSS/MrStreamer/releases.",
  fr: "Nouvelle version avec améliorations et corrections. Les notes complètes sont en anglais sur github.com/Mr-Streamer-OSS/MrStreamer/releases.",
  de: "Neue Version mit Verbesserungen und Fehlerbehebungen. Die vollständigen Hinweise stehen auf Englisch unter github.com/Mr-Streamer-OSS/MrStreamer/releases.",
  es: "Nueva versión con mejoras y correcciones. Las notas completas están en inglés en github.com/Mr-Streamer-OSS/MrStreamer/releases.",
};
/** The key's end is worth a warning this long before it comes. */
const EXPIRY_WARNING_MS = 30 * 24 * 60 * 60 * 1000;

/** Statuses in which Microsoft is working on a submission, or it waits to be published. */
const WORKING = [
  "CommitStarted",
  "PreProcessing",
  "Certification",
  "Release",
  "Publishing",
  "PendingPublication",
];

const RECOVER = "run the Publish workflow's store target with submit";

/** A draft's fingerprint as a preflight prints it. */
const FINGERPRINT = /^[0-9a-f]{64}$/;

/** What is left for a draft that holds a release under a fingerprint it no longer has. */
const CHANGED =
  "No run goes on with it as it is: put back in Partner Center what changed, or finish the draft there.";

/** What to do about a new submission that got no package: only a person may delete one. */
const leftover = (id: string) =>
  `Submission ${id} is left as an untouched copy of the published one: delete it in Partner Center, then ${RECOVER}.`;

/** The network: `fetch`, or a test's stand-in for Microsoft. */
export type Send = (
  url: string,
  request: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string | Uint8Array;
    readonly signal: AbortSignal;
  },
) => Promise<Response>;

/** Who signs in, and how the script reaches Microsoft. */
export interface StoreAccess {
  readonly tenantId: string;
  readonly clientId: string;
  /** The application's key. */
  readonly clientSecret: string;
  readonly send: Send;
  /** Waits between attempts and between polls. */
  readonly wait: (ms: number) => Promise<void>;
}

/** A release whose package `verify` has checked. */
export type CheckedRelease = StoreRelease & { readonly package: StorePackage };

/** A draft someone made in Partner Center, named for a release to go into. */
export interface Draft {
  /** The draft's submission ID. */
  readonly id: string;
  /**
   * The fingerprint a preflight read from the draft before any release went into it: the SHA-256
   * of what a release leaves alone in it. `submit` needs it. A preflight compares it when it has
   * one, and reads the draft's own otherwise.
   */
  readonly metadataSha256: string | null;
}

/** What a submission means for a release. Only "live" says Store users get it. */
export type Stage = "live" | "in-progress" | "draft" | "failed" | "absent";

/** Where a release stands in the Store, each part reported on its own. */
export interface Outcome {
  /** The GitHub release. */
  readonly version: string;
  readonly commit: string;
  /** The package version the Store reads. */
  readonly packageVersion: string;
  /**
   * The package's name in the Store, which in a draft a run named also carries the draft's ID and
   * the start of its fingerprint. Null when the Store has none of this release.
   */
  readonly fileName: string | null;
  readonly submissionId: string | null;
  /** Microsoft's own word for where the submission stands. */
  readonly status: string | null;
  readonly stage: Stage;
  /** Microsoft's errors and warnings, and what this script adds. */
  readonly remarks: readonly string[];
}

export interface Preflight {
  /** What the account and the Store hold. */
  readonly found: readonly string[];
  /** What would stop a submission. Empty when one could go ahead. */
  readonly problems: readonly string[];
  /** The fingerprint of the draft that was named. Null unless that draft is the one in progress. */
  readonly draftMetadataSha256: string | null;
}

/** A refusal or failure to show as it is: its message holds nothing secret. */
export class StoreError extends Error {}

/** What Microsoft answered. */
interface Answer {
  readonly status: number;
  /** The body as JSON; undefined when it wasn't JSON. */
  readonly body: unknown;
  /** Microsoft's ID for the request, which its support asks for. */
  readonly correlation: string | null;
}

interface Session {
  readonly access: StoreAccess;
  readonly token: string;
  /** Makes Microsoft's text safe to print. */
  readonly clean: (text: string) => string;
}

interface SubmittedPackage {
  readonly fileName: string;
  /** PendingUpload, Uploaded or PendingDelete. */
  readonly fileStatus: string;
  /** Empty until Microsoft has read the file. */
  readonly version: string;
}

/** What this script reads from a submission. */
interface Submission {
  readonly id: string;
  readonly status: string;
  readonly visibility: string;
  readonly publishMode: string;
  readonly packages: readonly SubmittedPackage[];
  /** Where its files are uploaded. Secret: whoever has it can write there. */
  readonly uploadUrl: string | null;
  /** Microsoft's errors and warnings about it, safe to print. */
  readonly remarks: readonly string[];
  /** All of it, as Microsoft sent it. */
  readonly raw: Record<string, unknown>;
}

interface StoreState {
  /** What the Store offers now. */
  readonly published: Submission;
  /** The submission in progress: a draft, one Microsoft is checking, or one it refused. */
  readonly pending: Submission | null;
}

type Step =
  /** The release is in the Store's hands already. */
  | { readonly take: "report"; readonly submission: Submission; readonly live: boolean }
  /** An earlier run's draft holds the package and was never committed. */
  | { readonly take: "resume"; readonly draft: Submission }
  /** A new submission. `renamed` lists the languages whose listing takes the package's name. */
  | { readonly take: "create"; readonly renamed: readonly string[] }
  /**
   * The draft the run named takes the release. `lacking` lists the fields that don't hold it yet,
   * none once an earlier run put it there.
   */
  | {
      readonly take: "adopt";
      readonly draft: Submission;
      readonly named: Draft;
      readonly lacking: readonly string[];
      readonly renamed: readonly string[];
    };

/** What a run that named a draft does next, which is never a new submission. */
type DraftStep = Extract<Step, { take: "adopt" | "report" }>;

/**
 * Says what the account holds and, given a release, what `submit` would do with it. With `draft`,
 * that is what a submit into that draft would do, and the draft's fingerprint is read for it.
 * Reads only.
 */
export async function preflight(
  access: StoreAccess,
  release: CheckedRelease | null,
  draft?: Draft,
): Promise<Preflight> {
  const given = draft?.metadataSha256 ?? null;
  if (draft && !(release && isId(draft.id) && (given === null || FINGERPRINT.test(given)))) {
    throw new StoreError(
      "A preflight with a draft takes the draft's submission ID, the version of the release to put in it and, to compare one, the fingerprint an earlier preflight printed.",
    );
  }
  const session = await signIn(access);
  const state = await storeState(session);
  const { published, pending } = state;
  const found = [
    `Signed in. Application ${STORE_APP.id} is ${STORE_APP.identityName}.`,
    `Published: submission ${published.id}, ${published.visibility || "no audience"}, publishing ${published.publishMode || "unset"}.`,
    ...published.packages.map((file) => `Package ${file.fileName}: ${file.version || "unread"}.`),
    ...listingFacts(published, session.clean),
    pending
      ? `In progress: submission ${pending.id}, ${pending.status}.${draft ? "" : " A release waits until it is finished."}`
      : "No submission in progress.",
  ];
  const problems = new Set<string>();
  const attempt = (check: () => void) => {
    try {
      check();
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      problems.add(error.message);
    }
  };
  attempt(() => assertPublic(published, "The published submission"));
  let draftMetadataSha256: string | null = null;
  if (release) {
    // The named draft's fingerprint is read whatever else would stop a submission into it.
    if (draft && pending?.id === draft.id) {
      draftMetadataSha256 = fingerprint(pending, release);
      const edited = differing(metadata(published, release), metadata(pending, release));
      found.push(
        `Of what a release leaves alone, the draft ${pending.id} differs from the published submission in ${listed(edited, session.clean)}.`,
        `Its fingerprint is ${draftMetadataSha256}, the SHA-256 of what a release leaves alone in it. A submit into the draft takes it.`,
      );
    }
    // The package is looked for under the fingerprint the run names, or else the draft's own.
    const original = given ?? draftMetadataSha256;
    const entering = draft && original ? inDraft(release, draft.id, original) : release;
    const { fileName } = entering.package;
    attempt(() => {
      const step = nextStep(state, entering, draft);
      found.push(
        step.take === "create"
          ? `${release.version} would go in a new submission, as ${fileName}.`
          : step.take === "adopt" && step.lacking.length > 0
            ? `${release.version} would go in the draft ${step.draft.id}, as ${fileName}.`
            : step.take === "report"
              ? `${release.version} is in submission ${step.submission.id} already: nothing would be sent.`
              : `${release.version} would be committed in the draft ${step.draft.id}, which holds it.`,
      );
      if (step.take === "create" || step.take === "adopt") {
        found.push(...retitling(step.renamed, "would retitle", session.clean));
      }
    });
  }
  return { found, problems: [...problems], draftMetadataSha256 };
}

/**
 * Sends `release`'s package to the Store, unless the Store has it: then it reports where that
 * submission stands and changes nothing. Returns once Microsoft took or refused the commit, which
 * is long before certification ends. Throws a StoreError when the submission is refused here.
 * With `draft` the release goes into that draft, by its ID and fingerprint, and into nothing else.
 */
export async function submit(
  access: StoreAccess,
  checked: CheckedRelease,
  draft?: Draft,
): Promise<Outcome> {
  const original = draft?.metadataSha256 ?? "";
  if (draft && !(isId(draft.id) && FINGERPRINT.test(original))) {
    throw new StoreError(
      "A release goes into a draft by the draft's submission ID and its fingerprint: the SHA-256, 64 hexadecimal characters, that a preflight with the draft prints. Nothing was sent.",
    );
  }
  const release = draft ? inDraft(checked, draft.id, original) : checked;
  const session = await signIn(access);
  const step = nextStep(await storeState(session), release, draft);
  const reported = (
    { submission, live }: Extract<Step, { take: "report" }>,
    ...remarks: string[]
  ): Outcome => ({
    ...subject(release),
    fileName: release.package.fileName,
    submissionId: submission.id,
    status: submission.status,
    stage: live ? "live" : stageOf(submission.status),
    remarks: [...submission.remarks, ...remarks],
  });
  if (step.take === "report") return reported(step);
  // Only a run that names the draft and this fingerprint finds the package in it again.
  const again = draft ? `${RECOVER}, the draft ${draft.id} and the same fingerprint` : RECOVER;
  let target: Submission;
  if (step.take === "adopt") {
    const ready = await adopt(session, step, release, again);
    if (ready.take === "report") {
      return reported(
        ready,
        `Someone committed the draft ${ready.submission.id} while this run put the release in it. This run committed nothing, and can't say that the rest of the draft was as its fingerprint says by then.`,
      );
    }
    target = ready.draft;
  } else {
    target =
      step.take === "create" ? await fill(session, await create(session), release) : step.draft;
    await upload(session, target, release, again);
  }
  const committed = await commit(session, target.id, again);
  return {
    ...subject(release),
    fileName: release.package.fileName,
    submissionId: target.id,
    status: committed.status,
    stage: stageOf(committed.status),
    remarks: [
      ...committed.remarks,
      ...(step.take === "resume" ? [] : retitling(step.renamed, "retitles", session.clean)),
      ...(step.take === "adopt"
        ? [
            `It went into the draft ${target.id}, which the run named. Read again after the upload, right before the commit, the rest of the draft was as its fingerprint says. A repeat of this run names the draft and the fingerprint again.`,
          ]
        : []),
    ],
  };
}

/**
 * Where `release` stands in the Store: by the name this automation gives its packages, in a draft
 * a run named too, or else by the package version, which finds a package someone uploaded in
 * Partner Center. Reads only.
 */
export async function status(access: StoreAccess, release: StoreRelease): Promise<Outcome> {
  const session = await signIn(access);
  const { published, pending } = await storeState(session);
  const prefix = storeFilePrefix(release);
  const named = (file: SubmittedPackage) => file.fileName.startsWith(prefix);
  const numbered = (file: SubmittedPackage) => file.version === release.packageVersion;
  for (const mine of [named, numbered]) {
    for (const submission of [published, pending]) {
      const file = submission && held(submission, mine);
      if (!file) continue;
      return {
        ...subject(release),
        fileName: file.fileName,
        submissionId: submission.id,
        status: submission.status,
        stage: submission === published ? "live" : stageOf(submission.status),
        remarks: [
          ...submission.remarks,
          ...(mine === named
            ? []
            : [
                `The Store lists it as ${file.fileName}, a name this automation doesn't give: it was uploaded another way, and only its version ties it to the release.`,
              ]),
        ],
      };
    }
  }
  const offered = published.packages.map((file) => file.version || file.fileName).join(", ");
  return {
    ...subject(release),
    fileName: null,
    submissionId: null,
    status: null,
    stage: "absent",
    remarks: [
      `The Store offers ${offered || "no package"}, from submission ${published.id}.`,
      ...(pending
        ? [`Submission ${pending.id} is in progress (${pending.status}), with other packages.`]
        : []),
    ],
  };
}

/**
 * The Store's plain-text "What's new": a fixed introduction for Dutch, French, German and
 * Spanish, then whole English PR titles in release-note order, within the field limit. Other
 * languages keep English notes. With no titles, use the introduction or the release version.
 */
export function storeNotes(
  release: Pick<StoreRelease, "version" | "notes">,
  language = "en-us",
): string {
  const locale = language.toLowerCase().split("-")[0];
  let notes = Object.entries(NOTES_INTRO).find(([key]) => key === locale)?.[1] ?? "";
  for (const [, title] of release.notes.matchAll(/^\* (.+) by @\S+ in \S+$/gm)) {
    const next = `${notes}${notes ? "\n" : ""}- ${title}`;
    if (next.length > NOTES_MAX) break;
    notes = next;
  }
  return notes || `Mr. Streamer ${release.version}.`;
}

/**
 * What to say about the day the key ends, `expires` as YYYY-MM-DD: nothing while it is more than
 * 30 days away.
 */
export function keyExpiry(expires: string | undefined, now: number): string | null {
  const renew = "docs/maintainers/microsoft-store.md#renewing-the-key says how to renew it.";
  const end = /^\d{4}-\d{2}-\d{2}$/.test(expires ?? "") ? Date.parse(`${expires}T00:00:00Z`) : NaN;
  if (Number.isNaN(end)) {
    return `No day is recorded for the end of the Store key, in the variable STORE_CLIENT_SECRET_EXPIRES. ${renew}`;
  }
  if (end <= now) return `The Store key ended on ${expires}, by the recorded date. ${renew}`;
  if (end - now > EXPIRY_WARNING_MS) return null;
  return `The Store key ends on ${expires}, in ${Math.ceil((end - now) / 86_400_000)} days. ${renew}`;
}

function subject(release: StoreRelease) {
  return {
    version: release.version,
    commit: release.commit,
    packageVersion: release.packageVersion,
  };
}

function stageOf(status: string): Stage {
  if (status === "Published") return "live";
  if (status === "PendingCommit") return "draft";
  // Everything else is a refusal or a stop: the Failed statuses, Canceled, and any word Microsoft
  // adds later, which is safer read as a failure than as progress.
  return WORKING.includes(status) ? "in-progress" : "failed";
}

/**
 * The languages whose listing takes the Store name as its title when `release` goes into
 * `submission`. A listing has to carry its package's name: one titled otherwise changes when the
 * package is named STORE_NAME. A package built before that name changes none.
 */
function retitled(submission: Submission, release: CheckedRelease): string[] {
  const { listings } = submission.raw;
  if (release.package.displayName !== STORE_NAME || !isRecord(listings)) return [];
  return Object.entries(listings).flatMap(([language, listing]) =>
    isRecord(listing) &&
    isRecord(listing["baseListing"]) &&
    listing["baseListing"]["title"] !== STORE_NAME
      ? [language]
      : [],
  );
}

/**
 * What to say about a submission that gives the listings in `languages` the Store name: it
 * "retitles" them once it is made, and "would retitle" them before. Nothing when none changes.
 */
function retitling(
  languages: readonly string[],
  verb: "retitles" | "would retitle",
  clean: Session["clean"],
): string[] {
  if (languages.length === 0) return [];
  return [
    `The submission ${verb} the listing in ${languages.map(clean).join(", ")} "${STORE_NAME}", as its package is named.`,
  ];
}

/** The package of `submission` that `mine` recognises, unless it is on its way out. */
function held(
  submission: Submission,
  mine: (file: SubmittedPackage) => boolean,
): SubmittedPackage | undefined {
  return submission.packages.find((file) => file.fileStatus !== "PendingDelete" && mine(file));
}

/**
 * What the Store's name for `release`'s package starts with in every draft a run named, whatever
 * the draft and its fingerprint. Takes the release under either of its names.
 */
function draftFileStem(release: CheckedRelease): string {
  return release.package.fileName.replace(/(\.draft-.+)?\.msix$/, ".draft-");
}

/**
 * `release` with its package named as it is in the draft `id`, which a run named: the name it has
 * anywhere, then the draft's ID and the start of `metadataSha256`, the fingerprint that run gave.
 * A run that names no draft, another one or another fingerprint looks for another name, so none
 * finds the package there. A fingerprint leaves the packages out, so the name stays the same once
 * the package is in the draft.
 */
function inDraft(release: CheckedRelease, id: string, metadataSha256: string): CheckedRelease {
  const fileName = `${draftFileStem(release)}${id}.${metadataSha256.slice(0, 16)}.msix`;
  return { ...release, package: { ...release.package, fileName } };
}

/**
 * What `submit` does next for `release`. Throws when the Store's state refuses a submission:
 * another one is in progress, a published package isn't older, or the listing isn't Public and
 * Immediate. With `draft`, the release goes into that draft or nowhere.
 */
function nextStep(state: StoreState, release: CheckedRelease, draft: Draft): DraftStep;
function nextStep(state: StoreState, release: CheckedRelease, draft?: Draft): Step;
function nextStep(state: StoreState, release: CheckedRelease, draft?: Draft): Step {
  const { published, pending } = state;
  const mine = (file: SubmittedPackage) => file.fileName === release.package.fileName;
  if (held(published, mine)) return { take: "report", submission: published, live: true };
  for (const file of published.packages) {
    let newer: boolean;
    try {
      newer = comparePackageVersions(release.packageVersion, file.version) > 0;
    } catch {
      throw new StoreError(
        `Microsoft lists the published package ${file.fileName} with the version "${file.version}", which can't be compared with ${release.packageVersion}.`,
      );
    }
    if (!newer) {
      throw new StoreError(
        `The Store offers package ${file.version} already, as ${file.fileName}. ${release.packageVersion} doesn't sort after it, so ${release.version} isn't submitted.`,
      );
    }
  }
  if (draft) return draftStep(state, release, draft);
  if (!pending) {
    assertPublic(published, "The published submission");
    return { take: "create", renamed: retitled(published, release) };
  }
  if (!held(pending, mine)) {
    const named = held(pending, (file) => file.fileName.startsWith(draftFileStem(release)));
    throw new StoreError(
      named
        ? `Submission ${pending.id} is in progress (${pending.status}) and holds ${release.version}'s package as ${named.fileName}: a run that named it as a draft put the release there. Only a run that names the draft and the same fingerprint goes on with it, so nothing is sent.`
        : `Submission ${pending.id} is in progress (${pending.status}) and doesn't hold ${release.package.fileName}. The Store takes one submission at a time: let it finish, or delete it in Partner Center if nobody needs it, then ${RECOVER}. This script deletes nothing.`,
    );
  }
  if (pending.status !== "PendingCommit") {
    return { take: "report", submission: pending, live: false };
  }
  assertPublic(pending, "The draft");
  return { take: "resume", draft: pending };
}

/**
 * What `submit` does next for `release`, named as `inDraft` names it, when the run named `draft`
 * for it. Throws unless the submission in progress is that draft, with the fingerprint the run
 * gave and no package but the published ones and this release's. Never a new submission.
 */
function draftStep(state: StoreState, release: CheckedRelease, draft: Draft): DraftStep {
  const { published, pending } = state;
  const { fileName } = release.package;
  if (pending?.id !== draft.id) {
    throw new StoreError(
      `${pending ? `Submission ${pending.id} is in progress, not the draft ${draft.id} that the run names, and is left alone` : `The app has no submission in progress, so no draft ${draft.id} for ${release.version} to go in`}. A run that names a draft never creates a submission.`,
    );
  }
  const mine = held(pending, (file) => file.fileName === fileName);
  // Committed with the release in it, by whoever: Microsoft changes it from here on, and no run can.
  if (mine && pending.status !== "PendingCommit") {
    return { take: "report", submission: pending, live: false };
  }
  if (draft.metadataSha256 !== null && fingerprint(pending, release) !== draft.metadataSha256) {
    throw new StoreError(
      `The draft ${pending.id} doesn't have the fingerprint the run names: something a release leaves alone in it differs from what that preflight read. The draft is left as it is. ${mine ? `It holds the release. ${CHANGED}` : "Look at it in Partner Center, then run preflight with the draft to read its fingerprint again."}`,
    );
  }
  const strange = pending.packages.filter(
    (file) =>
      file !== mine &&
      !published.packages.some(
        (offered) => offered.fileName === file.fileName && offered.version === file.version,
      ),
  );
  const stale = strange.find((file) => file.fileName.startsWith(draftFileStem(release)));
  if (stale) {
    throw new StoreError(
      `The draft ${pending.id} holds ${release.version}'s package as ${stale.fileName}, which a run put there when the draft had another fingerprint: something a release leaves alone in it has changed since. The draft is left as it is. ${CHANGED}`,
    );
  }
  if (strange.length > 0) {
    throw new StoreError(
      `The draft ${pending.id} holds ${strange.length} package(s) that are neither the published submission's nor ${fileName} waiting for its upload. This release would replace them, so the draft is left as it is.`,
    );
  }
  if (pending.status !== "PendingCommit") {
    throw new StoreError(
      `Submission ${pending.id} is ${pending.status}, no longer a draft, and doesn't hold ${fileName}. It is left alone.`,
    );
  }
  assertPublic(pending, "The draft");
  return {
    take: "adopt",
    draft: pending,
    named: draft,
    lacking: unfilled(pending, release),
    renamed: retitled(pending, release),
  };
}

/**
 * What `submission` lacks of `release` as `fill` leaves one, by the paths of the fields: the
 * package's entry, a listing's "What's new" and, where the package's name goes into it, its title.
 * Empty when it holds all of it. Notes that differ only in Microsoft's line endings are the same.
 */
function unfilled(submission: Submission, release: CheckedRelease): string[] {
  const { listings } = submission.raw;
  return [
    ...(held(submission, (file) => file.fileName === release.package.fileName)
      ? []
      : ["applicationPackages"]),
    ...retitled(submission, release).map((language) => `listings.${language}.baseListing.title`),
    ...Object.entries(isRecord(listings) ? listings : {}).flatMap(([language, listing]) => {
      if (!isRecord(listing) || !isRecord(listing["baseListing"])) return [];
      const notes = storeNotes(release, language);
      const kept = listing["baseListing"]["releaseNotes"];
      return typeof kept === "string" && kept.replaceAll("\r\n", "\n") === notes
        ? []
        : [`listings.${language}.baseListing.releaseNotes`];
    }),
  ];
}

/**
 * What putting `release` in `submission` leaves alone: all of it but its packages, Microsoft's
 * status, status details and upload address, and each listing's "What's new" and, where the
 * package's name goes into it, title.
 */
function metadata(submission: Submission, release: CheckedRelease): Record<string, unknown> {
  const changing = ["applicationPackages", "status", "statusDetails", "fileUploadUrl"];
  const ours =
    release.package.displayName === STORE_NAME ? ["releaseNotes", "title"] : ["releaseNotes"];
  const without = (from: Record<string, unknown>, keys: readonly string[]) =>
    Object.entries(from).filter(([key]) => !keys.includes(key));
  return Object.fromEntries(
    without(submission.raw, changing).map(([key, value]) => [
      key,
      key === "listings"
        ? relisted(value, (base) => Object.fromEntries(without(base, ours)))
        : value,
    ]),
  );
}

/**
 * The fingerprint of `submission` for `release`: the SHA-256 of what the release leaves alone in
 * it. Two reads of an unchanged draft give the same one, and any other change another.
 */
function fingerprint(submission: Submission, release: CheckedRelease): string {
  return createHash("sha256")
    .update(canonical(metadata(submission, release)))
    .digest("hex");
}

/**
 * `value` as JSON with every object's fields in the order of their names, so the order Microsoft
 * sends fields in doesn't count. The order of a list does.
 */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, each: unknown) =>
    isRecord(each)
      ? Object.fromEntries(
          Object.keys(each)
            .sort()
            .map((key) => [key, each[key]]),
        )
      : each,
  );
}

/**
 * Where `before` and `after` differ, by the paths of the fields and never their values. A list
 * counts as one field.
 */
function differing(before: unknown, after: unknown, path = ""): string[] {
  if (!isRecord(before) || !isRecord(after)) {
    return canonical(before) === canonical(after) ? [] : [path];
  }
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap((key) => {
    const field = path ? `${path}.${key}` : key;
    return key in before && key in after ? differing(before[key], after[key], field) : [field];
  });
}

/** Fields for a message: how many, and the paths of the first ten. Never a value. */
function listed(paths: readonly string[], clean: Session["clean"]): string {
  const shown = paths.slice(0, 10).map(clean).join(", ");
  return `${paths.length} field(s)${shown ? `: ${shown}` : ""}${paths.length > 10 ? " and more" : ""}`;
}

/**
 * `listings` with each language's base listing, which holds its title, texts and images, as
 * `change` returns it. Whatever isn't such a listing stays as it is.
 */
function relisted(
  listings: unknown,
  change: (base: Record<string, unknown>, language: string) => Record<string, unknown>,
): unknown {
  if (!isRecord(listings)) return listings;
  return Object.fromEntries(
    Object.entries(listings).map(([language, listing]) => [
      language,
      isRecord(listing) && isRecord(listing["baseListing"])
        ? { ...listing, baseListing: change(listing["baseListing"], language) }
        : listing,
    ]),
  );
}

/**
 * Throws unless `submission` is for everyone and published as soon as it is certified. `then` says
 * what is left to do when it isn't.
 */
function assertPublic(submission: Submission, what: string, then = ""): void {
  if (submission.visibility === "Public" && submission.publishMode === "Immediate") return;
  throw new StoreError(
    `${what}, ${submission.id}, has the audience "${submission.visibility}" and the publishing mode "${submission.publishMode}". This automation only updates a Public listing that publishes as soon as it is certified (Immediate), and sets neither itself. Nothing was committed. ${then}`.trim(),
  );
}

/** A new submission: Microsoft's copy of the published one. */
async function create(session: Session): Promise<Submission> {
  const answer = await call(session, "POST", "/submissions");
  const created = answer && answer.status >= 200 && answer.status < 300;
  const draft = created ? submissionOf(answer.body, session.clean) : null;
  if (draft) {
    assertPublic(draft, "The new submission", leftover(draft.id));
    return draft;
  }
  const unclear =
    !answer || created || answer.status >= 500 || answer.status === 408 || answer.status === 429;
  if (!unclear) throw refusal("creating a submission", answer, session.clean);
  // The submission may exist all the same. A second request couldn't make another, since the
  // Store takes one at a time, but nothing would show that the one there is this run's.
  const { pendingId } = await storeApp(session);
  throw new StoreError(
    pendingId
      ? `Microsoft gave no clear answer to creating a submission, and submission ${pendingId} is in progress now. Nothing shows whether this run made it. Look at it in Partner Center: when it is an untouched copy nobody is working on, delete it there, then ${RECOVER}.`
      : `Microsoft gave no clear answer to creating a submission, and the app has none in progress. To try again, ${RECOVER}.`,
  );
}

/**
 * Puts `release` in the draft the run named, unless an earlier run did, and uploads its package.
 * The draft is read again after each, the second time right before `submit` commits it. Returns
 * the draft to commit, or what to report when someone committed it meanwhile. `again` says how to
 * repeat the run.
 */
async function adopt(
  session: Session,
  step: Extract<Step, { take: "adopt" }>,
  release: CheckedRelease,
  again: string,
): Promise<DraftStep> {
  let ready: DraftStep = step;
  if (step.lacking.length > 0) {
    const stopped = "Nothing was uploaded or committed.";
    await fill(session, step.draft, release, `${stopped} To try again, ${again}.`);
    ready = await reread(session, step, release, "After the update", stopped);
  }
  if (ready.take !== "adopt") return ready;
  await upload(session, ready.draft, release, again);
  return reread(session, step, release, "After the upload", "Nothing was committed.");
}

/**
 * Reads the draft of `step` again, `after` something was sent to it, and says what `submit` does
 * next: go on, or report a draft someone committed meanwhile. Throws when what the release leaves
 * alone is no longer what `step` found, when the draft fails a check it passed then, and when it
 * lacks the package, "What's new" or title. `stopped` says what the run then leaves undone.
 */
async function reread(
  session: Session,
  step: Extract<Step, { take: "adopt" }>,
  release: CheckedRelease,
  after: string,
  stopped: string,
): Promise<DraftStep> {
  const { id } = step.draft;
  const state = await storeState(session);
  const now = state.pending;
  // The fields that changed while it stayed a draft, by name. What else stops the run, `nextStep` says.
  const changed =
    now?.id === id && now.status === "PendingCommit"
      ? differing(metadata(step.draft, release), metadata(now, release))
      : [];
  if (changed.length > 0) {
    throw new StoreError(
      `${after}, something a release leaves alone in the draft ${id} differs from what the run found, in ${listed(changed, session.clean)}. ${stopped} ${CHANGED}`,
    );
  }
  const next = nextStep(state, release, step.named);
  if (next.take === "adopt" && next.lacking.length > 0) {
    throw new StoreError(
      `${after}, the draft ${id} lacks what the release puts in it, in ${listed(next.lacking, session.clean)}. ${stopped} Look at the draft in Partner Center.`,
    );
  }
  return next;
}

/**
 * Puts the package, "What's new" and, where `retitled` names a listing, the Store name into `draft`
 * and sends the rest back as it came. The other packages it holds are marked for removal: the
 * Store offers the newest one to everyone they served. A draft that lists the package keeps that
 * entry. `left` says what becomes of the draft when Microsoft refuses.
 */
async function fill(
  session: Session,
  draft: Submission,
  release: CheckedRelease,
  left = leftover(draft.id),
): Promise<Submission> {
  const { fileName } = release.package;
  const copied: unknown[] = Array.isArray(draft.raw["applicationPackages"])
    ? draft.raw["applicationPackages"]
    : [];
  const mine = (file: unknown) => isRecord(file) && file["fileName"] === fileName;
  const renamed = retitled(draft, release);
  const body = {
    ...draft.raw,
    applicationPackages: [
      ...copied.map((file) =>
        isRecord(file) && !mine(file) ? { ...file, fileStatus: "PendingDelete" } : file,
      ),
      // What Microsoft asks of a new package; the rest it reads from the file.
      ...(copied.some(mine)
        ? []
        : [
            {
              fileName,
              fileStatus: "PendingUpload",
              minimumDirectXVersion: "None",
              minimumSystemRam: "None",
            },
          ]),
    ],
    listings: relisted(draft.raw["listings"], (base, language) => ({
      ...base,
      releaseNotes: storeNotes(release, language),
      ...(renamed.includes(language) && { title: STORE_NAME }),
    })),
  };
  const answer = await call(session, "PUT", `/submissions/${draft.id}`, body);
  if (!answer || answer.status < 200 || answer.status >= 300) {
    const { message } = refusal(
      `adding the package to submission ${draft.id}`,
      answer,
      session.clean,
    );
    throw new StoreError(`${message} ${left}`);
  }
  const filled = submissionOf(answer.body, session.clean);
  if (!filled || !held(filled, (file) => file.fileName === fileName)) {
    throw new StoreError(`Microsoft took the update without listing ${fileName}. ${left}`);
  }
  return { ...filled, uploadUrl: filled.uploadUrl ?? draft.uploadUrl };
}

/**
 * Uploads the package, in the ZIP the API takes files in, to the address Microsoft gave for
 * `draft`. Sending a block or the list of blocks twice changes nothing, so each is repeated when
 * it fails. `again` says how to repeat the run.
 */
async function upload(
  session: Session,
  draft: Submission,
  release: CheckedRelease,
  again: string,
): Promise<void> {
  const url = draft.uploadUrl;
  if (!url || !/^https:\/\/[^/?#]+\/[^?#]*\?[^#]+$/.test(url)) {
    throw new StoreError(`Microsoft gave no upload address for submission ${draft.id}.`);
  }
  const file = readFileSync(release.package.path);
  if (createHash("sha256").update(file).digest("hex") !== release.package.sha256) {
    throw new StoreError("The package on disk is no longer the one that was checked.");
  }
  const archive = storedZip(release.package.fileName, file);
  const put = async (query: string, body: string | Uint8Array) => {
    const answer = await request(
      session.access,
      `${url}&${query}`,
      { method: "PUT", headers: {}, body },
      true,
    );
    if (answer && answer.status >= 200 && answer.status < 300) return;
    throw new StoreError(
      `Uploading the package for submission ${draft.id} ${answer ? `was refused with HTTP ${answer.status}` : "got no answer"}. The submission is a draft that holds ${release.package.fileName} by name: to upload and commit it, ${again}.`,
    );
  };
  const blocks: string[] = [];
  for (let start = 0; start < archive.length; start += BLOCK_BYTES) {
    const id = Buffer.from(`block-${String(blocks.length).padStart(6, "0")}`).toString("base64");
    blocks.push(id);
    await put(
      `comp=block&blockid=${encodeURIComponent(id)}`,
      archive.subarray(start, start + BLOCK_BYTES),
    );
  }
  const list = blocks.map((id) => `<Latest>${id}</Latest>`).join("");
  await put(
    "comp=blocklist",
    `<?xml version="1.0" encoding="utf-8"?><BlockList>${list}</BlockList>`,
  );
}

/**
 * Commits the draft `id` and waits, for ten minutes at most, until Microsoft has taken or refused
 * it. When the commit gets no clear answer, the submission's status says whether it went through.
 * `again` says how to repeat the run.
 */
async function commit(
  session: Session,
  id: string,
  again: string,
): Promise<Pick<Submission, "status" | "remarks">> {
  const answer = await call(session, "POST", `/submissions/${id}/commit`);
  const accepted = answer !== null && answer.status >= 200 && answer.status < 300;
  let current = await statusOf(session, id);
  if (!accepted && current.status === "PendingCommit") {
    const { message } = refusal(`committing submission ${id}`, answer, session.clean);
    throw new StoreError(
      `${message} It is still a draft that holds this release's package: to commit it, ${again}.`,
    );
  }
  const waiting = () =>
    current.status === "CommitStarted" || (accepted && current.status === "PendingCommit");
  for (let poll = 0; waiting() && poll < COMMIT_POLLS; poll++) {
    await session.access.wait(COMMIT_POLL_MS);
    current = await statusOf(session, id);
  }
  return current;
}

async function statusOf(
  session: Session,
  id: string,
): Promise<Pick<Submission, "status" | "remarks">> {
  const what = `reading the status of submission ${id}`;
  const answer = await call(session, "GET", `/submissions/${id}/status`);
  if (!answer || answer.status !== 200) throw refusal(what, answer, session.clean);
  const body = answer.body;
  if (!isRecord(body) || typeof body["status"] !== "string") {
    throw new StoreError(`Microsoft answered ${what} with nothing readable.`);
  }
  return { status: body["status"], remarks: remarksOf(body["statusDetails"], session.clean) };
}

/** The app's published submission and the one in progress, once the app is shown to be ours. */
async function storeState(session: Session): Promise<StoreState> {
  const { publishedId, pendingId } = await storeApp(session);
  const read = async (id: string) => {
    const what = `reading submission ${id}`;
    const answer = await call(session, "GET", `/submissions/${id}`);
    if (!answer || answer.status !== 200) throw refusal(what, answer, session.clean);
    const submission = submissionOf(answer.body, session.clean);
    if (!submission) throw new StoreError(`Microsoft answered ${what} with nothing readable.`);
    return submission;
  };
  return { published: await read(publishedId), pending: pendingId ? await read(pendingId) : null };
}

/** The IDs of the app's submissions. Throws unless the application ID is Mr. Streamer's package. */
async function storeApp(
  session: Session,
): Promise<{ readonly publishedId: string; readonly pendingId: string | null }> {
  const answer = await call(session, "GET", "");
  if (!answer || answer.status !== 200) throw refusal("reading the app", answer, session.clean);
  const app = isRecord(answer.body) ? answer.body : {};
  const { packageIdentityName: name, publisherName: publisher } = app;
  if (name !== STORE_APP.identityName || publisher !== STORE_APP.publisher) {
    throw new StoreError(
      `Application ${STORE_APP.id} isn't ${STORE_APP.identityName} by ${STORE_APP.publisher} in this account, so nothing is sent to it. Microsoft names it ${session.clean(String(name))} by ${session.clean(String(publisher))}.`,
    );
  }
  const idOf = (key: string) => {
    const named = app[key];
    return isRecord(named) && isId(named["id"]) ? named["id"] : null;
  };
  const publishedId = idOf("lastPublishedApplicationSubmission");
  if (!publishedId) {
    throw new StoreError(
      "The app has no published submission. The API copies the published one, so the first goes through Partner Center.",
    );
  }
  return { publishedId, pendingId: idOf("pendingApplicationSubmission") };
}

/** Whether `value` is a submission's ID, which goes into the address of later requests. */
function isId(value: unknown): value is string {
  return typeof value === "string" && /^[\w-]{1,64}$/.test(value);
}

/** The submission in one of Microsoft's answers, or null when this script can't read one there. */
function submissionOf(body: unknown, clean: Session["clean"]): Submission | null {
  if (!isRecord(body) || !isId(body["id"]) || typeof body["status"] !== "string") return null;
  const text = (from: Record<string, unknown>, key: string) => {
    const value = from[key];
    return typeof value === "string" ? value : "";
  };
  const packages = Array.isArray(body["applicationPackages"]) ? body["applicationPackages"] : [];
  return {
    id: body["id"],
    status: body["status"],
    visibility: text(body, "visibility"),
    publishMode: text(body, "targetPublishMode"),
    packages: packages.filter(isRecord).map((file) => ({
      fileName: text(file, "fileName"),
      fileStatus: text(file, "fileStatus"),
      version: text(file, "version"),
    })),
    uploadUrl: text(body, "fileUploadUrl") || null,
    remarks: remarksOf(body["statusDetails"], clean),
    raw: body,
  };
}

/** Microsoft's errors and warnings about a submission. Its reports are counted: they are links. */
function remarksOf(details: unknown, clean: Session["clean"]): string[] {
  if (!isRecord(details)) return [];
  const listed = (key: string, label: string) =>
    (Array.isArray(details[key]) ? details[key] : []).filter(isRecord).map((each) => {
      const parts = [each["code"], each["details"]].filter((part) => typeof part === "string");
      return `${label}: ${clean(parts.join(": "))}`;
    });
  const reports = Array.isArray(details["certificationReports"])
    ? details["certificationReports"].length
    : 0;
  return [
    ...listed("errors", "Error"),
    ...listed("warnings", "Warning"),
    ...(reports > 0 ? [`Partner Center holds ${reports} certification report(s).`] : []),
  ].slice(0, 20);
}

/** What a copy of `submission` would carry over, for a person to check against the listing. */
function listingFacts(submission: Submission, clean: Session["clean"]): string[] {
  const { listings, trailers, pricing } = submission.raw;
  const languages = Object.entries(isRecord(listings) ? listings : {}).map(
    ([language, listing]) => {
      const base =
        isRecord(listing) && isRecord(listing["baseListing"]) ? listing["baseListing"] : {};
      const images = Array.isArray(base["images"]) ? base["images"].length : 0;
      return `${clean(language)} with ${images} image(s)`;
    },
  );
  const price =
    isRecord(pricing) && typeof pricing["priceId"] === "string" ? pricing["priceId"] : "";
  return [
    `Listings: ${languages.join(", ") || "none"}. Trailers: ${Array.isArray(trailers) ? trailers.length : 0}.`,
    `Price: ${clean(price) || "unread"}.`,
  ];
}

/** Signs in as the application. The token lasts an hour, longer than any run of this script. */
async function signIn(access: StoreAccess): Promise<Session> {
  const id = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  if (!id.test(access.tenantId)) throw new StoreError("STORE_TENANT_ID is not a tenant ID.");
  if (!id.test(access.clientId)) throw new StoreError("STORE_CLIENT_ID is not a client ID.");
  const answer = await request(
    access,
    `${LOGIN}/${access.tenantId}/oauth2/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: access.clientId,
        client_secret: access.clientSecret,
        resource: API,
      }).toString(),
    },
    // Asking for a token twice changes nothing.
    true,
  );
  const body = answer && isRecord(answer.body) ? answer.body : {};
  const token = body["access_token"];
  if (answer?.status === 200 && typeof token === "string" && token) {
    return { access, token, clean: cleaner([access.clientSecret, token]) };
  }
  if (!answer) throw new StoreError("Microsoft Entra didn't answer the sign-in.");
  const error = typeof body["error"] === "string" ? body["error"] : "";
  const code = /AADSTS\d+/.exec(String(body["error_description"]))?.[0];
  const named = [/^\w{1,40}$/.test(error) ? error : `HTTP ${answer.status}`, code].filter(Boolean);
  throw new StoreError(
    `Microsoft Entra refused the sign-in (${named.join(", ")}). ${(code && SIGN_IN_HINTS[code]) ?? "Check the tenant ID, the client ID and the key in the microsoft-store environment."}`,
  );
}

/** What Entra's commonest refusals mean here. */
const SIGN_IN_HINTS: Record<string, string> = {
  AADSTS7000215:
    "The key is wrong. The secret must hold the key's value, which Partner Center shows once.",
  AADSTS7000222:
    "The key has ended. docs/maintainers/microsoft-store.md#renewing-the-key says how to make a new one.",
  AADSTS700016: "The tenant has no application with that client ID.",
  AADSTS90002: "There is no tenant with that ID.",
};

/** Calls the submission API for the app. GET and PUT are repeated when they fail, POST never. */
function call(
  session: Session,
  method: "GET" | "PUT" | "POST",
  path: string,
  body?: unknown,
): Promise<Answer | null> {
  return request(
    session.access,
    `${APP}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${session.token}`,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    },
    method !== "POST",
  );
}

/**
 * Sends a request and reads the answer. Null when none came. With `repeat`, it is sent again
 * after no answer or one that says to try later, up to three times in all.
 */
async function request(
  access: StoreAccess,
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string | Uint8Array;
  },
  repeat: boolean,
): Promise<Answer | null> {
  for (let attempt = 1; ; attempt++) {
    let answer: Answer | null = null;
    try {
      const response = await access.send(url, { ...init, signal: AbortSignal.timeout(REQUEST_MS) });
      const text = await response.text();
      const correlation = response.headers.get("MS-CorrelationId");
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      answer = {
        status: response.status,
        body,
        correlation: correlation && /^[\w-]{1,64}$/.test(correlation) ? correlation : null,
      };
    } catch {
      // No answer: the error could name the address, so it isn't kept.
    }
    const later = !answer || answer.status >= 500 || answer.status === 408 || answer.status === 429;
    if (!repeat || !later || attempt >= ATTEMPTS) return answer;
    await access.wait(attempt * 2000);
  }
}

/** What to say when Microsoft refused or didn't answer, with what its documented answers mean. */
function refusal(what: string, answer: Answer | null, clean: Session["clean"]): StoreError {
  if (!answer) return new StoreError(`Microsoft didn't answer ${what}.`);
  const hints: Record<number, string> = {
    401: "The sign-in was refused.",
    403: "The application lacks the Manager role in Partner Center.",
    404: "Microsoft finds no such app or submission in this account.",
    409: "The app's state doesn't allow it, or the app uses a Partner Center feature the API doesn't support.",
    429: "Microsoft asks for fewer requests.",
  };
  // Microsoft's own errors name a code and a message. Any other body stays unprinted.
  const { body } = answer;
  const said =
    isRecord(body) && typeof body["code"] === "string" && typeof body["message"] === "string"
      ? `Microsoft says: ${clean(`${body["code"]}: ${body["message"]}`)}`
      : "";
  const asked = answer.correlation ? `Request ${answer.correlation}.` : "";
  return new StoreError(
    [`Microsoft answered HTTP ${answer.status} to ${what}.`, hints[answer.status], said, asked]
      .filter(Boolean)
      .join(" "),
  );
}

/**
 * Makes text from Microsoft safe to print: without `secrets`, addresses, which can carry an upload
 * signature, and anything shaped like a token, on one line and no longer than 400 characters.
 */
function cleaner(secrets: readonly string[]): (text: string) => string {
  return (text) =>
    secrets
      .filter(Boolean)
      .reduce((cleaned, secret) => cleaned.replaceAll(secret, "[hidden]"), text)
      .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[address]")
      .replace(/\beyJ[\w-]{8,}\.[\w-]+\.[\w-]*/g, "[hidden]")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 400);
}

function summary(markdown: string): void {
  const file = process.env["GITHUB_STEP_SUMMARY"];
  if (file) appendFileSync(file, `${markdown}\n`);
}

/** What each stage means for the people waiting for the release. */
const VERDICTS: Record<Stage, string> = {
  live: "Live: Microsoft has published it.",
  "in-progress":
    "Not live yet: Microsoft is still checking or publishing it. Run the Publish workflow's store target with status to see how it ends.",
  draft: `Not submitted: the submission is a draft nobody committed. To commit it, ${RECOVER}, and with the draft and its fingerprint when a run named them.`,
  failed:
    "Not live: Microsoft refused or stopped the submission. Partner Center says why; docs/maintainers/microsoft-store.md#when-a-submission-fails says what to do.",
  absent: "The Store has no submission of this release.",
};

/** Prints an outcome, each part on its own line, and fails the run unless the stage is in `fine`. */
function report(outcome: Outcome, fine: readonly Stage[]): void {
  const rows = [
    ["GitHub release", outcome.version],
    ["Commit", outcome.commit],
    [
      "Store package",
      `${outcome.packageVersion}${outcome.fileName ? `, ${outcome.fileName}` : ""}`,
    ],
    ["Submission", outcome.submissionId ?? "none"],
    ["Microsoft's status", outcome.status ?? "none"],
  ];
  const verdict = VERDICTS[outcome.stage];
  console.log([...rows.map((row) => row.join(": ")), ...outcome.remarks, verdict].join("\n"));
  summary(
    [
      `### Microsoft Store: ${outcome.version}`,
      "| | |",
      "| --- | --- |",
      ...rows.map(([name, value]) => `| ${name} | \`${value}\` |`),
      "",
      verdict,
      ...outcome.remarks.map((remark) => `- ${remark}`),
    ].join("\n"),
  );
  const output = process.env["GITHUB_OUTPUT"];
  if (output) {
    appendFileSync(
      output,
      `submission-id=${outcome.submissionId ?? ""}\nstatus=${outcome.status ?? ""}\nstage=${outcome.stage}\n`,
    );
  }
  if (!fine.includes(outcome.stage)) throw new StoreError([verdict, ...outcome.remarks].join(" "));
  console.log(`::notice::Microsoft Store, ${outcome.version}: ${verdict}`);
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      release: { type: "string" },
      draft: { type: "string" },
      "draft-metadata-sha256": { type: "string" },
    },
  });
  const [command] = positionals;
  const env = process.env;
  const lacking = [
    ["the variable STORE_TENANT_ID", env["STORE_TENANT_ID"]],
    ["the variable STORE_CLIENT_ID", env["STORE_CLIENT_ID"]],
    ["the secret STORE_CLIENT_SECRET", env["STORE_CLIENT_SECRET"]],
  ].flatMap(([name, value]) => (value ? [] : [name]));
  if (lacking.length > 0) {
    throw new StoreError(
      `The ${STORE_ENVIRONMENT} environment lacks ${lacking.join(", ")}. scripts/setup-microsoft-store.sh stores them.`,
    );
  }
  const access: StoreAccess = {
    tenantId: env["STORE_TENANT_ID"] ?? "",
    clientId: env["STORE_CLIENT_ID"] ?? "",
    clientSecret: env["STORE_CLIENT_SECRET"] ?? "",
    send: (url, request) => fetch(url, request),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  const expiry = keyExpiry(env["STORE_CLIENT_SECRET_EXPIRES"], Date.now());
  if (expiry) console.log(`::warning::${expiry}`);
  const release = values.release ? readStoreRelease(values.release) : null;
  const unnamed = "Enter the version of a published stable release, such as 0.0.5.";
  /** The release with its checked package, which sending needs. */
  const checked = (): CheckedRelease => {
    if (!release) throw new StoreError(unnamed);
    if (!release.package) throw new StoreError("The release's package wasn't checked first.");
    return { ...release, package: release.package };
  };
  const given = values["draft-metadata-sha256"];
  if (given !== undefined && !values.draft) {
    throw new StoreError("A fingerprint is a draft's: name the draft it was read from as well.");
  }
  /** The draft made in Partner Center that the run names, when it names one. */
  const draft: Draft | undefined = values.draft
    ? { id: values.draft, metadataSha256: given ?? null }
    : undefined;

  switch (command) {
    case "preflight": {
      const { found, problems } = await preflight(access, release ? checked() : null, draft);
      console.log(found.join("\n"));
      summary(
        [
          "### Microsoft Store: preflight",
          ...found.map((line) => `- ${line}`),
          ...problems.map((line) => `- **Stops a submission:** ${line}`),
          "",
          "Nothing was sent or changed.",
        ].join("\n"),
      );
      if (problems.length > 0) throw new StoreError(problems.join(" "));
      console.log(
        "::notice::The Store account and listing are ready. Nothing was sent or changed.",
      );
      return;
    }
    case "submit":
      report(await submit(access, checked(), draft), ["live", "in-progress"]);
      return;
    case "status":
      if (!release) throw new StoreError(unnamed);
      if (draft) throw new StoreError("status takes no draft: it finds a release by its package.");
      report(await status(access, release), ["live", "in-progress"]);
      return;
    default:
      throw new StoreError(`Unknown command "${command}". Use preflight, submit or status.`);
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    // This script's own messages hold nothing secret. Any other is cleaned like Microsoft's text.
    const message = error instanceof Error ? error.message : String(error);
    const clean = cleaner([process.env["STORE_CLIENT_SECRET"] ?? ""]);
    console.log(`::error::${error instanceof StoreError ? message : clean(message)}`);
    process.exit(1);
  });
}
