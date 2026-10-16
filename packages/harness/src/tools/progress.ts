import path from "node:path";

import { readSkillSchema } from "@harness/src/capabilities/skills.js";
import { execArguments } from "@harness/src/tools/exec.js";
import { readFileArguments } from "@harness/src/tools/repository.js";
import { textPrefix } from "@harness/src/tools/text.js";

const displayedCommands = new Set([
  "git",
  "rg",
  "grep",
  "npm",
  "pnpm",
  "yarn",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
]);

const interpreters = new Set([
  "node",
  "python",
  "python3",
  "sh",
  "bash",
  "zsh",
]);

const sensitiveOption =
  /(?:^|[-_])(?:token|secret|password|passwd|credential|authorization|auth|api[-_]?key|access[-_]?key|private[-_]?key)(?:$|[-_=])/i;

const gitCommands = new Set([
  "status",
  "diff",
  "show",
  "log",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "cat-file",
  "merge-base",
]);

const commandSwitches = new Set([
  "--",
  "-n",
  "-i",
  "-l",
  "-c",
  "-w",
  "-r",
  "-a",
  "-b",
  "-s",
  "-u",
  "-h",
  "-R",
  "-I",
  "-F",
  "-E",
  "-P",
  "--short",
  "--stat",
  "--numstat",
  "--name-only",
  "--name-status",
  "--no-renames",
  "--no-color",
  "--cached",
  "--verify",
  "--show-toplevel",
  "--all",
  "--oneline",
  "--porcelain",
  "--hidden",
  "--files",
  "--files-with-matches",
  "--line-number",
  "--ignore-case",
  "--fixed-strings",
  "--count",
  "--recursive",
  "--follow",
  "--no-ignore",
  "--no-heading",
  "--heading",
  "--word-regexp",
]);

const grepValueSwitches = new Set(["-m", "--max-count", "-A", "-B", "-C"]);

const ripgrepValueSwitches = new Set([
  ...grepValueSwitches,
  "-g",
  "--glob",
  "-t",
  "--type",
  "-T",
  "--type-not",
  "-E",
  "--encoding",
]);

/**
 * Restricts displayed metadata to short single-line identifiers and paths. URLs,
 * assignments, recognizable credentials and long opaque strings remain undisplayed.
 * This is a conservative display policy, not a general secret classifier.
 */
function displayToken(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 160 ||
    !/^[\w./:@*?^()[\]{}|\\+-]+$/.test(value) ||
    value.includes("://") ||
    (value.includes(":") && value.includes("@")) ||
    /(?:^|\/)(?:sk-|gh[pousr]_|github_pat_|glpat-|AKIA|eyJ)/i.test(value) ||
    /[A-Za-z0-9_-]{32,}/.test(value)
  )
    return undefined;
  return value;
}

/** Returns a short repository-relative path, excluding traversal and control text. */
function displayPath(value: unknown): string | undefined {
  const token = displayToken(value);
  if (!token || path.isAbsolute(token) || token.split(/[\\/]/).includes(".."))
    return undefined;
  return token;
}

/**
 * Shows common commands with selected argument tokens. Search patterns, interpreter
 * bodies, configuration operations, assignments and credential option values are
 * hidden before persistence; other conventional executable names hide all arguments.
 * Search option operands follow each command's rules rather than sharing flag meanings.
 * Unsupported or sensitive options hide the remainder rather than guessing their operands.
 * Search option delimiters also hide the remainder, including patterns starting with a dash.
 */
