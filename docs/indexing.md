# Repository indexing and search

The indexer clones registered repositories and builds searchable code and
documentation indexes. Reviews use them to find related code, then verify the
exact source revisions under review.

An index follows the configured branch, usually the default branch. It does not
include local uncommitted changes or create a graph for each pull request.

## Prepare the indexer

Follow [getting started](getting-started.md) first. The development Compose stack
starts the indexer, local embeddings, and PostgreSQL with pgvector.

The indexer requires the pinned **Codebase Memory v0.11.0 Linux amd64 portable**
bundle. To provision it separately:

```sh
export RAZBOR_CBM_BUNDLE="$HOME/.local/share/razbor/cbm"
bash scripts/provision-cbm.sh "$RAZBOR_CBM_BUNDLE"
```

Use the same path in `.env`. The script verifies the download, and the service
checks the executable and version at startup. Updates are explicit.

Keep `RAZBOR_INDEX_DATA` outside the checkout. It holds private Git checkouts and
graph files; do not use it as a developer worktree or share it between independent
indexer owners. It must be writable by `RAZBOR_UID` / `RAZBOR_GID`, both 1000
by default. If you created it as your own user, set those values from `id -u` and
`id -g`, then recreate:

```sh
docker compose up -d --force-recreate indexer
```

For existing data, preserve ownership or grant the chosen user access before
starting. Changing environment variables does not change file owners.

Compose uses [config/indexer.example.toml](../config/indexer.example.toml). For
overrides, copy it to `config/indexer.local.toml` and set `RAZBOR_INDEX_CONFIG`
in `.env`. Its `service.owner` must match the web service's `RAZBOR_INDEX_OWNER`;
both default to `local-indexer`.

The first development startup downloads two pinned embedding models and may take
several minutes. Later starts verify and reuse the model volume. Search runs
locally; repository content is not sent to an external embedding API.

```sh
docker compose build
docker compose up -d
docker compose ps -a
docker compose logs --tail=50 embedding-model embeddings database-extensions migrate indexer
```

Setup services should exit with code `0`. Compose provisions models, enables
pgvector, and runs migrations. The embedding service has no published port and
is limited to two CPUs and 4 GiB RAM. Production images already contain their
models and Codebase Memory bundle; see [deployment](deployment.md).

## Create or refresh an index

1. Add a repository in **Repositories → Add repository**. Razbor verifies access
   and schedules indexing.
2. Follow progress in repository **Settings**. After fixing an error, use
   **Retry setup**.
3. Open **Indexer** for readiness, indexed commit, and **Last indexed**.
4. Choose **Index repository** for a registered repository without an index, or
   **Refresh index** for newer commits.

Once accepted, preparation runs in the indexer. You can leave the page and return;
polling reconnects to the same work. Repeated start requests share the active
preparation, including automatic repository setup.

Progress shows the phase, elapsed time, and processed code and document chunks.
Totals appear when known; discovery has no overall percentage. **Indexed** means
the graph and both corpora are ready. Failed progress polling is shown separately
from saved readiness and is retried.

Signed Forgejo push events for the configured branch can trigger refreshes; see
[webhooks](comment-reviews.md). There is no scheduled fetch, and unchanged indexes
keep their previous **Last indexed** date.

During refresh the workspace is unavailable. The indexer fetches, checks the
branch, updates its checkout, and waits for code and document indexes to match.
A failed refresh remains unavailable until preparation succeeds. After a restart,
refresh or the first review prepares the saved index again.

Force-pushes and branch rewinds rebuild the checkout and graph. Local edits,
unexpected remotes, and unfinished Git operations need operator attention.
An interrupted first clone can recover only if the directory contains `.git`
alone, has no Git index, and matches the configured branch, upstream, and remote
policy. Working-tree entries, top-level Git metadata locks, or unfinished Git
operations block this recovery. The indexer's checkout is a remote cache, so keep
unpublished work elsewhere.

Index large repositories before requesting reviews. Reviews reuse a ready branch
index but keep source pinned to the PR commit. If refresh advances the shared
index mid-review, access to the old graph is rejected; pinned source inspection
remains available.

## Connect an editor or MCP client

MCP clients can query ready indexes:

1. In **Indexer**, finish indexing the repositories you need.
2. Choose **Generate token**.
3. Select repositories, or **All repositories** for current and future ones
   belonging to this indexer.
4. Grant refresh permission only if the client should update indexes.
5. Copy the one-time token display.
6. Connect to `http://127.0.0.1:8790/mcp` with
   `Authorization: Bearer YOUR_TOKEN`.

Development tokens have no expiry by default. Revoke lost or unused tokens in the
console. `tok_...` identifies a record; it is not the bearer secret.

For a multi-repository token, call `list_projects` and pass the returned `idx_...`
ID as `project`. A single-repository token is already bound. If no index was
ready at connection time, refresh the client's tool list after preparation.

