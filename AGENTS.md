# Repository Guidelines

## Project Structure & Module Organization

`src/` contains the Node.js service. Keep HTTP/session logic in `server.js`, Sub2API calls in `sub2api.js`, persisted state in `store.js`, scheduling and budget rules in `manager.js` and `budget-policy.js`, and pure helpers in `utils.js`.

`public/` is the browser UI: `index.html`, `app.js`, base styles in `styles.css`, and targeted overrides in `overrides.css`. `test/` mirrors runtime behavior with Node's built-in test runner. Docker deployment files live at the repository root.

## Build, Test, and Development Commands

Use Node.js 22 or newer; production Docker uses Node.js 24.

```sh
node --test
node --env-file=.env src/server.js
docker compose up -d --build
docker compose logs --tail=100 key-manager
```

`node --test` runs every `test/*.test.js` file. For local development, copy `.env.example` to `.env`, set `DATA_DIR=./data` and `PORT=3100`, then open `http://localhost:3100`. Do not run `docker compose down -v` against a live NAS deployment: the named volume holds application state.

## Coding Style & Naming Conventions

Use ESM JavaScript, two-space indentation, semicolons, and single quotes. Prefer small, pure functions for time, budget, and serialization rules. Use camelCase for functions and variables, PascalCase for classes, and descriptive test names such as `month rollover restores owned keys`.

Keep UI state in `public/app.js`; render dynamic text with `escapeHtml`. Use scoped CSS names such as `quota-warning`, never generic state names like `warning` that can collide with shared styles. There is no formatter or linter configured; run `node --check src/*.js public/app.js` before committing UI or server changes.

## Testing Guidelines

Add focused tests for new behavior. Budget changes should cover boundary values, cross-month behavior, retry paths, and key status ownership. Use mock Sub2API behavior in `test/http.test.js` and `test/budget.test.js`; never point tests at the production account or disable real keys.

## Commit & Pull Request Guidelines

Use Conventional Commit prefixes, matching project history: `feat: add monthly budget`, `fix: scope quota warning state styles`. Keep commits narrow. PRs should describe user-visible behavior, configuration changes, tests run, and include desktop/mobile screenshots for UI changes.

## Security & Configuration

Never commit `.env`, `/data`, real Key values, tokens, or NAS backups. Keep `ADMIN_PASSWORD`, `SUPERADMIN_PASSWORD`, and Sub2API credentials in `.env`. Preserve the Docker volume and `.env` during NAS updates.
