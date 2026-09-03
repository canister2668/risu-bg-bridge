# Risu Background Bridge public package

## Install

Import `release/risu-bg-bridge-v0.9.0-beta.1.plugin.js` from RisuAI Settings →
Plugins. The plugin is API v3 and requests provider/background-model
permission only through the host API.

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