Compose publishes the indexer on loopback. Use an SSH tunnel or secured HTTPS
proxy from another machine. Keep management tokens, Git credentials, and database
credentials out of client configuration. See
[token administration](persistence.md#token-and-workspace-management) for the CLI.

## What each search covers

| Tool                                   | Use                                 | Coverage                                                 |
| -------------------------------------- | ----------------------------------- | -------------------------------------------------------- |
| `search_graph`, `trace_path`           | Symbols, callers, and relationships | Parsed Codebase Memory graph.                            |
| `get_code_snippet`, `search_code`      | Read or locate source               | Indexed branch revision.                                 |
| `check_index_coverage`, `index_status` | Check gaps and revision             | Best-effort index metadata.                              |
| `semantic_search`                      | Find code by meaning or example     | Graph functions and methods.                             |
| `search_documents`                     | Find documentation                  | Eligible committed Markdown, using meaning and keywords. |

Agents receive these tools with a `cbm_` prefix. Code and document search are
optional in standalone installations and enabled by default in Compose.
Similarity scores rank candidates; empty results do not prove absence. Read the
source before relying on a match.

Code search uses `codesage/codesage-small-v2`, revision
`4844c2f24b25e181aa43ca058cc73dd2622565c1`, with 1024 dimensions.
Document search uses `intfloat/multilingual-e5-small`, revision
`614241f622f53c4eeff9890bdc4f31cfecc418b3`, with 384 dimensions.
Both bundles are verified before loading. Keep the embedding image's pinned
dependencies when rebuilding; the models depend on those versions.

Example code-search arguments:

```json
{
  "query": "reject a token used for another repository",
  "kind": "text",
  "limit": 8,
  "path_prefix": "apps/"
}
```

Use `kind: "code"` for a code snippet. Document search accepts `query`, `limit`,
and optional `path_prefix`, without `kind`. Both searches default to eight results
and allow 1–20. Results include paths, line ranges, and the indexed revision.

Document search includes committed `.md` files regardless of filename case,
subject to Git ignores and root `.cbmignore`. It excludes untracked files, `.mdx`,
attachments, submodules, and external notes. Retrieved instructions are reference
material and do not override approved review instructions.

## Limits and tuning

The example uses `memory.mode = "full"`; `fast` and `moderate` are also available.

| Setting or limit             | Default or maximum                                  |
| ---------------------------- | --------------------------------------------------- |
| `service.sync_ms`            | Git synchronization: 60000 ms.                      |
| `memory.index_ms`            | Graph preparation: 90000 ms.                        |
| `memory.query_ms`            | Graph queries: 15000 ms.                            |
| `embeddings.request_ms`      | Embedding requests: 60000 ms.                       |
| `embeddings.index_ms`        | Shared code/document preparation: 600000 ms.        |
| `embeddings.max_chunks`      | 20000 per corpus; may be lowered.                   |
| Code-search input            | 1800 UTF-8 bytes and 2048 model tokens.             |
| Document-search input        | 480 UTF-8 bytes before model prefix and 512 tokens. |
| Source file                  | 1000000 bytes.                                      |
| Source reads per preparation | 100000000 bytes, including rereads.                 |

The Nanocl template allows five minutes for graph preparation and one hour for
embeddings, with four embedding CPU threads. Total preparation, including source
synchronization and both corpora, still has a one-hour ceiling. Smaller configured
budgets apply within it. The TOML embedding default remains ten minutes.

Long symbols and sections are split into `partial` fragments. Shorten oversized
queries. Unsafe paths, invalid UTF-8, and exceeded corpus limits fail preparation
rather than publishing a partial index. Tool responses report output truncation.

`RAZBOR_EMBEDDINGS_TOKEN` must contain at least 32 printable ASCII characters
without whitespace. For graph-only operation, omit `[embeddings]`. Standalone
embeddings require provisioned models, PostgreSQL's `vector` extension, and
`pnpm run db:migrate` plus `pnpm run db:migrate:embeddings` with migration
credentials before startup.

## Troubleshooting

| Problem                              | Action                                                                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Index unavailable                    | Fix the credential, branch, storage, or limit error in indexer logs, then refresh.                                                              |
| Indexing timeout                     | Use **Retry indexing** after the request finishes. Completed vectors remain cached; partial preparation does not report readiness.              |
| Graph deadline after a branch update | Retry an explicit refresh. Codebase Memory v0.11.0 has a watcher-initialization timing issue; refresh opens a backend at the current commit.    |
| First-start embedding failure        | Check `embedding-model` and `embeddings` logs. Downloads need internet; serving needs verified local bundles and the same token as the indexer. |
| Rejected local artifacts             | Remove symlinks, `.codebase-memory/`, or `.codebase-memory.json` from upstream source as appropriate. Do not bypass the check.                  |
| Growing disk usage                   | Use a bounded filesystem; the active-review limit is not a disk quota.                                                                          |

Indexing does not run repository scripts, install dependencies, hydrate LFS or
submodules, or push commits. Delete indexes through
**Repository Settings → Delete repository**. See [data and recovery](persistence.md)
and [tests](../tests/README.md).
