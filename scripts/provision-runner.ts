import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chown,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { provisionRunner, type Database } from "@razbor/database";
import { loadRunnerConfig } from "@razbor/runner/config";

/** Match a Node filesystem error code without treating other thrown values as filesystem failures. */
function isErrorCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * Create or validate a private enrollment directory owned by the runner's UID and GID.
 * Reject symlinked paths and existing directories with incompatible ownership or permissions.
 */
async function registrationDirectory(
  directory: string,
  uid: number,
  gid: number,
) {
  const created = await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || (await realpath(directory)) !== directory)
    throw new Error(
      "Runner registration directory must not contain symbolic links.",
    );
  if (created && (metadata.uid !== uid || metadata.gid !== gid))
    await chown(directory, uid, gid);
  const saved = await lstat(directory);
  if ((saved.mode & 0o777) !== 0o700 || saved.uid !== uid || saved.gid !== gid)
    throw new Error(
      "Runner registration directory must be private and owned by the runner user.",
    );
}

/**
 * Read and sync an existing enrollment token without following a symlink.
 * Require the expected owner, read-only private permissions, and exact token format.
 */
async function readRegistrationToken(file: string, uid: number, gid: number) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size < 43 ||
      metadata.size > 44 ||
      (metadata.mode & 0o777) !== 0o400 ||
      metadata.uid !== uid ||
      metadata.gid !== gid
    )
      throw new Error(
        "Runner registration token must be a private file owned by the runner user.",
      );
    const content = await handle.readFile("utf8");
    if (!/^[A-Za-z0-9_-]{43}\n?$/.test(content))
      throw new Error("Runner registration token is invalid.");
    await handle.sync();
    return content.trim();
  } finally {
    await handle.close();
  }
}

/**
 * Reuse or durably publish one private enrollment token, preserving a concurrent creator's token.
 * Sync the file and directory before its hash can be published to the database.
 */
async function registrationToken(file: string, uid: number, gid: number) {
  const directory = path.dirname(file);
  await registrationDirectory(directory, uid, gid);
  let token: string | undefined;
  try {
    token = await readRegistrationToken(file, uid, gid);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
  if (!token) {
    // Persist the token before publishing its hash to the database. A hard link
    // publishes without overwriting: concurrent bootstraps read the same winner.
    const temporary = path.join(
      directory,
      `.token-${randomBytes(16).toString("hex")}`,
    );
    const handle = await open(temporary, "wx", 0o400);
    try {
      await handle.writeFile(`${randomBytes(32).toString("base64url")}\n`);
      const metadata = await handle.stat();
      if (metadata.uid !== uid || metadata.gid !== gid)
        await handle.chown(uid, gid);
      await handle.sync();
      try {
        await link(temporary, file);
      } catch (error) {
        if (!isErrorCode(error, "EEXIST")) throw error;
      }
    } finally {
      await handle.close();
      await unlink(temporary);
    }
  }
  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
  return token ?? readRegistrationToken(file, uid, gid);
}

/**
 * Provision the runner declared in TOML using a durable file-backed enrollment token.
 * Require an explicit registration block and trusted control URL, then print only non-secret status.
 */
export async function provisionRunnerConfig(
  database: Database,
  configFile: string,
) {
  const config = await loadRunnerConfig(configFile);
  const registration = config.registration;
  const control = config.control;
  const reference = control?.enrollment_token;
  if (
    !registration ||
    !control ||
    !reference ||
    typeof reference !== "object" ||
    !("file" in reference)
  )
    throw new Error(
      "Runner provisioning requires registration and a control.enrollment_token.file reference.",
    );
  if (new URL(control.url).protocol !== "https:" && !control.allow_http)
    throw new Error(
      "Runner provisioning requires HTTPS or explicit trusted-development HTTP.",
    );
  if (!path.isAbsolute(reference.file))
    throw new Error("Runner registration token file must be absolute.");
  const tokenFile = path.resolve(reference.file);
  const enrollmentToken = await registrationToken(
    tokenFile,
    config.docker.uid,
    config.docker.gid,
  );
  const result = await provisionRunner(database, {
    ...registration,
    enrollmentToken,
  });
  console.log(
    JSON.stringify({
      id: result.runner.id,
      state: result.runner.state,
      created: result.created,
      enrollment: result.enrollment,
    }),
  );
}
