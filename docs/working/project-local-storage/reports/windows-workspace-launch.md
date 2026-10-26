# Windows workspace launch path acceptance

Supervisor probe, 2026-10-26. Disposable temporary directories only, removed afterwards.
No source or live project data changed.

Current layout construction can produce a managed repository cwd longer than 260 characters
under an ordinary temporary root. A root with a shorter real project path may work, but this
is an activation concern beyond validating individual portable directory components.

Root ran the built runtimeWorkspacePath contract with readable job `Facebook MVP delivery`,
task `Profile implementation`, attempt1, repository app. First path length265: Node
execFileSync of git init failed ENOENT both with core.longpaths=false and true.
Control probe resolved the actual Git executable with where.exe and ran it successfully
from the short temp directory (`git version 2.55.0.windows.3`). Using that same absolute
executable from the generated267-character cwd failed ENOENT even with core.longpaths=true.
Thus merely passing the Git longpaths configuration did not solve process launch in this probe.

Required before activation: choose a compact persisted hierarchy/directory identity encoding,
validate supported Windows cwd length before creating managed directories, and test actual
process launch plus deep application file checkout/build. Keep collision-resistant ownership
and readable names; do not silently rename existing persisted identities. Current foundation
documents host path limitations and has no activated callers, so no live migration was attempted.
