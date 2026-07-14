/**
 * Title-matching key: lowercase, letters and digits only (strips ™, spaces,
 * punctuation, case). Mirrors the backend's GameWriter.Normalize so frontend
 * matching (e.g. "already in the other library" badges) agrees with how the
 * backend merges games.
 */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}
