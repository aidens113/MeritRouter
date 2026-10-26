import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { composeMountPathAllowed } from "./compose-mount-policy.js";
import YAML from "yaml";
import { z } from "zod";

const Name = z.string().regex(/^[a-z][a-z0-9-]{0,40}$/);
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const Image = z.string().min(1).max(300).regex(/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/);
const Absolute = z.string().min(1).max(8192).refine(v => path.isAbsolute(v) && !v.includes("\0") && !v.startsWith("\\\\") && !v.startsWith("//"), "Absolute local path required");
const ContainerPath = z.string().min(2).max(8192).regex(/^\/(?!\/)/).refine(v => !v.split("/").includes("..") && !v.includes("\\"), "Invalid container path");
const Env = z.record(z.string().max(200).regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(65536))
  .refine(value => Object.keys(value).length <= 100, "At most 100 environment entries per service");
const Port = z.number().int().min(1024).max(65535);
const Mount = z.object({ source: Absolute, target: ContainerPath, readOnly: z.boolean() }).strict();
export const ComposeAuthoritySchema = z.object({
  labRoot: Absolute, worktree: Absolute, dataRoots: z.array(Absolute).max(32),
  manifest: Absolute, manifestSha256: Sha, projectName: z.string().regex(/^sy-[a-z0-9-]{1,60}$/),
  services: z.record(Name, z.object({ image: Image, environment: Env.default({}),
    ports: z.array(z.object({ published: Port, target: z.number().int().min(1).max(65535) }).strict()).max(32).default([]),
    mounts: z.array(Mount).max(100).default([]),
  }).strict()).refine(v => Object.keys(v).length > 0 && Object.keys(v).length <= 100),
}).strict().refine(value => Buffer.byteLength(JSON.stringify(value)) <= 1024 * 1024, "Compose authority exceeds aggregate size bound");
export type ComposeAuthority = z.infer<typeof ComposeAuthoritySchema>;

const Bind = z.object({ type: z.literal("bind"), source: Absolute, target: ContainerPath, read_only: z.boolean().default(false),
  bind: z.object({ create_host_path: z.literal(false) }).strict().optional(),
}).strict();
const Published = z.object({ host_ip: z.literal("127.0.0.1"), target: z.number().int().min(1).max(65535),
  published: z.union([z.string().regex(/^[0-9]+$/), Port]).transform(Number).pipe(Port),
  protocol: z.literal("tcp").default("tcp"), mode: z.literal("ingress").optional(),
}).strict();
const Service = z.object({
  image: Image, command: z.array(z.string().max(16000)).max(100).optional(), entrypoint: z.array(z.string().max(16000)).max(100).optional(),
  environment: Env.default({}), user: z.string().min(1).max(200).optional(), working_dir: ContainerPath.optional(),
  read_only: z.literal(true), cap_drop: z.tuple([z.literal("ALL")]), security_opt: z.tuple([z.literal("no-new-privileges:true")]),
  restart: z.literal("no"), ports: z.array(Published).max(32).default([]), volumes: z.array(Bind).max(100).default([]),
  networks: z.object({ default: z.null() }).strict(),
}).strict();
const Network = z.object({ name: z.string().max(200).optional(), driver: z.literal("bridge").optional() }).strict();
export const ComposeCanonicalSchema = z.object({ name: z.string().max(100), services: z.record(Name, Service),
  networks: z.object({ default: Network }).strict(),
}).strict();
export const ComposeCapabilitiesSchema = z.object({
  trustedLocalEngine: z.literal(true), osType: z.literal("linux"), engineIdentity: z.string().min(1).max(200),
  composeConfigJson: z.literal(true), imageInspectJson: z.literal(true),
  endpoint: z.string().max(8192).refine(v => !v.includes("\0") && (/^unix:\/\/\/[^/]/.test(v) || /^npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9_.-]+$/.test(v)), "Only local engine endpoints supported"),
}).strict();

