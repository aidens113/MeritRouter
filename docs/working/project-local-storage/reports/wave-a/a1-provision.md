# A1 project store provisioning (wave A)

Worker: a1-provision (worker-heavy). Date: 2026-10-27.

## Outcome

Done. `packages/router/src/projects/store-provision.ts` and
`packages/router/tests/project-store-provision.test.ts` are new. The test file passes (20/20).
Router `tsc --noEmit` shows one error, in a file outside my ownership.

## Interface (the stable shape is unchanged, with two optional additions)

```ts
export interface ProvisionProjectStoreInput { slug: string; projectDirectory: string; installationRoots: readonly string[]; now?: number }
export interface ProvisionedProjectStore { identity: ProjectStoreIdentity; registration: ProjectStoreRegistration; paths: ProjectRuntimePaths; adopted: boolean }
export async function provisionProjectStore(coordinationDb: Db, input: ProvisionProjectStoreInput, options?: ProjectStoreProvisionOptions): Promise<ProvisionedProjectStore>
// Addendum for A3: everything except registration
export interface PreparedProjectStore { identity: ProjectStoreIdentity; paths: ProjectRuntimePaths; adopted: boolean }
export async function prepareProjectStore(coordinationDb: Db, input: ProvisionProjectStoreInput, identity?: ProjectStoreIdentity, options?: ProjectStoreProvisionOptions): Promise<PreparedProjectStore>
export type ProjectStoreProvisionStep = "validated"|"excluded"|"directory"|"database"|"identity"|"manifest"|"closed"|"registered";
export interface ProjectStoreProvisionOptions { afterStep?: (step: ProjectStoreProvisionStep) => void | Promise<void> }
```

- The optional third parameter `options` is a test seam for crash injection. Existing callers are unaffected.
- `prepareProjectStore` returns `adopted` in addition to the `{identity, paths}` the addendum
  asked for.
- `adopted` is true only when a local store that was already bound with an identity is reused.
  A crash before role binding leaves nothing to adopt, so the re-run gives `adopted: false`.

## Design

Steps run in this order:

1. **Validate input.** zod, strict. The slug must match `PROJECT_SLUG_RE`. `installationRoots` must hold 1 to 64 absolute paths.
2. **Check the coordination store.** It must be bound with role `coordination` and run at `synchronous=FULL`.
3. **Refuse overlap with the installation.** The project directory is refused if it lies inside a `.meritrouter` path segment (any case), or if it is equal to, inside, or contains any installation root. Both resolved and realpath spellings are compared, case-insensitively on win32.
4. **Require the real path.** `realpath(projectDirectory)` must equal the input path, which `openRegistered` also requires.
5. **Check the runtime location.** Run `projectRuntimePaths` and `validateRuntimeLocation(paths.state)`.
6. **Inspect the local store read-only.** Only `better-sqlite3` with `readonly` is used here, so nothing is migrated or rebound. There are three outcomes:
   - **Absent:** a leftover `-wal` or `-journal` without a database is refused.
   - **Unbound:** accepted only if no table holds a row (FTS shadow tables are ignored).
   - **Bound:** must be role `project`, the same installation, the same slug, and must equal any supplied identity.
7. **Check `project.json`.** If present, it must be a v2 manifest with the same `projectId`. A manifest without a bound store is refused.
8. **Check registrations against the chosen identity.**
   - The identity's own row must not be retired, and its slug, directory, store and generation must match.
   - Any other live (registered or migrating) row with the same slug or the same directory is refused.
