/**
 * The other names a list entry goes by, for `TrackerLibraryEntry.altTitles`: every candidate that
 * is present, non-blank, not the chosen title, and not already listed — in the order given, so a
 * tracker decides which name is tried first.
 */
export function otherNames(title: string, candidates: Array<string | null | undefined>): string[] {
  const seen = new Set([title]);
  const out: string[] = [];
  for (const raw of candidates) {
    const name = raw?.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
