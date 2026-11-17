# ezccip.js

Turnkey [EIP-3668: CCIP-Read](https://eips.ethereum.org/EIPS/eip-3668) handler for ENS and arbitrary functions.

`bun add @namestone/ezccip viem` / `npm i @namestone/ezccip viem` [&check;](https://www.npmjs.com/package/@namestone/ezccip)

- TypeScript, ESM-only, built on [viem](https://viem.sh) (peer dependency)
- handler arguments and return values are typed from the ABI
- works with any runtime that speaks `fetch(Request) => Response`: Bun, Deno, Cloudflare Workers, Hono, Node adapters, etc.
- signing protocols:
  - `"ens"` &mdash; [ensdomains/**offchain-resolver**](https://github.com/ensdomains/offchain-resolver/) and [ccip.tools](https://ccip.tools/)
  - `"tor"` &mdash; [namestonehq/**TheOffchainResolver.sol**](https://github.com/namestonehq/TheOffchainResolver.sol)
  - `"raw"` &mdash; unsigned response (EVM Gateway, testing, etc.)
- `enableENSIP10()` wildcard resolver with drop-in [namestonehq/**enson.js**](https://github.com/namestonehq/enson.js) **Record**-type support
- supports _Multicall-over-CCIP-Read_ (see [Multicall](#multicall))
- `serveEZCCIP()` to quickly launch a server (Node, Bun, Deno)

## Demo

`bun run start` starts a [**TOR**](https://github.com/namestonehq/TheOffchainResolver.sol#context-format) CCIP-Read server on port `8016` (see [scripts/demo.ts](./scripts/demo.ts))

## Usage

```ts
import { EZCCIP } from "@namestone/ezccip";
import { getAbiItem } from "viem";

const ezccip = new EZCCIP({
	signer: privateKey, // Hex private key or viem LocalAccount
	// protocol: "tor", // default: "ens" with a signer, otherwise "raw"
	// ttl: 60, // response lifetime in seconds
});

// implement an arbitrary function
// args and return type are inferred from the signature
ezccip.addHandler("function plus(uint256 a, uint256 b) returns (uint256)", ([a, b]) => [a + b]);

// or from an existing ABI
ezccip.addHandler(getAbiItem({ abi, name: "f" }), async ([x], ctx) => {
	ctx.history.show = [ctx.sender]; // replace arguments of f(...) in logger
	ctx.history.name = "Chonk"; // rename f() to Chonk() in logger
	ctx.protocol = "raw"; // override signing protocol for this request
	return "0x..."; // return already-encoded bytes
});

// implement a wildcard ENSIP-10 resolver
// which handles resolve() automatically
ezccip.enableENSIP10(async (name, ctx) => {
	return {
		text(key) {
			switch (key) {
				case "name":
					return "Raffy";
				case "avatar":
					return "https://raffy.antistupid.com/ens.jpg";
			}
		},
	};
});

export default { fetch: ezccip.fetch }; // bound fetch() handler
```

### Handlers

`(args, ctx) => result`

- `args` &mdash; decoded arguments
- `ctx` &mdash; a `CallContext`, one per call:
  - `sender`, `calldata`, `request` (the HTTP `Request`, if any), `extra` (your custom object)
  - `origin`, `protocol`, `signer`, `ttl` &mdash; how the response is signed. These are shared by the whole request, so setting them in any call (eg. inside a `multicall`) affects the entire response
  - `history` &mdash; this call's log entry: set `show` or `name` to change how it's logged
- `result` &mdash; tuple of outputs (ABI-encoded for you), already-encoded `Hex | Uint8Array`, or nothing for `returns ()`

#### Multicall

`multicall(bytes[])` is built in and answered only as the outer call; its subcalls cannot be `multicall()`. `resolve()` may contain one `multicall()` of its own:

- `multicall([f(), g()])`
- `multicall([resolve(name, ...), ...])`
- `resolve(name, multicall([...]))`
- `multicall([resolve(name, multicall([...])), ...])`

### serveEZCCIP()

Start a [simple `node:http` server](./src/serve.ts) (works on Node, Bun, and Deno) for an `EZCCIP` instance or for a function that returns ENSIP-10 records. It logs startup, every response, every error, and shutdown. Pass `log: false` to disable, or your own function.

```ts
import { serveEZCCIP } from "@namestone/ezccip/serve";

const ccip = await serveEZCCIP(ezccip, { port: 8016 }); // default: random port
// 2026-01-01T00:00:00.000Z Serving "tor" 0xd00d726b2aD6C81E894DC6B87BE6Ce9c5572D2cd http://localhost:8016
// 2026-01-01T00:00:01.000Z ::1 / resolve(raffy.eth).text(name)
ccip.endpoint; // "http://localhost:8016"
ccip.context; // "{signer} {endpoint}" for TOR
await ccip.shutdown();
// 2026-01-01T00:00:02.000Z Shutdown<2000ms>

// minimal example: fixed text() for any name
await using ccip = await serveEZCCIP(() => ({ text: () => "Raffy" }), { signer: privateKey });
```

### Serving with fetch

`ezccip.fetch` is a bound `(request: Request) => Promise<Response>`:

- `POST {sender, data}` &rarr; `{data}`
- `GET .../{sender}/{data}.json` &rarr; `{data}`
- errors &rarr; `{message}` with HTTP status
- CORS enabled

```ts
// Bun
Bun.serve({ port: 8000, fetch: ezccip.fetch });

// Bun / Cloudflare Workers / Deno
export default { fetch: ezccip.fetch };

// Node (via @hono/node-server)
import { serve } from "@hono/node-server";
serve({ port: 8000, fetch: ezccip.fetch });
```

Need per-request data (eg. Cloudflare `env`)? Type it, pass it to `handleRequest()`, and read it from `ctx.extra`:

```ts
const ezccip = new EZCCIP<{ env: Env }>();
ezccip.addHandler("function f() returns (string)", (_, ctx) => [ctx.extra.env.NAME]);
export default {
	fetch: (request: Request, env: Env) => ezccip.handleRequest(request, { extra: { env } }),
};
```

Or skip HTTP entirely:

```ts
const { data, context } = await ezccip.handleRead({ sender, data: calldata });
console.log(context.history.toString());
```

### Hooks

Observe successes and failures, eg. for logging or metrics. Pass them to the constructor, or per request to `handleRequest()`. Exceptions thrown by hooks are ignored.

```ts
const ezccip = new EZCCIP({
	onResponse: ({ url, context }) => console.log(url.pathname, context.history.toString()),
	onError: ({ url, status, error }) => console.error(url.pathname, status, error),
});
```

#### Sender vs Origin

- ⚠️ `sender` may not be the originating contract
  - see: [recursive CCIP-Read](https://eips.ethereum.org/EIPS/eip-3668#recursive-calls-in-ccip-aware-contracts)
- **Best Solution**: embed `origin` into the endpoint as a path component:
  1.  `http://my.server/.../0xABCD/...`
  1.  `origin = 0xABCD`
- or, use `parseOrigin: (url: URL) => Address | undefined` to extract `origin` from an arbitrary URL
- or, supply a fallback `origin`
- if `origin` is not detected, `origin = sender`

### processENSIP10()

Answers ENSIP-10 `calldata` from a record object and returns the ABI-encoded response. It's a standalone function, so you can use it without an `EZCCIP` instance.

```ts
const record = {
	text(key) { if (key === "name") return "raffy"; },
	addr(coinType) { if (coinType === 60n) return "0x1234"; },
};
const res = await processENSIP10(record, calldata);
```

### Verifying responses

```ts
import { verifyResponse } from "@namestone/ezccip";
const { result, expires, signer } = await verifyResponse({ protocol: "ens", response, request, origin });
```

## Development

See [AGENTS.md](./AGENTS.md) for layout and conventions.

```sh
bun install
bun test
bun run check  # typecheck
bun run lint   # biome
bun run build  # dist/
```

### Migrating from 0.1

- `ethers` &rarr; `viem` (peer dependency); values are `Hex` strings and `bigint`
- default protocol is `"ens"` when a signer is set (was `"tor"`), otherwise `"raw"`
- `signingKey` &rarr; `signer` (private key or viem `LocalAccount`)
- `serve()` from `@namestone/ezccip/serve` &rarr; `serveEZCCIP()` (no default signing key; `server` is still a `node:http` server); or use `ezccip.fetch` with any server
- `register(abi, impl)` &rarr; one function per call: `addHandler(signature | AbiFunction, (args, ctx) => ...)`
- handlers receive `(args, ctx)`: `context` and `history` are combined into `ctx`, with `ctx.history` for logging
- extra context keys &rarr; one custom object, `ctx.extra`
- `handleRead(sender, calldata, config)` &rarr; `handleRead({ sender, data, ...config })`
- `log` / `formatError` options &rarr; `onResponse` / `onError` hooks (`serveEZCCIP` logs by default)
- `resolvers` option removed &mdash; use `parseOrigin` or `origin`
- `recursionLimit` removed &mdash; `multicall` is only allowed at the top level (see [Multicall](#multicall))
- `History`: `enter()` &rarr; `addChild()`, `then()` &rarr; `addInner()`, `next` &rarr; `inner`; no recursion `level`
- `ENSRecord.ABI(contentTypes)` receives a `bigint`
- `labels_from_dns_encoded` &rarr; `dnsDecode`, `error_with` &rarr; `CCIPReadError`
