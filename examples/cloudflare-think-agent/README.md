# Think agent with Monty Code Mode

This example is a real, stateful [Cloudflare Think](https://developers.cloudflare.com/agents/harnesses/think/) agent. Think runs the model loop, streams chat responses, and persists its transcript in Durable Object SQLite. The model has one active tool: a Monty-backed `codemode` tool that writes sandboxed Python to compose the two read-only project-tracker APIs.

```text
chat client → Think agent → codemode tool → Monty WASM → read-only host tools
```

The source deliberately uses a static project/task dataset. It demonstrates orchestration without credentials, network access, side effects, or Code Mode's durable approval/resume runtime.

## Run locally

From this directory:

```bash
npx wrangler dev --local
```

Connect an Agents SDK chat client to the `MontyProjectAgent` binding. Agents SDK kebab-cases binding names in its default URL, so this example's route is `/agents/monty-project-agent/<agent-name>`. A minimal React client can use `useAgent({ agent: "MontyProjectAgent" })` with `useAgentChat` from `@cloudflare/think/react`.

Ask a question that benefits from composing calls, for example:

> Which active project has the most open high-priority tasks? Include its owner and the task titles.

The agent should call `codemode`; the model writes Python to list projects, list each project's tasks, filter them, and return a compact result before composing its answer.

## What is intentionally absent

`createMontyCodeTool` follows Cloudflare's stateless Code Mode integration. The Monty executor receives direct read-only AI SDK tools and starts a fresh interpreter session for each execution. It does not implement connector bindings, durable execution history, or approval/pause/resume. Keep any tools exposed by this example read-only or idempotent.

The Monty WASM module has the same bundle-size consideration as the Worker example: it is roughly 5.5 MB compressed, so a deployment requires a Workers plan with sufficient script-size allowance.
