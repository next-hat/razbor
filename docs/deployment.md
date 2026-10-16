# Production deployment

Use the production Dockerfiles in `docker/` and either the
[Compose example](../deploy/docker/docker-compose.yml) or the
[Nanocl statefiles](../deploy/nanocl/). The root `compose.yml` is the development
stack.

Release images target Linux amd64. They include production dependencies, the
pinned Codebase Memory bundle, and verified embedding models; startup does not
download these artifacts. The web image runs Next.js standalone output.

## Build and publish

With Docker Buildx installed, choose a release tag and build from the checkout:

```sh
export RAZBOR_IMAGE_TAG=YOUR_RELEASE_TAG
bash scripts/publish-images.sh --tag "$RAZBOR_IMAGE_TAG"
```

The script builds six images, one at a time, and loads them into Docker. Append
service names to build a subset, such as `web indexer`. It reuses BuildKit layers
and the matching registry tag as cache sources. Use a new tag for each release.

To publish:

```sh
docker login ghcr.io --username YOUR_GITHUB_USERNAME
bash scripts/publish-images.sh --tag "$RAZBOR_IMAGE_TAG" --push
```

The script publishes `ghcr.io/next-hat/razbor-{web,indexer,runner,embeddings,postgres,migrate}`
and labels them with the source repository, version, and Git revision. For a fork,
change the image namespace and source labels in the script and Dockerfiles, then
update your deployment files. With an edited worktree, the revision label names
the base commit; the build includes the current files.

