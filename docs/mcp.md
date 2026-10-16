# Connect an MCP server

MCP (Model Context Protocol) servers add tools to a reviewer, such as documentation
search. razbor connects over Streamable HTTP to a server you already run. It
must be reachable from the web application.

## Set up a connection

1. Select the owning personal account or organization, then open **MCP servers →
   Connect server**.
2. Enter the HTTP or HTTPS endpoint and, if required, a bearer token.
3. Save and choose **Test connection**. This discovers tools and validates their
   input schemas without running them.
4. Select the server under a repository's **Settings → MCP access**.
5. Start a new review.

Saving a connection does not grant repository access. Each repository can select
up to 16 servers from its own account or organization. A selection grants access
to every tool that server advertises.

razbor supports tools only. It does not start MCP processes, accept stdio
commands, or fetch server-provided resource links. Authentication is a bearer
token or no token.

## Change or revoke access

Reviews save their server selections at submission. New grants affect new reviews;
already queued reviews keep their original selection.

Removing a grant, disabling a server, or deleting it blocks future calls from
queued and running reviews. Deletion also removes repository selections.
Revocation cannot undo a request already sent to the server.

When editing credentials, leave the token blank to keep it, enter a replacement,
or explicitly remove it. Tokens must be printable ASCII and at most 8,192
characters after trimming. You can test a disabled connection.

## Credentials and permissions

Personal owners, organization admins, and organization moderators can manage
servers and repository selections in their context. Super admins can manage all
contexts. Organization members can trigger reviews for granted repositories but
cannot change MCP configuration.

The server's credentials determine what its tools can read or change. Choose
credentials suitable for every repository that will use the connection.

Bearer tokens are stored as plaintext in PostgreSQL. They are excluded from
management API responses, queued jobs, and runner assignments. The agent uses a
temporary review token through the runner relay and web application. Each review
attempt has a separate remote session for each connection.

## Connection limits

| Setting                    | Limit or behavior                                              |
| -------------------------- | -------------------------------------------------------------- |
| Tool discovery             | Up to 100 tools per server                                     |
| Input schemas              | JSON Schema 2020-12 by default; explicit draft-07 is supported |
| Setup and request deadline | 15 seconds                                                     |
| Protocol request body      | 64 KiB                                                         |
| Protocol response          | 1 MiB                                                          |
| Response format            | JSON or server-sent events (SSE)                               |
| Redirects                  | Rejected                                                       |

Tool text is also subject to the configured capability output limit. If a selected
server cannot initialize, review capability startup fails. Check the endpoint,
web application's network access, credentials, and **Test connection** result
before retrying.

## Management API

| Endpoint                     | Purpose                                |
| ---------------------------- | -------------------------------------- |
| `/api/mcp`                   | List or create servers                 |
| `/api/mcp/<id>`              | Read settings, edit or delete a server |
| `/api/mcp/<id>/test`         | Test a saved connection                |
| `/api/repositories/<id>/mcp` | Read or replace repository selections  |

On upgrade, apply the database migrations and update the web application and
runner together. See [runner operations](runner.md).
