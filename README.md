# pi-sub2api

A [pi](https://pi.dev) extension for a [sub2api](https://github.com/Wei-Shaw/sub2api) gateway.

- Fetches the model list from the gateway at startup and registers it as the `sub2api` provider.
- Adds a `/usage` command showing balance and today/total cost.

## Install

```bash
pi install npm:pi-sub2api
```

Or try it for a single run without installing:

```bash
pi -e npm:pi-sub2api
```

## Configure

All configuration lives in `~/.pi/agent/auth.json` under the provider name `sub2api`. No shell
environment variables are needed.

```json
{
  "sub2api": {
    "type": "api_key",
    "key": "sk-...",
    "env": { "SUB2API_BASE_URL": "https://your-sub2api-host" }
  }
}
```

```bash
chmod 600 ~/.pi/agent/auth.json
```

- `key` — an API key generated in the sub2api dashboard.
- `env.SUB2API_BASE_URL` — the gateway base URL, **without** a trailing `/v1`. Defaults to
  `http://localhost:8080`.

pi resolves the key from `auth.json["sub2api"]` for inference; the extension reads the same entry
for its own `/v1/models` and `/v1/usage` calls. `SUB2API_KEY` / `SUB2API_BASE_URL` environment
variables are used as a fallback if the `auth.json` entry is absent.

## Use

```bash
pi --list-models                                  # models appear under the sub2api provider
pi --provider sub2api --model gpt-5.5
```

In an interactive session, `/usage` prints balance and cost:

```
sub2api usage
  balance  -67.01 USD
  today    $0.27 · 9 req · 57,826 tok
  total    $184.21 · 5,965 req · 105,534,943 tok
  top models (by cost)
    gpt-5.5  $0.27 · 52,300 tok · 4 req
```

## Notes

- **API type**: the provider is registered with `openai-completions`. `openai-responses` and
  `openai-codex-responses` did not work against this gateway.
- **Cost**: pi's per-token `cost` is set to `0`, because sub2api's `/v1/models` returns no pricing.
  Cost comes from the gateway's own accounting via `/usage`, not from pi's estimate.
- **Model list**: embedding and image-generation models are filtered out; only chat-capable models
  are registered.
- **Thinking levels**: reasoning models expose `off/low/medium/high/xhigh`. `minimal` is marked
  unsupported because the upstream rejects `reasoning_effort: "minimal"`.
- **Model metadata**: `contextWindow` and `maxTokens` are set to 400000/128000 for every model,
  since the gateway's model list does not report per-model limits.

## License

MIT
