import data from "./licences.json";

// What Settings' Licences shows, offline: the app and every component the build carries, each
// with its licence, where its source is and the full text of its notices. scripts/licences.ts
// generates licences.json from the release bundle, the native modules Expo links and
// licences/manifest.json; nothing here is fetched.

/** A label and a value to show above a component's notices: "Version", "4.29.0". */
export interface Fact {
  readonly label: string;
  readonly value: string;
}

/** One of a component's notice texts, titled by the file it is: "LICENSE", "vendor/x/LICENSE". */
export interface Notice {
  readonly title: string;
  /** The key of its text in `Licences.texts`, which holds each distinct text once. */
  readonly text: string;
}

/** The app itself, an npm package or a native library, and what it carries. */
export interface Component {
  /** `name@version`, or the app's own id. */
  readonly id: string;
  readonly name: string;
  readonly licence: string;
  /** Where its exact source is: the npm archive, a tag or the app's repository. */
  readonly source: string;
  readonly facts: readonly Fact[];
  readonly notices: readonly Notice[];
}

export interface Licences {
  /** The app first, then the components by name. */
  readonly components: readonly Component[];
  readonly texts: Readonly<Record<string, string>>;
}

export const licences: Licences = data;

/** The component `id` names, if this build has it. */
export const licenceOf = (id: string): Component | undefined =>
  licences.components.find((each) => each.id === id);

/** A notice's text, from the build's texts. */
export const noticeText = (notice: Notice): string => licences.texts[notice.text] ?? "";
