import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

import { commitSchema } from "@razbor/contracts";
import type { Database } from "@razbor/database";
import { readStoredSecret } from "@razbor/database/secrets";
import { resolveGithubInstallationToken } from "@razbor/database/github-apps";
import { gitEnvironment, safeGitOptions } from "@razbor/harness/git";
import { boundedText } from "@razbor/harness/capability-files";
import { errorDetails, logger } from "@razbor/harness/logger";

import type { RepositoryConfig } from "@indexer/src/config.js";

const exec = promisify(execFile);

export class SynchronizationError extends Error {}

export class WorkspaceDivergedError extends SynchronizationError {}

const escapedSingleQuote = String.raw`'\''`;

/**
 * Quote an approved SSH credential path as one POSIX shell argument, including embedded
 * single quotes.
 */
const quote = (value: string) =>
  `'${value.replaceAll("'", escapedSingleQuote)}'`;

export class GitSource {
  /**
   * Bind an owned checkout to its approved remote policy, command deadline, and optional
   * stored-secret access.
   */
  constructor(
    readonly repository: string,
    private readonly config: RepositoryConfig,
    private readonly timeout: number,
    private readonly database?: Database,
  ) {}

  /**
   * Run Git with isolated configuration, bounded output, and optional approved network
   * credentials; replace raw Git diagnostics with safe synchronization errors.
   */
  private async command(
    args: string[],
    signal?: AbortSignal,
    network = false,
    cwd = this.repository,
  ) {
    const options = [
      ...safeGitOptions,
      "-c",
      "http.followRedirects=false",
      "-c",
      "submodule.recurse=false",
      "-c",
      "fetch.recurseSubmodules=false",
      "-c",
      "gc.auto=0",
      "-c",
      "credential.helper=",
    ];
    const env: NodeJS.ProcessEnv = {
      ...gitEnvironment,
      PATH: "/usr/local/bin:/usr/bin:/bin",
    };
    const started = performance.now();
    let secrets: string[] = [];
    let configured = !network;
    try {
      if (network) {
        secrets = await this.configureNetwork(options, env);
        configured = true;
      }
      return (
        await exec("git", [...options, "-C", cwd, ...args], {
          env,
          timeout: this.timeout,
          maxBuffer: 1_000_000,
          signal,
        })
      ).stdout.trim();
    } catch (error) {
      logger.warn(
        {
          repository: this.repository,
          operation: args[0],
          phase: configured ? "command" : "credentials",
          durationMs: Math.round(performance.now() - started),
          timeoutMs: this.timeout,
          cancelled: signal?.aborted ?? false,
          timedOut:
            !signal?.aborted &&
            (error as { killed?: boolean } | null)?.killed === true &&
            performance.now() - started >= this.timeout,
          error: errorDetails(error, secrets),
        },
        "Git command failed",
      );
      // Detailed diagnostics stay in container logs, never API responses or setup state.
      if (error instanceof SynchronizationError) throw error;
      if (!configured) throw error;
      throw new SynchronizationError(
        `Git ${args[0]} failed; check configured remote access and repository state`,
      );
    }
  }

