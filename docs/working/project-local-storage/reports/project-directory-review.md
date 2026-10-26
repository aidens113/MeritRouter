# Independent project-directory configuration review

Worker: runtime_path_contract (reviewed another worker's configuration implementation)
Date: 2026-10-26
Scope: projects/schema.ts, resolve.ts, context.ts, registry.ts and project-directory.test.ts.

## Conclusion

No blocking defect found for the explicitly bounded **metadata-only foundation**. This is
not approval to activate project-local storage or migrate existing data.

## Inspected contracts

- `directory` is an optional modern projects-map setting; the resolver returns an absolute
  lexical owner against configuration location. Inference uses one distinct repository
  location rather than inventing a multi-repository common ancestor.
- Legacy ambiguous roots remain null; inferred-only overlaps remain compatible. Explicit
  ownership overlaps with another known owner produce configuration issues.
- Existing `ctx.project` shape is unchanged; `projectDirectory` is a separate overlay field.
- Refresh deletes/repopulates overlays in place, so existing context references see the new
  metadata while retaining identity. Qualification ownership is explicitly reset to null.
- Neither storageDir nor store construction changes, and no root/path creation occurs.

## Activation limitations (must become acceptance requirements)

1. Directory changes currently hot-refresh metadata. Once the owner controls actual state,
   reject such changes without quiescent migration; never let old components and new
   components operate against different project roots.
2. Overlap checks are lexical and skip null owners. Symlink aliases, Windows ambiguous
   path components, unresolved multi-repository owners and inferred-only overlaps must
   pass the separate strict activation/ownership preflight before any filesystem writes.
3. No explicit owner setting exists in legacy top-level config; modern projects-map entries
   are necessary for an explicit ambiguous multi-repository owner under this bounded change.
4. Configuration trimming changes leading/trailing whitespace in explicit directory input.
   This is not safe to treat as physical path identity across platforms; activation should
   validate a canonical exact directory and fail rather than silently adopt a different root.
5. `ResolvedProject.directory` and `ProjectContext.projectDirectory` are required TypeScript
   fields. Package-wide typecheck is required to catch handwritten fixtures or external-facing
   construction sites; this focused review does not replace the supervisor's combined check.

## Independent verification

`pnpm exec vitest run tests/project-directory.test.ts tests/projects.test.ts --maxWorkers=1`
->23/23 tests pass in2files, exit0,9.43s. Executed against current source using fixture data.

No source, configuration, live data, commits or shared working documents changed by review.
