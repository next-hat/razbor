import { constants } from "node:fs";
import { open, realpath, lstat } from "node:fs/promises";
import path from "node:path";

/**
 * Reads a regular file without following its final symlink, enforcing a byte limit and
 * valid NUL-free UTF-8. Always closes the file handle.
 */
export async function boundedText(file: string, limit: number) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit)
      throw new Error(
        "text file exceeds configured limit or is not a regular file",
      );
    const buffer = Buffer.alloc(limit + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (!read.bytesRead) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead > limit || buffer.subarray(0, bytesRead).includes(0))
      throw new Error("invalid or oversized text file");
    return new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, bytesRead),
    );
  } finally {
    await handle.close();
  }
}

/**
 * Resolves a relative resource inside its root, rejecting traversal and symlink
 * components before checking the final real path.
 */
export async function confinedFile(root: string, resource: string) {
  if (
    !resource ||
    path.isAbsolute(resource) ||
    resource.split(/[\\/]/).some((part) => part === ".." || part === "")
  )
    throw new Error("invalid resource path");
  const base = await realpath(root);
  let file = base;
  for (const part of resource.split("/")) {
    file = path.join(file, part);
    if ((await lstat(file)).isSymbolicLink())
      throw new Error("symlink resources are not allowed");
  }
  const resolved = await realpath(file);
  if (!resolved.startsWith(`${base}${path.sep}`))
    throw new Error("resource escapes approved directory");
  return resolved;
}

/**
 * Caps UTF-8 output by bytes and reserves space for an explicit truncation marker
 * directing callers to narrower queries or pagination.
 */
export function boundedOutput(text: string, maxBytes: number) {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  const marker = "\n[TRUNCATED: narrow the query or use pagination]";
  return (
    new TextDecoder().decode(
      bytes.subarray(0, maxBytes - Buffer.byteLength(marker) - 3),
    ) + marker
  );
}
