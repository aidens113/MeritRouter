/**
 * Slugifies a title. Named `legacySlugify` deliberately: the fixture's "mechanical rename" task
 * asks for it to be renamed to `slugify` everywhere (this file and its test).
 */
export function legacySlugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