  /**
   * Enable only approved transport protocols and inject configured HTTPS or SSH credentials
   * without persisting them in the checkout; return secrets for container-log redaction.
   */
  private async configureNetwork(options: string[], env: NodeJS.ProcessEnv) {
    for (const protocol of [
      "https",
      "ssh",
      ...(this.config.allow_local ? ["file"] : []),
    ])
      options.push("-c", `protocol.${protocol}.allow=always`);
    const credentials = this.config.credentials;
    if (credentials?.kind === "https") {
      if ((credentials.token_id || credentials.github_app) && !this.database)
        throw new SynchronizationError("stored Git credential unavailable");
      const token = credentials.github_app
        ? await resolveGithubInstallationToken(
            this.database!,
            credentials.github_app,
            Object.values(this.config.remotes),
          )
        : credentials.token_id
          ? await readStoredSecret(this.database!, credentials.token_id)
          : (await boundedText(credentials.token_file!, 8192)).trimEnd();
      if (!token || /[\r\n\0]/.test(token))
        throw new SynchronizationError(
          "invalid configured Git credential file",
        );
      const encoded = Buffer.from(`${credentials.username}:${token}`).toString(
        "base64",
      );
      const header = `Authorization: Basic ${encoded}`;
      const urls = Object.values(this.config.remotes);
      env.GIT_CONFIG_COUNT = String(urls.length);
      urls.forEach((url, index) => {
        env[`GIT_CONFIG_KEY_${index}`] = `http.${url}.extraHeader`;
        env[`GIT_CONFIG_VALUE_${index}`] = header;
      });
      return [token, encoded, header];
    } else if (credentials?.kind === "ssh") {
      env.GIT_SSH_COMMAND = `ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${quote(credentials.known_hosts_file)} -i ${quote(credentials.key_file)}`;
    }
    return [];
  }

  /**
   * Validate configured refs, then either verify the existing checkout policy or create a
   * fresh clone with only the approved remotes and fetch refs.
   */
  async initialize(signal: AbortSignal) {
    await this.validateRefs(signal);
    const exists = await lstat(this.repository).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (exists) {
      await this.validateCheckout(signal);
      return false;
    }
    const primary = this.config.upstream.split("/")[2];
    const parent = path.dirname(this.repository);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await this.command(
      [
        "clone",
        "--no-checkout",
        "--no-local",
        "--template=",
        "--origin",
        primary,
        "--",
        this.config.remotes[primary],
        this.repository,
      ],
      signal,
      true,
      parent,
    );
    for (const [name, url] of Object.entries(this.config.remotes)) {
      if (name !== primary)
        await this.command(["remote", "add", name, url], signal);
      for (const [index, source] of (
        this.config.extra_fetch_refs[name] ?? []
      ).entries())
        await this.command(
          [
            "config",
            "--add",
            `remote.${name}.fetch`,
            `+${source}:refs/razbor/${name}/${index}`,
          ],
          signal,
        );
    }
    return true;
  }

  /**
   * Require a canonical owned checkout whose remote names, URLs, and fetch refspecs exactly
   * match operator policy.
   */
  private async validateCheckout(signal: AbortSignal) {
    if (
      (await realpath(this.repository)) !== this.repository ||
      !(await lstat(path.join(this.repository, ".git"))).isDirectory()
    )
      throw new SynchronizationError(
        "workspace must be an owned checkout without symlinks",
      );
    const names = (await this.command(["remote"], signal))
      .split("\n")
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
    if (
      JSON.stringify(names) !==
      JSON.stringify(
        Object.keys(this.config.remotes).sort((left, right) =>
          left.localeCompare(right),
        ),
      )
    )
      throw new SynchronizationError(
        "workspace remotes differ from operator configuration",
      );
    for (const [name, url] of Object.entries(this.config.remotes)) {
      if ((await this.command(["remote", "get-url", name], signal)) !== url)
        throw new SynchronizationError(
          "workspace remote URL differs from operator configuration",
        );
      const expected = [
        `+refs/heads/*:refs/remotes/${name}/*`,
        ...(this.config.extra_fetch_refs[name] ?? []).map(
          (ref, index) => `+${ref}:refs/razbor/${name}/${index}`,
        ),
      ];
      if (
        (await this.command(
          ["config", "--get-all", `remote.${name}.fetch`],
          signal,
        )) !== expected.join("\n")
      )
        throw new SynchronizationError(
          "workspace fetch refs differ from operator configuration",
        );
    }
  }

