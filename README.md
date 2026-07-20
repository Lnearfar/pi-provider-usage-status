# pi-provider-usage-status

A lightweight [Pi](https://github.com/earendil-works/pi-mono) extension that displays the active provider's account usage in Pi's footer.

## Features

- **OpenAI Codex:** shows the remaining or used percentage, rate-limit window, and reset countdown.
- **Codex Spark:** automatically selects the dedicated Spark rate-limit bucket.
- **DeepSeek:** shows the current API balance.
- Refreshes Codex usage every 60 seconds and after each turn.
- Refreshes DeepSeek balance after each turn, with a 30-second cooldown.
- Keeps credentials local and reads them from Pi's existing authentication store.

## Install

```bash
pi install git:github.com/Lnearfar/pi-provider-usage-status
```

Restart Pi after installation. To try it without installing:

```bash
pi -e git:github.com/Lnearfar/pi-provider-usage-status
```

## Authentication

### Codex

Sign in to the `openai-codex` provider through Pi. The extension reads the OAuth access token and account ID from Pi's existing `auth.json`; it does not store a separate copy.

### DeepSeek

Configure the `deepseek` provider in Pi with a valid API key. The extension obtains the key through Pi's model registry.

## Usage

The status appears automatically when the active model belongs to a supported provider. It is hidden for other providers.

Codex percentage display defaults to remaining quota. Change it with:

```text
/codex-usage-mode left
/codex-usage-mode used
/codex-usage-mode toggle
```

The preference is stored under `pi-codex-usage` in Pi's `settings.json`.

## Update or remove

```bash
pi update git:github.com/Lnearfar/pi-provider-usage-status
pi remove git:github.com/Lnearfar/pi-provider-usage-status
```

## Privacy

The extension sends requests only to the provider endpoints needed for the displayed data:

- `https://chatgpt.com/backend-api/wham/usage`
- `https://api.deepseek.com/user/balance`

No credentials or usage data are written to this repository or sent elsewhere.

## Development

```bash
git clone https://github.com/Lnearfar/pi-provider-usage-status.git
cd pi-provider-usage-status
npm install
npm run check
pi -e ./index.ts
```

## License

[MIT](LICENSE)
