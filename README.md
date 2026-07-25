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
    "env": {
      "SUB2API_BASE_URL": "https://your-sub2api-host",
      "SUB2API_API": "auto"
    }
  }
}
```

```bash
chmod 600 ~/.pi/agent/auth.json
```

- `key` — an API key generated in the sub2api dashboard.
- `env.SUB2API_BASE_URL` — the gateway base URL, **without** a trailing `/v1`. Defaults to
  `http://localhost:8080`.
- `env.SUB2API_API` — wire protocol: `auto` (default), `anthropic`, or `openai`. See
  [Protocol](#protocol).

pi resolves the key from `auth.json["sub2api"]` for inference; the extension reads the same entry
for its own `/v1/models` and `/v1/usage` calls. `SUB2API_KEY` / `SUB2API_BASE_URL` / `SUB2API_API`
environment variables are used as a fallback if the `auth.json` entry is absent.

## Protocol

sub2api dispatches on the platform of the API key's group, not on the request path. An
Anthropic-account key serves `/v1/messages` natively and translates `/v1/chat/completions` down to
it; an OpenAI-account key does the reverse. The non-native path costs a translation hop, and each
side has a group flag that closes it outright:

- `claude_code_only` — rejects `/v1/chat/completions` with a 403.
- `allow_messages_dispatch` — an OpenAI group rejects `/v1/messages` unless this is on. **It
  defaults to off**, so an OpenAI group that serves Claude model ids will not accept the Anthropic
  protocol until an admin enables it.

So each model is registered on the protocol native to it:

| Model id | pi API | Endpoint |
| --- | --- | --- |
| `claude-*` | `anthropic-messages` | `POST {BASE}/v1/messages` |
| everything else | `openai-completions` | `POST {BASE}/v1/chat/completions` |

Because nothing in `/v1/models` reveals the group's platform, the extension confirms the choice
with the gateway before registering: when the model list contains a Claude id, it sends one
`POST /v1/messages/count_tokens` (gated by the same flag, takes no concurrency slot, records no
usage). Only an explicit *"This group does not allow /v1/messages dispatch"* moves everything to
`openai-completions` — any other outcome, including an unreachable gateway, leaves the native
protocol in place.

Set `SUB2API_API` to `anthropic` or `openai` to skip that check and force one protocol for every
model. Forcing changes only the endpoint and payload format — per-model context and output limits
still follow the model.

## Use

```bash
pi --list-models                                  # models appear under the sub2api provider
pi --provider sub2api --model gpt-5.5
pi --provider sub2api --model claude-opus-4-7
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

- **API type**: `openai-responses` and `openai-codex-responses` did not work against this gateway,
  so the OpenAI side stays on `openai-completions`. See [Protocol](#protocol).
- **Cost**: pi's per-token `cost` is set to `0`, because sub2api's `/v1/models` returns no pricing.
  Cost comes from the gateway's own accounting via `/usage`, not from pi's estimate.
- **Model list**: embedding and image-generation models are filtered out; only chat-capable models
  are registered.
- **Thinking levels**: on the OpenAI path, reasoning models expose `off/low/medium/high/xhigh`;
  `minimal` is marked unsupported because the upstream rejects `reasoning_effort: "minimal"`.
- **Model metadata**: the gateway's model list reports no per-model limits, so `contextWindow` and
  `maxTokens` come from a table keyed on the model id — Claude generations mirror pi's built-in
  Anthropic values, and everything else gets 400000/128000. Claude ids newer than that table get
  their generation's context window with a conservative output cap: an under-declared `maxTokens`
  only shortens replies, while an over-declared one is a hard 400.

## License

MIT
