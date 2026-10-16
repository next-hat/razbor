# Getting started

Run the development stack with Docker Compose, connect a repository, and request
your first review. For release images, use the [deployment guide](deployment.md).

## Before you start

You need:

- A **Linux amd64** machine with hardware virtualization enabled. The bundled
  Codebase Memory download currently supports this architecture only.
- **Docker Engine 26+**, Docker Compose, and the **Kata** runtime registered with
  Docker. Kata runs the review worker inside a virtual machine.
- Git, Bash, curl, and OpenSSL for the setup commands below.
- A model endpoint that supports the non-streaming OpenAI Responses or Anthropic Messages API, its model
  name, and an API key.
- A repository you can configure on Forgejo, GitHub, or GitLab. For GitHub, create
  your own GitHub App through Razbor or supply a token for manual webhook setup.
  Forgejo and GitLab need a bot token with the
  [required permissions](comment-reviews.md#provider-permissions).
- An HTTPS address that your forge can reach to deliver webhooks. A webhook is
  the notification sent to Razbor when someone comments or pushes code.

You only need **Node.js 24** and **pnpm 12.11.2** on the host if you want to develop
Razbor or run its CLI directly. Compose supplies Node; its dependency installer
bootstraps pinned pnpm, and the services run the installed dependencies directly.

## Install the development stack

Run these commands on the machine that will host Razbor.

### 1. Get the code and prepare Docker

```sh
git clone https://git.next-hat.com/next-hat/razbor.git
cd razbor
cp .env.example .env
```

If Kata is already installed, check that `kata` appears in:

```sh
docker info --format '{{json .Runtimes}}'
```

On Ubuntu 24.04 with Docker running, the included installer can set it up:

```sh
bash scripts/install-kata.sh --help
sudo bash scripts/install-kata.sh
```

The installer downloads Kata 4.2.0, backs up and updates Docker's configuration,
and reloads Docker. Compose does not install Kata for you.

### 2. Fill in `.env`

Open `.env` in your editor. Generate a **different value for each** of these five
settings by running `openssl rand -hex 32` five times:

```text
RAZBOR_DB_BOOTSTRAP_PASSWORD
RAZBOR_DB_MIGRATION_PASSWORD
RAZBOR_DB_RUNTIME_PASSWORD
RAZBOR_INDEX_MANAGEMENT_TOKEN
RAZBOR_EMBEDDINGS_TOKEN
```

Paste each value after the matching `=`. These are internal service credentials;
keep the file private and reuse it when restarting.

Uncomment `RAZBOR_ADMIN_PASSWORD` and set a password of at least 12 characters
for your first console login. The default username is `admin`.

Leave the storage paths at their defaults for this walkthrough, then prepare
them and download Codebase Memory, the tool used to index repository code:

```sh
mkdir -p "$HOME/.local/share/razbor/jobs" "$HOME/.local/share/razbor/index"
bash scripts/provision-cbm.sh "$HOME/.local/share/razbor/cbm"
```

The script checks the download against its pinned checksum. These directories
must stay outside the checkout. The runner and indexer use UID/GID 1000 by
default; if your user has a different ID, follow the
[storage setup](runner.md) before starting.

### 3. Start the services and sign in

```sh
docker compose up --build -d
docker compose ps -a
```

The first start downloads images and local search models, installs dependencies,
and applies database migrations. It can take a while. Setup services such as
`dependencies`, `migrate`, and `embedding-model` exit after finishing; an exit
code of `0` is expected for them.

Open **[http://127.0.0.1:3000](http://127.0.0.1:3000)** on the host and sign in as
`admin` with the password you set. If you left the password empty, use
`admin/admin` and change it when prompted. If Razbor is on another machine,
forward port 3000 over SSH to reach its loopback-only console.

Changing the bootstrap password in `.env` later does not reset an existing
account. A super admin can reset passwords in **Users**. The bootstrap account has the `super_admin` role.

Use the account switcher at the top left to manage personal resources or an
organization. Every user can create an organization. Org admins invite existing
accounts and choose their role and repository access; members start with no
repository access by default. Members can view pull requests and review history
and trigger reviews for granted repositories. See the
[account and ownership guide](persistence.md#accounts-and-resource-ownership)
for the full role permissions and migration behavior.

If startup fails, inspect the service that failed:

```sh
docker compose logs --tail=100 web runner indexer
```

For `unknown runtime kata`, finish step 1. For a missing resolver file, see the
[runner guide](runner.md). For an indexing or model-download error, see
[indexing and search](indexing.md).

### 4. Connect your model and repository

1. Open **Agents → Add agent**. Choose OpenAI or Anthropic and enter the complete
   API URL ending in `/responses` or `/messages`, respectively, the model
   identifier, and its API key. Here, an _agent_ is the
   saved model connection used to review code.
2. Set up an HTTPS callback address using the
   [webhook proxy example](comment-reviews.md#public-webhook-proxy). Your
   forge must be able to reach it; `localhost` on your machine will not work for
   a hosted forge.
3. Open **Repositories → Connect repository** and choose your forge. For GitHub,
   the recommended App flow creates a private GitHub App that you own for this
   deployment: approve its creation on GitHub, install it, then select a repository.
   You can reuse an App already saved in this instance. Alternatively, choose
   manual webhook setup and check access using a repository URL and token.
   Forgejo and GitLab keep their token-based setup. Choose an agent, enter the
   callback address and allowed command senders, then confirm. Razbor starts
   indexing. See the [provider setup guide](comment-reviews.md) for details.
4. For manual GitHub setup, copy the URL, events, and one-time secret from the
   finish screen into GitHub's repository webhook settings, then send or redeliver
   its ping. App webhooks are configured during App creation; Forgejo and GitLab
   hooks are configured automatically. In **Set up a runner**, manage **Local
   Compose runner** and save the preselected repository,
   or register a new runner and run its enrollment command on the runner host.
   A runner is the worker that executes reviews; Compose initially creates it
   with no repository assignments.
5. Follow the setup checklist: the index and webhook must be ready, and a
   configured reviewer and available assigned runner are needed for reviews.
   Webhook delivery is reported separately after the first event arrives.

Normal setup uses the console; you do not need to copy or edit the example TOML
files. To run reviews on a second machine, follow [runner enrollment](runner.md).

### 5. Request your first review

Open a pull request or merge request in the connected repository. As one of the
allowed senders, post a new comment with `/agentic_review` on its first line.

The bot acknowledges the request, and the console shows its progress. When it
finishes, the summary and findings appear on the pull request or merge request.
This step calls your configured model and may incur charges from that provider.

Reply in a finding's thread to discuss it. After pushing a fix, post the same
review command again to check the new changes and reassess earlier findings.
See [reviews and replies](comment-reviews.md) if the command is ignored or
the result does not appear.

## Follow pull requests

**Overview** shows open pull requests waiting for human review. **Pull requests**
lets you search open and closed requests, inspect findings, and open earlier review
runs. Opening either page or choosing **Refresh** checks the forge for current
requests. An automated review does not remove a request from the human queue.

## Stop and restart

```sh
docker compose stop
docker compose up -d
```

Keep `.env`, the job and index directories, and Docker volumes. They contain
credentials, runner identity, and review history. **`docker compose down -v`
deletes persistent volumes.** See [storage and recovery](persistence.md)
before resetting or moving an installation.

## Accounts and access

Administrators manage repositories, agents, runners, and accounts. In **Users**,
create an account and assign the repositories it may view. Ordinary users can
read reviews and statistics for those repositories. There is no public signup
or email password reset.

For login through an identity provider, use the
[single sign-on instructions](persistence.md#single-sign-on).

The app binds to loopback by default. Use HTTPS when exposing it, and preserve
the original `Host` header and `X-Forwarded-Proto: https` at your proxy. A
callback-only proxy can expose just the webhook routes and, for remote runners,
the authenticated runner routes.

Repository tokens, GitHub App private keys, model keys, webhook secrets, and MCP
bearer tokens are stored in PostgreSQL as plaintext. Protect the database and its
backups. GitHub App credentials belong to your instance; no central Razbor
service is required. Only enroll
runner hosts you trust: they receive repository source. The default review flow
does not automatically run repository tests or installation scripts. Reviewers
can use [command tools](verification-tools.md) within the job's permissions.

## Local commands

Use Node.js 24 and pnpm 12.11.2 for commands run directly on the host. Install
dependencies with `pnpm install --frozen-lockfile`. If pnpm is unavailable, use
`npx --yes pnpm@12.11.2` in its place.

To submit committed revisions from a local checkout:

```sh
pnpm run submit my-project /path/to/checkout main HEAD
```

Replace `my-project` with the registered repository key. This operator command
needs `RAZBOR_DATABASE_URL` or `RAZBOR_DATABASE_URL_FILE` in its process
environment, with private database connectivity. It does not load `.env`
automatically or include uncommitted changes. See the
[administration guide](persistence.md) for more CLI commands.

The standalone `pnpm run agent` command needs `LLM_BASE_URL`, `LLM_MODEL`, and
`LLM_API_KEY`, with optional `LLM_PROVIDER` (`openai`, the default, or `anthropic`)
and `LLM_REASONING_EFFORT`. These host CLI settings are
separate from agents saved in the console; the Compose setup does not need them.