9. **Add the Git exclude before creating any file.** If the directory is in a Git work tree, `ensureProjectMetadataExcluded(<toplevel>)` runs. A `.git` entry that Git cannot read is refused.
10. **Create the directory.** `mkdir .MeritRouter/state`, then re-run `validateRuntimeLocation`.
11. **Open and bind the store.** Open with `durability: "full"`; a bound store is opened with `fileMustExist` and `expectedIdentity`. Then run `initializeStoreRole(db, identity)`.
12. **Write the manifest only if absent.** It is written atomically: temp file plus fsync, then rename. An existing manifest with jobs is never overwritten.
13. **Close the database** (in a `finally`).
14. **`provisionProjectStore` only: register.** One `immediate` transaction on the coordination DB re-checks conflicts, then calls `registerProjectStore` (nested as a savepoint). If the registration already exists and matches, it is returned as is. A self row in `migrating` state is refused.

Two orphan stores are refused rather than adopted:

- A store left behind by a retired registration. The error says to remove `.MeritRouter` first.
- A store from another installation.

A registered project whose local database is missing is also refused. No new identity is minted for it.

## Crash matrix

A crash is injected after each step (the hook throws), then provisioning is re-run with no hook. Every case ends with exactly one registration whose `projectId` equals the local identity, a matching manifest, and a successful `openRegistered`.

| Crash after | On disk | Re-run |
| --- | --- | --- |
| validated | nothing | fresh, adopted=false |
| excluded | Git exclude only | fresh, adopted=false |
| directory | `.MeritRouter/state` | fresh, adopted=false |
| database | migrated DB with no identity | binds a new identity (the DB is empty), adopted=false |
| identity | bound DB, no manifest | adopts it and writes the manifest, adopted=true |
| manifest / closed | bound DB and manifest | adopts it, adopted=true |
| registered | complete | returns the existing registration (idempotent), adopted=true |

## Commands run and observed results

- `cd D:/MeritRouter/packages/router && npx vitest run tests/project-store-provision.test.ts`
  -> 1 file passed, 20 tests passed (36 s). The tests are:
  - 1 happy path plus `openRegistered`
  - 1 idempotent re-run
  - 8 crash-matrix cases
  - 2 Git exclude cases (repository root and a subdirectory; `git status --porcelain` empty)
  - 1 unbound or non-FULL coordination store
  - 1 installation-root overlap, covering equal, inside, contains, `.meritrouter`, `.MERITROUTER`, and two win32 case variants. An empty roots list is also refused.
  - 1 directory inside `.MeritRouter`
  - 1 slug re-created after retirement: a new UUID each time, and the retired store left in place is refused
  - 1 live slug or directory conflict, plus a lost registered store not re-minted
  - 1 orphan from another installation, an unbound database with data, and a stray manifest
  - 1 manifest naming another project
  - 1 `prepareProjectStore` with a chosen generation-2 identity: no registration, then adopt, then refusal of another generation or installation
- `npx tsc --noEmit` -> one error, outside my files:
  `tests/brain-commit-performance.test.ts(62,80): TS2345 ... Property 'task' is missing ... 'GrantContext'`.
  My files produce no errors.

## Not verified

- POSIX behaviour. Everything ran on win32 only; on POSIX the comparisons are case-sensitive.
- Concurrent provisioning from two processes. I reasoned about it but did not test it. A second binder fails in `initializeStoreRole`, and the live-slug unique index plus the in-transaction re-check stop a double registration. The loser of a same-slug race in a different directory leaves an unregistered bound store there, which a later run adopts if the slug is still free.
- Short-name (8.3) project paths. These are refused by the real-path check, but I did not test it.
- The full router suite. I did not run it.

## Open questions or contradictions

- I changed the brief's step order: the Git exclude runs before `mkdir`, so private files never appear untracked, even briefly. All other steps keep the brief's order.
- The A1 refusal treats an unbound database holding any row as foreign. If A3 ever wants to pre-fill a store before binding it, it must bind first: call `prepareProjectStore` with its identity, then import.
- `prepareProjectStore` refuses an identity whose registration is retired, and refuses when another live project owns the slug or directory. A3 should either write its `migrating` row only after `prepare`, or reuse the same `projectId` in that row, which `prepare` treats as its own.
- Callers (B1/B2) must pass both the config directory and the storage directory in `installationRoots`. An empty list is rejected.
