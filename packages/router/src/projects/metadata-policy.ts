/** Reserved private runtime metadata, including legacy casing, at any repository depth. */
export function isProjectMetadataPath(input: string): boolean {
  return input.replace(/\\/g, "/").split("/")
    .some(segment => segment.replace(/[. ]+$/, "").toLowerCase() === ".meritrouter");
}

export function assertNotProjectMetadataPath(input: string): void {
  if (isProjectMetadataPath(input)) throw new Error("Private MeritRouter metadata is not accessible through repository tools");
}

/** Git excludes prevent private matches consuming search buffers before output filtering. */
export const PROJECT_METADATA_SEARCH_EXCLUDES = [
  ":(icase,exclude,glob)**/.MeritRouter",
  ":(icase,exclude,glob)**/.MeritRouter/**",
] as const;
