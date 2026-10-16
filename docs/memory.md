# Review memory

Memory holds repository knowledge between reviews: why a retry rule exists,
where authorization belongs, or a detail worth checking next time. People and
review bots share Markdown documents. Bots can update them without approval for
each write.

Memory lives in PostgreSQL, uses the normal database migrations, and requires
neither the indexer nor an embedding model.

## Read or edit a note

1. Open a repository's **Memory** tab and search before creating a note.
2. Edit its title, path, and Markdown. Check the preview.
3. Select **Save** to share the change with future reviews.

Use a descriptive relative path such as `architecture/job-retries.md`. Paths must
end in `.md` and cannot contain traversal, backslashes, or control characters.
Each document can hold up to 64 KiB of UTF-8 text.

Search matches words in titles, paths, and bodies. Saved changes are searchable
immediately; deleted notes leave normal browsing and search.

## Recover drafts and earlier versions

The editor saves unfinished changes in this browser. Returning to Memory resumes
the tab's last draft. **Drafts saved in this browser** lets you recover drafts
from closed tabs or discard them. Only **Save** publishes a draft to shared memory.

Drafts belong to this browser and site. They do not sync between devices, and
clearing browser data removes them. If storage is blocked or full, the editor
warns you and keeps the current fields, but cannot preserve them after closing.

Every saved edit, deletion, and restoration creates a revision. You can inspect
an older revision and restore it as a new one without erasing history.

If someone else changes a document while you edit, saving reports a conflict and
keeps your draft. Compare it with the latest version, reconcile, and save again.

## How reviewers use memory

| Task                               | Tools                                                 |
| ---------------------------------- | ----------------------------------------------------- |
| Find and read notes                | `memory_list`, `memory_search`, `memory_read`         |
| Create or update notes             | `memory_create`, `memory_write`, `memory_edit`        |
| Inspect history, delete or restore | `memory_revisions`, `memory_delete`, `memory_restore` |

Each active review can access only its repository's memory. The model cannot
choose another repository and receives no database credentials. Cancellation or
loss of review authorization revokes access. A standalone agent has no memory
access unless its prepared job supplies it.

Memory tools write to the database before returning. Markdown files created in
the temporary review checkout are not saved to memory. Targeted edits must match
exactly one occurrence; full-document replacement is also supported.

Check remembered claims against current source. Notes do not override project
instructions, and a fact learned from a pull request does not prove that its
changes reached another branch.

## Storage and API access

Documents belong to collections. A repository receives a default writable
collection when needed. Removing a repository removes its bindings, but keeps
the collections. The UI does not expose collection-sharing administration.

The console uses `/api/repositories/<repository-id>/memory`. Reviews use
`POST /api/runner/attempts/<attempt-id>/memory` through the runner relay. Both
support `list`, `search`, `read`, `create`, `write`, `edit`, `delete`, `revisions`,
and `restore`. Updates require the version originally read; stale versions return
HTTP 409 with the current document.
