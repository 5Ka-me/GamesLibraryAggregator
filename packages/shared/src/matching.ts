/**
 * Title-matching key: lowercase, letters and digits only (strips ™, spaces,
 * punctuation, case). The single definition of "same game" across the app —
 * the launcher merges its library with it, and the UI's cross-store badges
 * and filters compare with it, so they can never disagree.
 */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}
