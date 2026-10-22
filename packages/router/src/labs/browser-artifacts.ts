import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, fstatSync, readSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { newId } from "../storage/db.js";
import type { LabRecord } from "./store.js";
import { labOwnedPath } from "./paths.js";
import { BrowserArtifactSchema } from "./browser-schema.js";
export function browserCheckDirectory(lab: LabRecord, checkId: string): string {
  z.string().max(100).regex(/^lc_[a-z0-9]+$/).parse(checkId);
  return labOwnedPath(path.resolve(lab.root, "../../.."), path.join(lab.root, "checks", checkId));
}
export function writeBrowserScreenshot(lab: LabRecord, checkId: string, bytes: Buffer, maximum: number) {
  if (bytes.length > maximum || bytes.length < 8 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
    throw new Error("browser screenshot is invalid or exceeded its byte limit");
  const id = newId("lba");
  const directory = browserCheckDirectory(lab, checkId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, `${id}.png`), bytes, { flag: "wx", mode: 0o600 });
  return BrowserArtifactSchema.parse({ id, mediaType: "image/png", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
export function readBrowserScreenshot(lab: LabRecord, checkId: string, metadata: z.infer<typeof BrowserArtifactSchema>): Buffer {
  const artifact = BrowserArtifactSchema.parse(metadata);
  const file = labOwnedPath(path.resolve(lab.root, "../../.."), path.join(browserCheckDirectory(lab, checkId), `${artifact.id}.png`));
  if (!existsSync(file))
    throw new Error("browser artifact is unavailable");
  const fd = openSync(file, "r");
  let bytes: Buffer;
  try {
    const size = fstatSync(fd).size;
    if (size !== artifact.bytes || size > 4194304)
      throw new Error("browser artifact size is invalid");
    bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, bytes, offset, size - offset, offset);
      if (!count)
        break;
      offset += count;
    }
    if (offset !== size || readSync(fd, Buffer.alloc(1), 0, 1, size) !== 0)
      throw new Error("browser artifact changed while reading");
  }
  finally {
    closeSync(fd);
  }
  if (bytes.length !== artifact.bytes || bytes.length > 4194304 || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256)
    throw new Error("browser artifact integrity check failed");
  return bytes;
}
