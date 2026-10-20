import { create } from "zustand";

/** A standing playback note, dismissible when it reports a failure. */
interface Note {
  readonly text: string;
  readonly failed: boolean;
}

export const useFlash = create<{ text: string | null; at: number; note: Note | null }>(() => ({
  text: null,
  at: 0,
  note: null,
}));

/** Shows a momentary change without replacing the standing note. */
export function flash(text: string): void {
  useFlash.setState({ text, at: Date.now() });
}

/** Player controllers can report failures without importing their React views. */
export function flashNote(note: string | null, failed = false): void {
  useFlash.setState({ note: note === null ? null : { text: note, failed } });
}