/** No traversal, sibling-prefix, symlink or junction may establish managed path ownership. */
export function composeOwnedPath(root: string, value: string) {
  const base = path.resolve(root), target = path.resolve(value), rel = path.relative(base, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("compose_path_denied");
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    if (!existsSync(current) || lstatSync(current).isSymbolicLink()) throw new Error("compose_path_denied");
  }
  const realBase = realpathSync(base), realTarget = realpathSync(target), realRel = path.relative(realBase, realTarget);
  if (realRel.startsWith("..") || path.isAbsolute(realRel)) throw new Error("compose_path_denied");
  return realTarget;
}
export const composeHash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, stable(v)]));
  return value;
}
export const composeCanonicalHash = (value: unknown) => composeHash(JSON.stringify(stable(value)));

/** Refuse imports and unsupported constructs before Compose can read referenced host files. */
export function validateComposeAuthored(text: string) {
  if (Buffer.byteLength(text) > 1024 * 1024 || /\$/.test(text)) throw new Error("compose_manifest_unsupported");
  const raw = z.object({ name: z.string().optional(), services: z.record(Name, z.unknown()), networks: z.unknown().optional() }).strict().parse(YAML.parse(text, { maxAliasCount: 0 }));
  // The same closed schema is used before and after normalization. No includes, env_file,
  // build, extends or arbitrary engine features can be consulted by the CLI.
  ComposeCanonicalSchema.parse({ ...raw, name: raw.name ?? "pending" });
}

export function validateComposeCanonical(raw: unknown, authorityInput: unknown) {
  const authority = ComposeAuthoritySchema.parse(authorityInput);
  const doc = ComposeCanonicalSchema.parse(raw);
  if (doc.name !== authority.projectName || Object.keys(doc.services).sort().join("\0") !== Object.keys(authority.services).sort().join("\0")) throw new Error("compose_authority_mismatch");
  if (doc.networks.default.name && doc.networks.default.name !== `${authority.projectName}_default`) throw new Error("compose_network_denied");
  const reserved = new Set<number>();
  for (const [name, service] of Object.entries(doc.services)) {
    const approved = authority.services[name]!;
    if (service.image !== approved.image || composeCanonicalHash(service.environment) !== composeCanonicalHash(approved.environment)) throw new Error("compose_authority_mismatch");
    const ports = service.ports.map(p => ({ published: p.published, target: p.target }));
    if (composeCanonicalHash(ports) !== composeCanonicalHash(approved.ports)) throw new Error("compose_ports_denied");
    for (const port of ports) { if (reserved.has(port.published)) throw new Error("compose_ports_denied"); reserved.add(port.published); }
    const mounts = service.volumes.map(m => ({ source: m.source, target: m.target, readOnly: m.read_only }));
    if (composeCanonicalHash(mounts) !== composeCanonicalHash(approved.mounts)) throw new Error("compose_mount_denied");
    for (const mount of mounts) {
      if (!composeMountPathAllowed(authority, mount.source, mount.target) || path.resolve(mount.source) === path.resolve(authority.worktree)) throw new Error("compose_mount_denied");
      const permitted = [authority.worktree, ...authority.dataRoots].some(root => {
        try { composeOwnedPath(root, mount.source); return true; } catch { return false; }
      });
      if (!permitted || mount.source === authority.labRoot) throw new Error("compose_mount_denied");
    }
  }
  return doc;
}

/** Safe plan metadata only. Private manifests/environment never cross this result. */
export const ComposeValidationPlanSchema = z.object({ version: z.literal(1), projectName: z.string(), engineIdentity: z.string(),
  manifestSha256: Sha, canonicalSha256: Sha,
  services: z.array(z.object({ name: Name, image: Image, publishedPorts: z.array(Port), mountCount: z.number().int().min(0).max(100) }).strict()).max(100),
  runtimeEnabled: z.literal(false),
}).strict();
