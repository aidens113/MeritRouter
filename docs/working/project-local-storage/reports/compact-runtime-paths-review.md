# Independent compact runtime paths review

Reviewer: project_storage_discovery
Date: 2026-10-26
Tree: D:/SwitchYardRouter/.MeritRouter/development/compact-runtime-paths
Disposition: no blocking finding for the bounded, inactive path contract.
Changed: this isolated report only; no source, tests, main tree, live project state or commits.

## Reviewed behavior

Read the full runtime-paths.ts implementation, its diff against the isolated tree baseline,
all37 focused test cases and the implementation report. The module remains pure path/identity
construction plus separate read-only filesystem preflight. It neither opens project stores nor
creates or migrates runtime directories. Default identity creation remains legacy v1.

- **Exact v1 compatibility:** legacy identity remains untagged `{id,initialLabel,directoryName}`.
  First16 SHA256 bytes rendered as hex equal the prior digest.hex.slice(0,32); readable prefix
  normalization and32character truncation are unchanged. Legacy task/version hierarchy is
  byte-identical, including repository names and attempt padding. V1 manifest shape remains
  strict and unchanged. New launch preflight can refuse a too-long legacy path; legacy
  construction remains possible for locating retained data without silently relocating it.
- **Strict version agreement:** tagged v2 identities require layoutVersion2; manifest branches
  require exact matching identity schemas. Mixed v1/v2 job/subject and contradictory explicit
  workspace version refuse. Unknown versions/extra fields/tampered derived names refuse.
  V2 duplicate job/repository IDs and folded directory collisions refuse. Paths must be rebuilt
  from validated persisted identities, not a changed display label.
- **Full case-safe digest:** v2 uses26lowercase base32 characters encoding all128digest bits,
  with leading padding bits, not a shortened hexadecimal suffix. Independently decoded256
  generated IDs and recovered exactly the first128SHA256bits for each. Case-distinct IDs and
  repository aliases hash their original case, retaining distinct names after case folding.
- **Readable lengths:** job/task/version prefixes retain16normalized characters; compact
  repository prefixes retain12. Labels such as Facebook MVP remain recognizable. Full initial
  labels/aliases and stable IDs remain in validated manifest identities rather than being lost
  to directory shortening. Longer display names do not silently lengthen established paths.
- **Safety/compatibility:** existing explicit absolute owner path, Windows drive/UNC validation,
  device namespace rejection, traversal/reserved-name refusal, repository alias compatibility,
  metadata casing and existing link/file-ancestor preflight are retained. Version2 checks cwd
  support before a caller can create anything. Preflight is explicitly not race-free filesystem
  authorization and still requires revalidation/ownership receipts during actual mutations.

## Independent execution

From isolated packages/router:

```text
pnpm exec vitest run tests/project-runtime-paths.test.ts --maxWorkers=1
```

Observed exit0: **37/37PASS**, 1file,0.864s. Actual tests exercise Windows native process
launch, Git init/add/list with explicit long-path config, version compatibility and safety.

Separately loaded the actual source module with a temporary Vite SSR server and recreated the
maximal80character job/task labels and repository alias with attempt999999 under an ordinary
temporary owner. This was independent of the test's assertions. Observed on Windows:

```json
{"platform":"win32","cwdLength":232,"launched":"launched","deepFilenameLength":434,"tracked":true,"decodedDigests":256,"accepted240":true,"refused241":true}
```

Node launched from232character cwd. Git init/add/ls-files succeeded for a434character absolute
source filename using per-command `-c core.longpaths=true`. Separate exact-bound probes accepted
a240character valid absolute cwd and rejected241. Vite closed and the disposable directory
was removed in finally. No global Git configuration or user project was changed.

## Activation prerequisites and limits

- Git long-path policy is **not implemented by this module**. The successful deep-file probe
  explicitly supplies core.longpaths=true to init/add/ls-files. Caller-owned Git process policy
  and all relevant checkout/staging paths must supply it before activating this hierarchy.
-240 is a conservative native cwd support bound, not proof every compiler/runtime supports
  arbitrary deeper filenames. The probe proves Node process launch and Git staging, not a
  Next.js/application production build. Realistic project roots/deep generated files need
  activation acceptance. Overlong owner roots must fail with actionable guidance or undergo
  explicit migration; do not shorten already-persisted identities opportunistically.
- Module validation checks identity/version consistency, not whether arbitrary subject IDs
  really belong to a job or whether a repository alias is assigned to a task. Runtime consumers
  must enforce project/task/repository ownership and load the correct manifest.
- Current manifest persists jobs and repository identities but is not a complete task/version
  ownership database. No caller currently activates v2; migration, project-store separation,
  exact-source checks and transactional staging remain separate acceptance units.

No additional source correction requested for this bounded contract. Supervisor still owns
integration, package/full checks, documentation and publication.
