# Code Mode on Monty, inside a Cloudflare Worker

```bash
npx wrangler dev --local     # then: curl localhost:8787
npx wrangler dev --local &   # POST your own Python:
curl -X POST localhost:8787 --data-binary 'await codemode.getWeather({"location": "Lisbon"})'
```

The wasm runtime is imported as a `CompiledWasm` module and handed to
`createMontyWasmPool` — `Monty.create()` from `@pydantic/monty/wasm` does not
work in workerd (it resolves the browser loader and tries to `fetch` the asset).

The Worker bundles to ~17.9 MB raw / ~5.5 MB gzipped, so it needs the paid
plan's 10 MB compressed limit. Check with:

```bash
npx wrangler deploy --dry-run
```

`test/worker.e2e.mjs` in the repo root boots this Worker and asserts against it.

To deploy to an isolated temporary account and check the public Worker, run
this from the repository root:

```bash
npm run test:worker:smoke
```

This is opt-in because it creates a temporary Worker and needs network access.
It runs `wrangler deploy --temporary` with a fresh Wrangler config, so it does
not use your authenticated account. Cloudflare's claim URL is intentionally
redacted; temporary accounts expire unless claimed within 60 minutes. See
[Cloudflare's temporary deployment documentation](https://developers.cloudflare.com/workers/platform/claim-deployments/).