function commandSummary(input: unknown): string | undefined {
  const parsed = execArguments.safeParse(input);
  if (!parsed.success) return undefined;
  const { argv, cwd } = parsed.data;
  const command = path.basename(argv[0]);
  if (!/^[A-Za-z][\w.-]{0,63}$/.test(command) || !displayToken(command))
    return undefined;
  const tokens = [command];
  if (interpreters.has(command) || !displayedCommands.has(command)) {
    if (argv.length > 1) tokens.push("[arguments hidden]");
  } else if (["npm", "pnpm", "yarn"].includes(command)) {
    const operation = argv[1];
    if (
      [
        "run",
        "run-script",
        "test",
        "typecheck",
        "lint",
        "install",
        "ci",
      ].includes(operation)
    ) {
      tokens.push(operation);
      const script = ["run", "run-script"].includes(operation)
        ? displayToken(argv[2])
        : undefined;
      if (script && /^[\w:.-]+$/.test(script)) tokens.push(script);
      if (argv.length > (script ? 3 : 2)) tokens.push("[arguments hidden]");
    } else if (argv.length > 1) tokens.push("[arguments hidden]");
  } else if (command === "git" && !gitCommands.has(argv[1])) {
    if (argv.length > 1) tokens.push("[arguments hidden]");
  } else {
    let hideNext = false;
    let searchPatternSeen = false;
    let searchOptionValue = false;
    const remaining = command === "git" ? argv.slice(2) : argv.slice(1);
    if (command === "git") tokens.push(argv[1]);
    for (const argument of remaining) {
      // A valued search switch consumes its operand even when it resembles an option.
      if (searchOptionValue) {
        searchOptionValue = false;
        tokens.push(displayToken(argument) ?? "[argument hidden]");
        continue;
      }
      if (
        command === "git" &&
        ["-c", "--config-env", "config", "credential"].includes(argument)
      ) {
        tokens.push("[arguments hidden]");
        break;
      }
      if (hideNext) {
        tokens.push("[redacted]");
        hideNext = false;
        continue;
      }
      if (sensitiveOption.test(argument)) {
        tokens.push("[arguments hidden]");
        break;
      }
      if (["rg", "grep"].includes(command)) {
        if (argument === "--") {
          tokens.push("--", "[arguments hidden]");
          break;
        }
        if (command === "rg" && argument === "--files")
          searchPatternSeen = true;
        if (command === "rg" && ["-r", "--replace"].includes(argument)) {
          hideNext = true;
        } else if (["-e", "--regexp", "-f", "--file"].includes(argument)) {
          searchPatternSeen = true;
          hideNext = true;
        } else if (/^-[ef].+/.test(argument)) {
          tokens.push("[pattern hidden]");
          searchPatternSeen = true;
          continue;
        } else if (!argument.startsWith("-") && !searchPatternSeen) {
          tokens.push("[pattern hidden]");
          searchPatternSeen = true;
          continue;
        }
        searchOptionValue = (
          command === "grep" ? grepValueSwitches : ripgrepValueSwitches
        ).has(argument);
      }
      if (
        argument.startsWith("-") &&
        !commandSwitches.has(argument) &&
        !(command === "grep" && ["-T", "--initial-tab"].includes(argument)) &&
        !searchOptionValue &&
        !hideNext
      ) {
        tokens.push("[arguments hidden]");
        break;
      }
      if (argument.includes("=")) {
        tokens.push("[argument hidden]");
        continue;
      }
      tokens.push(displayToken(argument) ?? "[argument hidden]");
    }
  }
  return `${tokens.join(" ")} · cwd=${displayPath(cwd ?? ".") ?? "[path hidden]"}`;
}

/**
 * Selects tool-specific identifiers without retaining arbitrary arguments, source,
 * search queries, remote URLs or tool results. Bounds stored summaries to 600 bytes.
 */
export function toolProgressSummary(
  name: string,
  input: unknown,
): string | undefined {
  name = name.replace(/^cbm_/, "");
  let summary: string | undefined;
  if (name === "exec") summary = commandSummary(input);
  else if (name === "read_file") {
    const parsed = readFileArguments.safeParse(input);
    if (!parsed.success) return undefined;
    const file = displayPath(parsed.data.path);
    if (!file) return undefined;
    const start = parsed.data.startLine ?? 1;
    const end = parsed.data.endLine ?? start + 399;
    if (!Number.isSafeInteger(end) || end < start) return undefined;
    summary = `${file}:${start}–${end} · ${parsed.data.revision ?? "head"}`;
  } else if (name === "read_skill") {
    const parsed = readSkillSchema.safeParse(input);
    if (!parsed.success) return undefined;
    const id = displayToken(parsed.data.id);
    const resource = displayPath(parsed.data.resource ?? "SKILL.md");
    if (id && resource) summary = `${id} · ${resource}`;
  } else if (input && typeof input === "object" && !Array.isArray(input)) {
    const args = input as Record<string, unknown>;
    if (
      ["read_diff", "check_index_coverage"].includes(name) &&
      Array.isArray(args.paths) &&
      args.paths.length <= 8
    ) {
      const paths = args.paths.map(displayPath);
      if (paths.length && paths.every(Boolean)) summary = paths.join(", ");
    } else {
      const fields: Record<string, string[]> = {
        search_graph: ["name_pattern", "file_pattern"],
        trace_path: ["function_name", "direction"],
        get_code_snippet: ["qualified_name"],
      };
      summary =
        (Object.hasOwn(fields, name) ? fields[name] : undefined)
          ?.map((key) => displayToken(args[key]))
          .filter(Boolean)
          .join(" · ") || undefined;
    }
  }
  return summary ? textPrefix(summary, 600) : undefined;
}