  /** Validate configured branch and upstream refs with Git before any checkout is created. */
  private async validateRefs(signal: AbortSignal) {
    // check-ref-format does not require the checkout to exist.
    for (const ref of [
      `refs/heads/${this.config.branch}`,
      this.config.upstream,
      ...Object.values(this.config.extra_fetch_refs).flat(),
    ]) {
      try {
        await exec("git", ["check-ref-format", ref], {
          env: gitEnvironment,
          timeout: this.timeout,
          signal,
        });
      } catch {
        throw new SynchronizationError(
          "invalid configured branch or upstream ref",
        );
      }
    }
  }

  /**
   * Require a clean checkout, including ignored files, and reject unfinished Git operations
   * without modifying them.
   */
  async clean(signal: AbortSignal) {
    if (
      await this.command(
        [
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
          "--ignored=matching",
        ],
        signal,
      )
    )
      throw new SynchronizationError(
        "workspace contains local changes; operator intervention required",
      );
    for (const name of [
      "rebase-merge",
      "rebase-apply",
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
    ]) {
      const exists = await lstat(path.join(this.repository, ".git", name)).then(
        () => true,
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
      if (exists)
        throw new SynchronizationError(
          "workspace has an unfinished Git operation; operator intervention required",
        );
    }
  }

  /** Resolve HEAD to a validated full commit ID. */
  async head(signal: AbortSignal) {
    return commitSchema.parse(
      await this.command(["rev-parse", "--verify", "HEAD^{commit}"], signal),
    );
  }

  /**
   * Populate an interrupted no-checkout clone only when it has no index or working-tree
   * entries; preserve its existing HEAD and refuse pending Git operations or redirected
   * worktree paths.
   */
  private async recoverInterruptedCheckout(signal: AbortSignal) {
    const entries = await readdir(this.repository, { withFileTypes: true });
    if (
      entries.length !== 1 ||
      entries[0].name !== ".git" ||
      !entries[0].isDirectory()
    )
      return;
    const gitDirectory = path.join(this.repository, ".git");
    const metadata = await readdir(gitDirectory);
    if (metadata.includes("index")) return;
    if (
      metadata.some(
        (name) =>
          name.endsWith(".lock") ||
          [
            "rebase-merge",
            "rebase-apply",
            "MERGE_HEAD",
            "CHERRY_PICK_HEAD",
            "REVERT_HEAD",
            "sequencer",
            "BISECT_LOG",
          ].includes(name),
      )
    )
      throw new SynchronizationError(
        "workspace has an unfinished Git operation; operator intervention required",
      );
    if (
      (await this.command(["rev-parse", "--show-toplevel"], signal)) !==
        this.repository ||
      (await this.command(["rev-parse", "--absolute-git-dir"], signal)) !==
        gitDirectory ||
      (await this.command(
        [
          "config",
          "--type=bool",
          "--default=false",
          "--get",
          "core.sparseCheckout",
        ],
        signal,
      )) !== "false"
    )
      throw new SynchronizationError(
        "workspace must be an owned full checkout without redirected Git paths",
      );
    const head = await this.head(signal);
    if (
      (await this.command(
        ["rev-list", "--count", `${this.config.upstream}..${head}`],
        signal,
      )) !== "0"
    )
      throw new SynchronizationError(
        "workspace contains local history; operator intervention required",
      );
    signal.throwIfAborted();
    await this.command(
      ["restore", `--source=${head}`, "--staged", "--worktree", "--", "."],
      signal,
    );
    logger.info(
      { repository: this.repository, head },
      "interrupted no-checkout clone recovered",
    );
  }

  /**
   * Fetch approved remotes and update the tracking branch to the exact upstream commit;
   * preserve local changes and report divergence for explicit recovery.
   */
  async refresh(signal: AbortSignal) {
    const fresh = await this.initialize(signal);
    if (!fresh) {
      if (
        (await this.command(["symbolic-ref", "--short", "HEAD"], signal)) !==
        this.config.branch
      )
        throw new SynchronizationError(
          "workspace is not on its configured local tracking branch",
        );
      if (
        (await this.command(
          [
            "for-each-ref",
            "--format=%(upstream)",
            `refs/heads/${this.config.branch}`,
          ],
          signal,
        )) !== this.config.upstream
      )
        throw new SynchronizationError(
          "workspace tracking upstream differs from configuration",
        );
      await this.recoverInterruptedCheckout(signal);
      await this.clean(signal);
    }
    await this.command(["fetch", "--all", "--prune"], signal, true);
    const expected = commitSchema.parse(
      await this.command(
        ["rev-parse", "--verify", `${this.config.upstream}^{commit}`],
        signal,
      ),
    );
    if (fresh) {
      // The upstream may have moved between clone and fetch. Only a new clone
      // can replace its initial branch without preserving local history.
      await this.command(
        ["checkout", "-B", this.config.branch, expected],
        signal,
      );
      await this.command(
        [
          "branch",
          `--set-upstream-to=${this.config.upstream}`,
          this.config.branch,
        ],
        signal,
      );
    } else {
      // A successful query distinguishes divergence from Git failure or
      // cancellation; neither of those authorizes replacing the checkout.
      if (
        (await this.command(
          ["rev-list", "--count", `${expected}..HEAD`],
          signal,
        )) !== "0"
      )
        throw new WorkspaceDivergedError(
          "workspace diverged from fetched upstream; fresh clone required",
        );
      try {
        await this.command(
          ["rebase", "--no-autostash", this.config.upstream],
          signal,
        );
      } catch {
        // No preexisting rebase passed clean(). Only abort the operation we started.
        await this.command(
          ["rebase", "--abort"],
          AbortSignal.timeout(10000),
        ).catch(() => {});
        throw new SynchronizationError(
          "upstream rebase failed; service-started rebase abort attempted, inspect workspace before refreshing",
        );
      }
    }
    if ((await this.head(signal)) !== expected)
      throw new SynchronizationError(
        "HEAD does not match the fetched upstream revision",
      );
    await this.clean(signal);
    return expected;
  }

  /**
   * Build a fresh upstream checkout in staging and replace the clean owned checkout after
   * validation; the caller must stop its backend first.
   */
  async reclone(signal: AbortSignal) {
    // The workspace owner must stop its backend before replacing this path.
    await this.initialize(signal);
    await this.clean(signal);
    const staging = await mkdtemp(
      path.join(path.dirname(this.repository), "reclone-"),
    );
    try {
      const replacement = new GitSource(
        path.join(staging, "repository"),
        this.config,
        this.timeout,
        this.database,
      );
      const head = await replacement.refresh(signal);
      await this.clean(signal);
      signal.throwIfAborted();
      await rm(this.repository, { recursive: true });
      await rename(replacement.repository, this.repository);
      return head;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  /**
   * Create a fresh detached review checkout containing both exact commits and a merge base,
   * fetching missing revisions through the approved remote.
   */
  async review(base: string, head: string, signal: AbortSignal) {
    commitSchema.parse(base);
    commitSchema.parse(head);
    if (!(await this.initialize(signal)))
      throw new SynchronizationError("review workspace already exists");
    await this.command(["fetch", "--all", "--prune"], signal, true);
    const remote = this.config.upstream.split("/")[2];
    for (const sha of [base, head]) {
      try {
        await this.command(["cat-file", "-e", `${sha}^{commit}`], signal);
      } catch {
        await this.command(["fetch", "--no-tags", remote, sha], signal, true);
      }
      if (
        (await this.command(
          ["rev-parse", "--verify", `${sha}^{commit}`],
          signal,
        )) !== sha
      )
        throw new SynchronizationError(
          "requested revision is not an exact commit",
        );
    }
    await this.command(["checkout", "--detach", head], signal);
    await this.command(["merge-base", base, head], signal);
    if ((await this.head(signal)) !== head)
      throw new SynchronizationError("review checkout does not match headSha");
    await this.clean(signal);
    return head;
  }
}
