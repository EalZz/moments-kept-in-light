# Moments Kept in Light

A minimal, dark editorial **photography portfolio** — built and self-hosted on the Cloudflare stack, with a built-in web admin so photos are managed entirely from the browser (no redeploys to add work).

**Live:** https://pht-pp.phtkanez.workers.dev

---

## Features

- **Editorial dark gallery** — collections organized by event, with per-person folders crediting the model (X handle) and character.
- **Viewing modes** — browse by collection, by model (archive), or an all-photos stream with infinite scroll.
- **Cinematic intro** — a gesture-driven hero animation (GPU transforms) that collapses into the main page and returns on pull-up; tuned to stay smooth on mobile.
- **Web-based admin** (`/admin`, password-protected):
  - Drag & drop upload with **in-browser resizing** (`OffscreenCanvas` → WebP) and EXIF extraction.
  - **Tweet import** — pull photos straight from an X post; auto-parses model/character credits.
  - **Grid collage maker** — arrange selected photos into a justified-layout image for sharing.
  - Manual ordering (drag), bulk move/delete, per-collection cover & featured slide.
- **Responsive** — irregular justified grids on desktop, tuned columns on mobile.

## Tech stack

- **Cloudflare Workers** + [Hono](https://hono.dev/) — API & SSR meta tags
- **D1** (SQLite) — collections / photos / groups / models metadata
- **R2** — photo storage
- **Vanilla JS SPA** — hash routing, no framework
- **Wrangler** — local dev & deploy

## Project structure

```
src/worker.js      # Hono backend: API, auth, image proxy, OG meta injection
public/
  index.html       # SPA shell
  app.js           # router, gallery, intro animation
  admin.js         # admin panel (upload, tweet import, grid maker)
  style.css        # dark editorial theme
  config.js        # site name / copy (single source of truth)
wrangler.jsonc     # Workers / D1 / R2 bindings
```

## Local development

```bash
npm install
npx wrangler dev --port 8787
```

Set the admin password for local dev in `.dev.vars` (gitignored):

```
ADMIN_PASSWORD=your-dev-password
```

## Deployment

```bash
npx wrangler deploy
```

Production secrets are stored via Wrangler, not committed:

```bash
npx wrangler secret put ADMIN_PASSWORD
```

## Usage

Photos © the photographer — please ask before using. The code is shared as a portfolio reference.
