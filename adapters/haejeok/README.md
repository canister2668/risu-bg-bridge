# HaejeokRisuAI b6704 adapter

This beta adapter is a scoped source patch for:

- upstream: <https://github.com/nevaeh5379/HaejeokRisuai>
- tag: `b6704`
- commit: `0329f44199e93103ba07a247df5e831173f02039`
- resulting adapter identity: `b6704+bg1`

It adds durable main/aux model jobs, restart recovery, typed event/result APIs,
delivery leases, result finalization, server-side provider references, and the
API v3 `backgroundModels` host bridge used by the public plugin.

The patch deliberately excludes unrelated local UI, asset-cache, S3 tuning,
and `/api/read` changes.

## Apply

Back up the database, asset storage, and server configuration first. Start
from a clean checkout and verify the exact source identity:

```bash
git clone https://github.com/nevaeh5379/HaejeokRisuai.git
cd HaejeokRisuai
git checkout b6704
test "$(git rev-parse HEAD)" = "0329f44199e93103ba07a247df5e831173f02039"
git apply --check /path/to/haejeok-b6704-bg1.patch
git apply /path/to/haejeok-b6704-bg1.patch
pnpm install --frozen-lockfile
pnpm test:node
pnpm exec vitest run src/ts/network/durableModelJobs.test.ts src/ts/plugins/apiV3/backgroundModels.test.ts src/ts/process/modelJobRecovery.test.ts
pnpm run check
pnpm run build
```

Do not force the patch onto a different commit. Rebase and revalidate it when
HaejeokRisuAI changes.

## Server provider registry

Plugin-created jobs become available only when the server has a valid
`RISU_BG_PROVIDER_REGISTRY` or `RISU_BG_PROVIDER_REGISTRY_FILE`. The registry
contains provider metadata and the name of a secret environment variable,
never the secret itself. See the repository-level `PUBLIC-PACKAGING.md`.

Without the registry, built-in Haejeok background jobs remain available while
the host honestly reports `pluginJobCreation:false` and
`serverProviders:false`.
