<p align="center">
  <img src="apps/web/public/logo.png" alt="razbor" width="128" />
</p>

<h1 align="center">razbor</h1>

<p align="center">Self-hosted AI code reviews for Forgejo, GitHub, and GitLab.</p>

Connect a repository, choose your model, and request a review with a comment:

```text
/agentic_review
```

Razbor checks the diff and surrounding code, then posts a summary and inline
findings. Reply to a finding to discuss it, or request another review after pushing
a fix. The web console keeps pull requests, review history, and worker status in
one place.

- **Bring your model.** Connect an OpenAI Responses or Anthropic Messages endpoint.
- **Give it context.** Add repository instructions, reusable skills, and shared
  review notes. Codebase Memory and optional semantic search help it explore code.
- **Connect your tools.** Grant repositories access to selected MCP servers.
- **Run on your infrastructure.** Workers use Kata isolation. Source is checked
  out locally; relevant code and context go to your configured model endpoint.

## Get started

The full stack needs Linux amd64, Docker, and the Kata runtime, plus a model
endpoint and a repository you can configure. Your forge must be able to reach
Razbor over HTTPS to deliver webhooks.

Follow [Getting started](docs/getting-started.md) to run the development stack and
request your first review. For release images, use the
[deployment guide](docs/deployment.md), with Docker Compose and Nanocl examples.

## Documentation

| Guide                                             | Covers                                             |
| ------------------------------------------------- | -------------------------------------------------- |
| [Reviews and webhooks](docs/comment-reviews.md)   | Forge setup, commands, findings, and replies       |
| [Runners](docs/runner.md)                         | Enrollment, isolation, capacity, and job limits    |
| [Storage and administration](docs/persistence.md) | Accounts, credentials, backups, and recovery       |
| [Indexing and search](docs/indexing.md)           | Codebase Memory, embeddings, and troubleshooting   |
| [Instructions and skills](docs/skills.md)         | Project guidance and reusable review skills        |
| [Review memory](docs/memory.md)                   | Notes shared by people and reviewers               |
| [MCP servers](docs/mcp.md)                        | External tools and repository access               |
| [Verification tools](docs/verification-tools.md)  | Command execution and web access                   |
| [Metrics](docs/review-metrics.md)                 | Activity, token usage, and finding assessments     |
| [Review evaluation](docs/review-evaluation.md)    | Compare recorded results against audited revisions |

## Development

Use Node.js 24 and pnpm 12.11.2. Read [AGENTS.md](AGENTS.md) for conventions and
the [test guide](tests/README.md) for integration checks and prerequisites.

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm test
```

Report bugs in the [issue tracker](https://git.next-hat.com/next-hat/razbor/issues)
with reproduction steps and logs stripped of credentials and private source.

## License

[Apache 2.0](LICENSE).
