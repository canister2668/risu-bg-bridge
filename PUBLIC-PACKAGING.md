# Risu Background Bridge public package

## Install

Import `release/risu-bg-bridge-v0.9.0-beta.2.plugin.js` from RisuAI Settings →
Plugins. The plugin is API v3 and requests provider/background-model
permission only through the host API.

## Updates

Starting with `0.9.0-beta.2`, the plugin declares a canonical HTTPS
`//@update-url`. RisuAI checks the first 512 bytes of that URL, compares the
`//@version`, and displays its native update button in Settings → Plugins when
a newer version exists. Installation is still confirmed by the user and the
internal plugin name remains fixed as `risu_bg_bridge`.

RisuAI's comparator is numeric-dot based rather than full SemVer. Therefore the
beta.2 release advertises updater version `0.9.0.2` while the package and Git
tag remain `0.9.0-beta.2`. This orders correctly after beta.1's effective
`0.9.0.1` value and before a future `1.0.0` release.

The plugin's own dashboard also displays the update state. It never silently
installs downloaded code: the action points back to RisuAI's native confirmed
update flow and the signed-off GitHub releases page.

The adjacent host-status card distinguishes three cases:

- **READY**: durable plugin jobs and server providers are available.
- **SETUP**: the host patch is present, but the administrator still needs to
  configure the server provider registry.
- **PATCH**: no durable host bridge was negotiated; the exact-version adapter
  guide is exposed instead of pretending that the plugin alone can survive a
  closed tab.

Users of `0.9.0-beta.1` must import `0.9.0-beta.2` manually once because the
older artifact did not yet contain an update URL. Subsequent versions can use
RisuAI's native updater.

This is a beta release. Back up the RisuAI database and server configuration
before applying a host patch. The plugin alone cannot make foreground model
execution survive a closed browser tab; that requires one of the compatible
server adapters in this repository.

## Host modes

- Haejeok `b6704+bg1`: configure a server provider registry, then set the
  plugin's `credential_ref` and `model`. Provider credentials remain on the
  server; the plugin receives neither `risu-auth` nor API keys.
- PocketRisu 1.10.0: build the pinned derived image from
  `generated/pocket-1.10.0-bgbridge`. Its bridge supplies transport and
  durable job semantics but does not invent server-side provider secrets.
- Stock RisuAI: set `fallback_model` to a built-in model identifier. Calls run
  through `runLLMModel` in the foreground and therefore do not survive tab
  closure.

## Haejeok server provider registry

Set `RISU_BG_PROVIDER_REGISTRY_FILE` to an administrator-owned JSON file and
store the actual secret in the environment variable named by `secretEnv`.
Never put the secret value in the registry file or plugin arguments.

```json
[
  {
    "credentialRef": "provider-account://openai/default",
    "targetUrl": "https://api.openai.com/v1/chat/completions",
    "protocol": "openai",
    "secretEnv": "RISU_BG_OPENAI_KEY",
    "authHeader": "authorization",
    "authPrefix": "Bearer ",
    "idempotent": false
  }
]
```

The host reports `pluginJobCreation:false` and `serverProviders:false` until
the registry parses successfully and every referenced environment secret is
present. This is intentional fail-closed behavior.
