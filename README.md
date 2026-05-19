# newsletter-to-dropbox

A Cloudflare Email Worker that converts any email newsletter to EPUB and uploads it to Dropbox, where your Kobo picks it up automatically.

## How it works

```
Newsletter email → your@yourdomain.com (Cloudflare Email Routing)
  → Cloudflare Worker (parse + build EPUB)
  → Dropbox (your Kobo-synced folder)
  → Kobo Libra Color
```

## Setup

### 1. Dropbox API token

1. Go to [dropbox.com/developers](https://www.dropbox.com/developers) → **Create App**
2. Choose **Scoped Access** → **Full Dropbox**
3. Under **Permissions**, enable `files.content.write`
4. Under **Settings**, generate an **Access Token**

### 2. Deploy the worker

```bash
npm install
wrangler secret put DROPBOX_ACCESS_TOKEN   # paste your token when prompted
wrangler deploy
```

### 3. Cloudflare Email Routing

1. Cloudflare dashboard → your domain → **Email** → **Email Routing**
2. Create an address e.g. `newsletters@yourdomain.com`
3. Set action: **Send to Worker** → `newsletter-to-kobo`

### 4. Forward your newsletters

In Gmail, create a filter for each newsletter:
- **From**: `morningbrew@email.morningbrew.com`
- **Action**: Forward to `newsletters@yourdomain.com`

Repeat for each newsletter you want on your Kobo.

### 5. Kobo Dropbox sync

On your Kobo Libra Color:
- **Settings** → **Dropbox** → link your account
- Point it at the same folder as `DROPBOX_FOLDER` (default: `/KoboReader`)

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DROPBOX_ACCESS_TOKEN` | ✅ | Dropbox API token (set as secret) |
| `DROPBOX_FOLDER` | No | Dropbox path for EPUBs. Default: `/KoboReader` |
| `ALLOWED_SENDERS` | No | Comma-separated sender emails to accept. If omitted, all senders are accepted. |
| `BLOCKED_SENDERS` | No | Comma-separated sender emails to always reject. |

## Adding or removing newsletters

- **Add**: Create a Gmail forward filter for the new sender → `newsletters@yourdomain.com`
- **Allowlist** (optional): Add the sender to `ALLOWED_SENDERS` in `wrangler.toml` or the Cloudflare dashboard
- **Block**: Add the sender to `BLOCKED_SENDERS`

## Local development

Create `.dev.vars` (gitignored):
```
DROPBOX_ACCESS_TOKEN=your_token_here
DROPBOX_FOLDER=/KoboReader
ALLOWED_SENDERS=morningbrew@email.morningbrew.com
```

Then run:
```bash
wrangler dev
```

## GitHub Actions deployment

Add `CLOUDFLARE_API_TOKEN` to your GitHub repo secrets, then push to `main` to trigger a deploy.
Generate the token at: Cloudflare dashboard → My Profile → API Tokens → **Edit Cloudflare Workers** template.