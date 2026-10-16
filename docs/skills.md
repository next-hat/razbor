# Instructions and skills

Instructions describe how to review a repository. Skills package guidance for a
task, such as checking API compatibility. Neither grants tools or runs scripts.

## Add a skill in the console

1. Open **Skills** and create a skill, or import a `SKILL.md` file or directory.
2. Use a unique lowercase name with hyphens, such as `api-review`.
3. Select it under the repository's **Settings → Instructions and skills**.
4. Enable **Always include** to supply its instructions before the first model
   request. Leave it off for on-demand loading.
5. Start a new review.

Every personal account and organization gets an editable
`razbor-core-review-guide` skill covering change impact, regressions, failure
paths, evidence, and candidate verification. It is always included by default
for new repositories and those with unsaved guidance settings.

The migration adds this guide to configured repositories while preserving their
selections and flags. If an assignment would exceed selection or content limits,
it leaves the settings intact and reports the skipped assignment. The guide
remains available in the account's library. Name collisions preserve the existing
skill and give the guide a unique name.

You can edit or rename the guide, change its inclusion mode, or deselect it.
Remove explicit repository selections before deleting it. The guide is seeded
once; deletion does not recreate it on login. New repositories use the account's
current default guide unless it has been deleted.

A skill begins with a name and description between `---` lines:

```markdown
---
name: api-review
description: Review API changes for authorization and backward compatibility.
---

Check that each changed endpoint still enforces authorization.
Compare response fields with the previous version and flag breaking changes.
```

Add `.md` and `.txt` reference files beside `SKILL.md` or in subdirectories. Refer
to them in the instructions, for example: `Read references/api-rules.md when
reviewing authentication changes.`

The reviewer searches on-demand skills by name and description with `find_skill`,
then loads them with `read_skill`. Always included skills need neither call for
their main instructions; reference files remain available on demand. Execution
logs record each supplied skill's ID, name, version, and inclusion mode. This
records delivery, not whether the model followed every instruction.

## Keep guidance in your repository

Enable repository instructions or repository skills on the same settings page.
These switches are independent of console skill selections.

| File                               | Purpose                                          |
| ---------------------------------- | ------------------------------------------------ |
| `AGENTS.md` at the repository root | Instructions for the whole repository            |
| `AGENTS.md` in a subdirectory      | Instructions for that directory and its children |
| `.agents/skills/<name>/SKILL.md`   | A skill stored with your code                    |

Root `AGENT.md` is accepted when root `AGENTS.md` is absent. Nested instructions
take precedence in their directory. razbor reads guidance from the review's
**base commit**, so a pull request's guidance changes apply after merging.
Files must be tracked, regular Git files; symlinks are rejected.

## What happens when you edit guidance

New reviews save the selected managed skills, inclusion modes, and exact contents.
Edits to skills or repository settings affect later reviews. Queued reviews and
retries retain their original selection. Remove repository selections before
deleting a skill from the catalog.

Operators can supply instructions and skill directories through
[runner configuration](../config/runner.example.toml), with those files explicitly
mounted into the runner. Operator instructions take precedence over repository
instructions; the harness review policy takes precedence over all supplied
guidance. Repositories with never-saved guidance settings retain the legacy
runner configuration behavior.

## File limits

| Input                                    | Limit                                                     |
| ---------------------------------------- | --------------------------------------------------------- |
| One skill resource                       | 128 KiB of UTF-8 text                                     |
| One managed skill bundle                 | 2,000 resources and 1 MiB of text                         |
| Managed skills selected for a repository | 100 skills, sharing a 1 MiB content budget                |
| Repository instruction files             | 100 files, sharing `instructionBytes` (32 KiB by default) |
| Skill snapshot across all sources        | 2,000 entries, including directories, and 8 MB            |

Resource paths must be relative, at most 200 UTF-8 bytes, and contain no `..`
traversal or backslashes. Binary files, duplicate skill IDs, and oversized inputs
are rejected. Scripts and package installation are outside the skill format.

If you lower `capabilities.limits.toolOutputBytes` from its 512 KiB default, allow
room for a full resource, JSON escaping, and metadata. Instructions exceeding the
limit are rejected rather than shortened. Repository guidance discovery also
fails if the tracked-file listing exceeds the Git helper's 1 MB output limit.
