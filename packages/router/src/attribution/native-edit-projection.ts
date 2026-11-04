import { createHash } from "node:crypto";
import { z } from "zod";

/** Pure native edit semantics. Filesystem, scope, authority and journaling stay with callers. */
export function projectNativeWrite(previous: string | null, content: string): string {
  const lf = content.replace(/\r\n/g, "\n");
  return previous?.includes("\r\n") ? lf.replace(/\n/g, "\r\n") : lf;
}

export function projectNativeReplace(previous: string, oldText: string, newText: string, replaceAll: boolean): { content: string; count: number } {
  if (!oldText) throw new Error("old_text is required");
  const crlf = previous.includes("\r\n"), text = crlf ? previous.replace(/\r\n/g, "\n") : previous;
  const old = oldText.replace(/\r\n/g, "\n"), replacement = newText.replace(/\r\n/g, "\n");
  const count = text.split(old).length - 1;
  if (!count) throw new Error("old_text not found; read the file again and copy the exact text");
  if (count > 1 && !replaceAll) throw new Error(`old_text matches ${count} times; add surrounding context or set replace_all`);
  const next = replaceAll ? text.split(old).join(replacement) : text.replace(old, () => replacement);
  return { content: crlf ? next.replace(/\n/g, "\r\n") : next, count: replaceAll ? count : 1 };
}

const pathValue = z.string().min(1).max(4096);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const LineReplacementSchema = z.object({
  start_line: z.number().int().positive().max(1000000),
  end_line: z.number().int().positive().max(1000000),
  new_lines: z.array(z.string().regex(/^[^\r\n]*$/, "Each new_lines entry must be one line without CR or LF")).max(1000000),
});
export const LineReplacementsSchema = z.array(LineReplacementSchema).min(1).max(64);

/** Inclusive original line records, matching read_file/read_files numbering.
 * A final newline creates a final empty record. [] deletes selected records;
 * [""] inserts one blank record. All ranges address the same pre-edit content.
 */
export function projectNativeReplaceLines(previous: string, input: unknown): string {
  const replacements = LineReplacementsSchema.parse(input);
  let lines = previous.replace(/\r\n/g, "\n").split("\n");
  let end = 0;
  for (const replacement of replacements) {
    if (replacement.start_line > replacement.end_line || replacement.end_line > lines.length)
      throw new Error(`Line range ${replacement.start_line}-${replacement.end_line} is outside 1-${lines.length}`);
    if (replacement.start_line <= end)
      throw new Error("Line ranges must be ascending and nonoverlapping in original-file coordinates");
    end = replacement.end_line;
  }
  for (const replacement of replacements.slice().reverse())
    lines = lines.slice(0, replacement.start_line - 1).concat(replacement.new_lines, lines.slice(replacement.end_line));
  return projectNativeWrite(previous, lines.join("\n"));
}
export const NativeRecipeEditSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), path: pathValue, content: z.string() }),
  z.object({ action: z.literal("replace"), path: pathValue, content: z.string(), expected_sha256: hash, whole_file: z.literal(true) }),
  z.object({ action: z.literal("patch"), path: pathValue, old_text: z.string().min(1), new_text: z.string(), expected_sha256: hash, replace_all: z.boolean().default(false) }),
  z.object({ action: z.literal("replace_lines"), path: pathValue, expected_sha256: hash, replacements: LineReplacementsSchema }),
  z.object({ action: z.literal("delete"), path: pathValue, expected_sha256: hash }),
]);
export const NativeRecipeSchema = z.object({ edits: z.array(NativeRecipeEditSchema).min(1).max(64) });
export type NativeRecipeEdit = z.infer<typeof NativeRecipeEditSchema>;
export type NativeProjectionOperation = { name: "write_file" | "replace_in_file" | "replace_lines" | "delete_file"; args: Record<string, unknown>; expected?: NativeRecipeEdit };

/**
 * The file argument of an edit tool. Models also send it as `file_path`, `filename`, or `file`
 * (live: a 2197-token write_file without `path` was refused and lost); a call with none is refused
 * with what is needed, saying that nothing was written.
 */
export function nativeEditPathArgument(a: Record<string, unknown>, toolName: string): string {
  const values = ["path", "file_path", "filename", "file"].map(key => a[key]).filter((value): value is string => typeof value === "string" && !!value.trim());
  if (new Set(values.map(value => value.replace(/\\/g, "/"))).size > 1) throw new Error(`${toolName} received conflicting path fields; provide exactly one path. Nothing was written.`);
  if (values.length) return values[0]!;
  throw new Error(`${toolName} needs path: the file, relative to the repository root (for example "src/posts.js"). Nothing was written; call ${toolName} again with path.`);
}

export function nativeOperationPath(operation: NativeProjectionOperation): string {
  return pathValue.parse(nativeEditPathArgument(operation.args, operation.name));
}

/** Include only newline transformations the native implementation and Git text normalization make. */
export function nativeTextRepresentations(content: string): string[] {
  const lf = content.replace(/\r\n/g, "\n");
  return [...new Set([content, lf, lf.replace(/\n/g, "\r\n")])];
}

export function preflightNativeRecipe(edit: NativeRecipeEdit, previous: string | null): void {
  if (edit.action === "create") { if (previous !== null) throw new Error(`${edit.path} already exists`); return; }
  if (previous === null) throw new Error(`${edit.path} does not exist`);
  if (!nativeTextRepresentations(previous).some(raw => createHash("sha256").update(raw).digest("hex") === edit.expected_sha256))
    throw new Error(`${edit.path} revision conflict`);
  if (edit.action === "patch") projectNativeReplace(previous, edit.old_text, edit.new_text, edit.replace_all);
  if (edit.action === "replace_lines") projectNativeReplaceLines(previous, edit.replacements);
  if (edit.action === "replace" && /(?:rest|remaining|existing)\s+(?:of\s+\w+\s+)?unchanged|\.\.\.\s*(?:rest|existing)/i.test(edit.content))
    throw new Error(`${edit.path}: omission placeholder detected`);
}

export function nativeRecipeOperation(edit: NativeRecipeEdit): NativeProjectionOperation {
  return edit.action === "replace_lines" ? { name: "replace_lines", args: { path: edit.path, replacements: edit.replacements }, expected: edit }
    : edit.action === "patch" ? { name: "replace_in_file", args: { path: edit.path, old_text: edit.old_text, new_text: edit.new_text, replace_all: edit.replace_all }, expected: edit }
    : edit.action === "delete" ? { name: "delete_file", args: { path: edit.path }, expected: edit }
    : { name: "write_file", args: { path: edit.path, content: edit.content }, expected: edit };
}

export function projectNativeOperation(previous: string | null, operation: NativeProjectionOperation): string | null {
  if (operation.expected) preflightNativeRecipe(operation.expected, previous);
  if (operation.name === "delete_file") return null;
  if (operation.name === "write_file") return projectNativeWrite(previous, z.string().parse(operation.args.content));
  if (previous === null) throw new Error(`${nativeOperationPath(operation)} does not exist`);
  if (operation.name === "replace_lines") return projectNativeReplaceLines(previous, operation.args.replacements);
  return projectNativeReplace(previous, z.string().min(1).parse(operation.args.old_text), z.string().parse(operation.args.new_text), operation.args.replace_all === true).content;
}