For private packages, the publishing account needs package write permission and
the deployment account needs read permission for every image. See
[GitHub's Container registry instructions](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

The committed deployment examples pin web to `0.1.12` and the other services to
`0.1.11`. These are template defaults, not a statement about the latest release.
Choose and publish the tags you intend to deploy, then update all image references.
Upgrade the control plane before runners when a release changes their protocol or
review limits.

## Nanocl 0.18

Copy [razbor-platform.yml](../deploy/nanocl/razbor-platform.yml) and
[razbor-runner.yml](../deploy/nanocl/razbor-runner.yml) to a private directory,
such as `~/razbor-deploy`. Use directory mode `0700` and file mode `0600`.
The completed statefiles contain database, service, and administrator credentials.

Before applying them:

- Install Nanocl **0.18.1+**, Docker **28+**, and ncproxy **0.15.1+** on the
  platform host, with the CLI connected to the intended daemon.
- Generate one distinct value per `__...__` placeholder name, for example with
  `openssl rand -hex 32`. Reuse that value wherever the same name appears, so
  services share the credentials they need. Preserve existing credentials when
  updating; changing a statefile does not rotate passwords in a PostgreSQL volume.
- Set your image names and tags. Create a registry Secret with read access and
  update `ImagePullSecret` if its name differs from `registry.ghcr.io`.
- Replace `razbor.next-hat.com` throughout both copies with your public hostname,
  for example `razbor.example.com`. This includes the callback origin, runner URL,
  and ncproxy resource name and domain. Replace `cert.next-hat.com` with your TLS
  certificate Secret. Point DNS at ncproxy and use a certificate covering the host.
- Prepare persistent storage for PostgreSQL, indexes, and review jobs.
- On the runner host, install hardware virtualization and the **`kata`** Docker
  runtime. Its resolver bind must point to a real file containing reachable,
  non-loopback DNS servers. The default is `/run/systemd/resolve/resolv.conf`.
  See [runner isolation](runner.md#storage-and-isolation).

For an existing installation, back up PostgreSQL and stop its cargo before
updating the database image. Nanocl's candidate rollout must not start a second
database process against the same volume. Plan downtime for this step.

Apply the platform on its target daemon:

```sh
cd ~/razbor-deploy
nanocl state apply -s razbor-platform.yml
```

The platform creates its network and volumes, initializes database roles and
pgvector for a new database, and runs migrations before starting the console.
The indexer waits for the migration journals and receives its configuration from
an init container. Only the console is exposed through ncproxy; PostgreSQL,
embeddings, and index management stay private.

Open `https://razbor.example.com` and sign in with the bootstrap administrator
credentials from your statefile. Create a runner in **Runners** and copy its
one-time enrollment token. Apply the runner on its target daemon:

```sh
nanocl state apply -s razbor-runner.yml -- --enrollment-token YOUR_ONE_TIME_TOKEN
```

The runner receives its enrollment token without database, administrator,
index-management, or model credentials. Its saved identity lives in the named
volume under `/job-data/runner-state`. Keep that volume across updates; subsequent
applies can omit the token:

```sh
nanocl state apply -s razbor-runner.yml
```

A fresh volume needs a fresh token. A consumed token cannot enroll a replacement
identity.

Follow [model and repository setup](getting-started.md#4-connect-your-model-and-repository),
assign the runner, and check that the webhook and index are ready. Verify a
completed review before accepting the deployment.

These statefiles run the platform on one host with an independently enrolled
runner. Back up PostgreSQL, private statefiles, and runner storage. Preserving
the index volume avoids a rebuild after a restart.

## Production Compose example

The production Compose file creates its own project volumes. It does not migrate
an existing Nanocl database or runner identity. Keep that deployment's volumes
until you have planned and verified a storage migration.

Create a private environment file outside the checkout, for example
`~/razbor-deploy/compose.env`:

```dotenv
RAZBOR_IMAGE_TAG=0.1.11
RAZBOR_WEB_IMAGE_TAG=0.1.12
RAZBOR_PUBLIC_URL=https://razbor.example.com
RAZBOR_ADMIN_USERNAME=admin
RAZBOR_ADMIN_PASSWORD=REPLACE_WITH_A_PRIVATE_PASSWORD
RAZBOR_DB_BOOTSTRAP_PASSWORD=REPLACE_WITH_A_DISTINCT_HEX_SECRET
RAZBOR_DB_MIGRATION_PASSWORD=REPLACE_WITH_A_DISTINCT_HEX_SECRET
RAZBOR_DB_RUNTIME_PASSWORD=REPLACE_WITH_A_DISTINCT_HEX_SECRET
RAZBOR_INDEX_MANAGEMENT_TOKEN=REPLACE_WITH_A_DISTINCT_HEX_SECRET
RAZBOR_EMBEDDINGS_TOKEN=REPLACE_WITH_A_DISTINCT_HEX_SECRET
```

Choose image tags for your release. The file currently uses the example's pins;
the image namespace is set in the Compose file itself. For a new installation,
generate a separate value with `openssl rand -hex 32` for each password and token.
Hex values avoid database-URL escaping. For an existing database, preserve its
credentials. Set the file to mode `0600`, authenticate to your registry if needed,
and run from the checkout:

```sh
docker compose --env-file "$HOME/razbor-deploy/compose.env" -f deploy/docker/docker-compose.yml up -d
docker compose --env-file "$HOME/razbor-deploy/compose.env" -f deploy/docker/docker-compose.yml ps -a
```

The `migrate` service should exit with code `0`. The web service binds to loopback
port 3000. Put an HTTPS proxy in front of it, preserving `Host` and
`X-Forwarded-Proto: https`. This example does not install a proxy or certificate.

Create a runner in the console, set `RAZBOR_RUNNER_ENROLLMENT_TOKEN` in the
private environment file, then start the optional runner profile:

```sh
docker compose --env-file "$HOME/razbor-deploy/compose.env" -f deploy/docker/docker-compose.yml --profile runner up -d
```

The runner needs Kata. Set `RAZBOR_RUNNER_RESOLV_CONF` if your resolver file is
not `/run/systemd/resolve/resolv.conf`. Set `RAZBOR_RUNNER_NETWORK_PREFIX` if
`172.30.251.0/24` overlaps another network. This local profile permits HTTP on its
private control network; use HTTPS for a remote runner.

The indexer config defaults to `config/indexer.example.toml` in the checkout.
Set `RAZBOR_INDEX_CONFIG` to an absolute path for a custom file. Relative paths
resolve from `deploy/docker`; if you copy the Compose file elsewhere, update the
default mount or use an absolute path.

Named volumes preserve PostgreSQL, indexes, and runner identity. No host Docker
socket or source/dependency bind is mounted. Do not run `docker compose down -v`
on data you need. Follow [storage and recovery](persistence.md) for backups and
restores.
