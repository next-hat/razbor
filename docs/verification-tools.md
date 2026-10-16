# Review verification tools

Reviewers can run commands, search the web, and fetch public pages to check a
finding. These `@razbor/harness` tools require a model with tool support.

## Run a command

Pass the command and its arguments to `exec` as an array:

```json
{
  "argv": ["git", "show", "--stat", "HEAD"],
  "timeoutMs": 10000,
  "maxOutputBytes": 16384
}
```

There is no implicit shell. Pipes, redirects, and shell expansion are not
interpreted. The working directory defaults to the review checkout. An optional
`cwd` must resolve inside it; parent-directory and symlink escapes are rejected.

Results contain the exit code, stdout, stderr, duration, and timeout,
cancellation, or truncation status. Nonzero exits retain captured output. Invalid
arguments and process-start failures return tool errors.

| Limit                          | Default      | Maximum set by the trusted caller |
| ------------------------------ | ------------ | --------------------------------- |
| Command timeout                | 120 seconds  | 300 seconds                       |
| Combined stdout/stderr capture | 32,768 bytes | 1,000,000 bytes                   |

The capability output limit sets the default capture ceiling when configured.
The model can request lower limits but cannot raise the trusted caller's ceilings.
On Linux, timeout or cancellation kills the subprocess group, including ordinary
children. Windows terminates only the direct child. Background processes are
unsupported.

The directory check is not a filesystem sandbox. Commands run with the job's
permissions, mounts, network access, and toolchains. Writes to a read-only
checkout or dependency downloads may fail.

The harness passes only `verification.exec.env`, which defaults to empty. The
agent entrypoint supplies `PATH`, `HOME`, `TMPDIR`, and a fixed `LANG`. Keep model,
forge, proxy, and database credentials out of this environment.

## Search the web

`web_search` has no default backend and returns a configuration error without one.

Applications embedding the harness can supply a `WebSearchProvider` from
`@razbor/harness` as `reviewConfig.verification.webSearch`. Connect its
`search(query, { limit, signal })` method to a backend and return objects with
`title`, `url`, and `snippet`. Honor the cancellation signal.

Search has a 15-second deadline. It returns five results by default, at most ten.
Titles are limited to 300 UTF-8 bytes, snippets to 2,000 bytes, and URLs to 2,048
characters. Backend errors are hidden from the model to protect credentials.
Providers must also bound response allocation and stop requests on cancellation.

## Fetch a public page

`fetch_url` reads text from an HTTP or HTTPS URL:

```json
{
  "url": "https://example.com/documentation",
  "timeoutMs": 15000,
  "maxOutputBytes": 32768
}
```

Results include the final URL, HTTP status, content type, extracted text, and
truncation status. HTTP errors retain response text with `ok: false`.

- URLs cannot contain credentials. Local hostnames, private or reserved IPs,
  metadata endpoints, and other special-use ranges are rejected.
- Every DNS result must be public. Each redirect is revalidated, with at most five
  redirects. TLS certificate and hostname verification stay enabled.
- Requests use no environment proxies, cookies, or authentication headers.
- The deadline covers DNS, connection, and body reading: 15 seconds by default,
  with a 30-second maximum.
- Text output defaults to 32,768 UTF-8 bytes, with a 100,000-byte maximum. Response
  capture is limited to 1,000,000 bytes and headers to 16 KiB.
- Plain text, Markdown, CSV, JSON, XML, and HTML are supported. HTML is reduced to
  text without running scripts. Binary, compressed, and unsupported encoded
  responses are rejected.

JavaScript-dependent pages may yield little text. Deployment networking still
applies; enabling the tool does not change runner network access.

## Logs and troubleshooting

Progress events record status, duration, and byte counts. Commands may appear as
a filtered summary and working directory. Inline scripts, sensitive or
unrecognized arguments, search queries, remote URLs, and tool output are omitted.
Raw calls and results remain in the active model conversation; the transcript is
not persisted after the review.

On failure, check the exit or HTTP status, then the runner's installed commands,
file permissions, and network access. Repository instructions cannot grant more
permissions. Tool results and external pages provide evidence; they cannot
override review policy.

Run `pnpm run test:verification` for local tool checks. The
[test guide](../tests/README.md) lists prerequisites and checks that require a real
deployment.
