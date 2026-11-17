# ezccip.js

Turnkey [EIP-3668: CCIP-Read](https://eips.ethereum.org/EIPS/eip-3668) handler for ENS and arbitrary functions.

`bun add @namestone/ezccip viem` / `npm i @namestone/ezccip viem` (Node 20+) [&check;](https://www.npmjs.com/package/@namestone/ezccip)

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
ezccip.enableENSIP10({
	async resolve(name, ctx) {
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
	},
	// unreachableAsEmpty: false, // unknown names revert UnreachableName
});

export default { fetch: ezccip.fetch }; // bound fetch() handler
```

### Handlers

`(args, ctx, extra) => result`

- `args` &mdash; decoded arguments
- `ctx` &mdash; a `CallContext`, one per call:
  - `calldata` &mdash; this call's calldata
  - `history` &mdash; this call's line in the log: set `name`, or `show` (an array of values to print instead of the arguments, or `false` to hide them)
  - `sender`, `request` (the HTTP `Request`, if any) &mdash; shared by the whole request
  - `origin`, `protocol`, `signer`, `ttl` &mdash; how the response is signed. Also shared by the whole request, so setting them in any call (eg. inside a `multicall`) affects the entire response. The protocol is chosen after handlers run, so setting `ctx.signer` alone switches the default to `"ens"`
- `extra` &mdash; your custom object for this request (eg. `{ env }`), see [Serving with fetch](#serving-with-fetch); `undefined` unless you declare `EZCCIP<Extra>`
- `result` &mdash; tuple of outputs (ABI-encoded for you) or already-encoded `Hex | Uint8Array`. Functions without outputs may return nothing

#### Errors

- throw a `CCIPReadError` to send its message and status to the client, eg. `new CCIPReadError("not found", { status: 404 })`
- other errors are sent as `500` `{"message": "internal error"}`; the real error goes to the `onError` hook and the log
- bad requests and calldata are `400`, unknown functions are `404`
- inside `multicall()`, each failed subcall is answered with `Error(string)` using the same rule

#### Multicall

`multicall(bytes[])` is built in (it isn't a handler, so it can't be replaced) and is answered only as the outer call; its subcalls cannot be `multicall()`. `resolve()` may contain one `multicall()` of its own:

- `multicall([f(), g()])`
- `multicall([resolve(name, ...), ...])`
- `resolve(name, multicall([...]))`
- `multicall([resolve(name, multicall([...])), ...])`

### serveEZCCIP()

Start a [simple `node:http` server](./src/serve.ts) (works on Node, Bun, and Deno) for an `EZCCIP` instance, or for an ENSIP-10 `resolve` function: `serveEZCCIP(resolve, options)` is `serveEZCCIP(new EZCCIP(options).enableENSIP10({ resolve }), options)`, signed with a random key unless `signer` is set. Request bodies over 1 MiB are rejected. It logs startup, every response, every error, and shutdown with `console.log`. Pass `log: false` to disable, and `cors: false` to turn off CORS headers.

```ts
import { serveEZCCIP } from "@namestone/ezccip/serve";

const ccip = await serveEZCCIP(ezccip, { port: 8016 }); // default: random port
// 2026-01-01T00:00:00.000Z Serving "tor" 0x24c8D99852e8174CD990d0Cc0A5627232F74FeD9 http://localhost:8016
// 2026-01-01T00:00:01.000Z ::1 / resolve(raffy.eth).text(name)
ccip.endpoint; // "http://localhost:8016"
ccip.context; // "{signer} {endpoint}"
await ccip.shutdown();
// 2026-01-01T00:00:02.000Z Shutdown<2000ms>

// minimal example: fixed text() for any name
await using ccip = await serveEZCCIP(() => ({ text: () => "Raffy" }));

// with ENSIP-10 options: enableENSIP10() returns the instance
await serveEZCCIP(new EZCCIP({ signer: privateKey }).enableENSIP10({ resolve, unreachableAsEmpty: true }));
```

### Serving with fetch

`ezccip.fetch` is a bound `(request: Request) => Promise<Response>` (only available when `extra` is optional):

- `POST {sender, data}` &rarr; `{data}`
- `GET .../{sender}/{data}.json` &rarr; `{data}`
- errors &rarr; `{message}` with HTTP status
- CORS enabled (pass `cors: false` to `handleRequest()` to turn it off)

```ts
// Bun
Bun.serve({ port: 8000, fetch: ezccip.fetch });

// Bun / Cloudflare Workers / Deno
export default { fetch: ezccip.fetch };

// Node (via @hono/node-server)
import { serve } from "@hono/node-server";
serve({ port: 8000, fetch: ezccip.fetch });
```

Need per-request data (eg. Cloudflare `env`)? Type it, pass it to `handleRequest()`, and handlers (and `resolve`) receive it as their third argument:

```ts
const ezccip = new EZCCIP<{ env: Env }>();
ezccip.addHandler("function f() returns (string)", (_, ctx, { env }) => [env.NAME]);
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

Observe successes and failures, eg. for logging or metrics. Pass them to the constructor, or per request to `handleRequest()`. They can't affect the response: exceptions and rejected promises from hooks are ignored.

```ts
const ezccip = new EZCCIP({
	onResponse: ({ url, context }) => console.log(url.pathname, context.history.toString()),
	// context is undefined if the request was malformed
	onError: ({ url, status, error, context }) => console.error(url.pathname, status, context?.history, error),
});
```

### Sender vs Origin

- ⚠️ `sender` may not be the originating contract
  - see: [recursive CCIP-Read](https://eips.ethereum.org/EIPS/eip-3668#recursive-calls-in-ccip-aware-contracts)
- **Best Solution**: embed `origin` into the endpoint as a path component:
  1.  `http://my.server/.../0xABCD/...`
  1.  `origin = 0xABCD`
  - this is the default `parseOrigin`; supply your own `parseOrigin: (url: URL) => Address | undefined` to replace it
- or, supply a fallback `origin` option (also used by `handleRead()`)
- if neither finds one, `origin = sender`

### processENSIP10()

Answers ENSIP-10 `calldata` from a record object and returns the ABI-encoded response. It's a standalone function, so you can use it without an `EZCCIP` instance.

```ts
const record = {
	text(key) { if (key === "name") return "raffy"; },
	addr(coinType) { if (coinType === 60n) return "0x51050ec063d393217b436747617ad1c2285aeeee"; },
};
const res = await processENSIP10(record, calldata);
```

`addr()` values for EVM coin types (`60`, and [ENSIP-11](https://docs.ens.domains/ensip/11) chains including the default) must be 20 bytes or empty; anything else throws. Other coin types are returned as-is. Empty bytes (`"0x"`) count as no address, so the [ENSIP-19](https://docs.ens.domains/ensip/19) default address still applies.

### Verifying responses

Checks a signed response the way the onchain verifier would: throws if it has expired, or if `signer` is given and doesn't match.

```ts
import { verifyResponse } from "@namestone/ezccip";
const { result, expires, signer } = await verifyResponse({ protocol: "ens", response, calldata, origin, signer: expected });
```

## Development

See [AGENTS.md](./AGENTS.md) for layout and conventions.

```sh
bun install
bun test
bun run check  # typecheck
bun run lint   # biome
bun run build  # dist/
bun run smoke  # build, then run dist/ on Node
```

### Migrating from 0.1

- `ethers` &rarr; `viem` (peer dependency); values are `Hex` strings and `bigint`
- default protocol is `"ens"` when a signer is set (was `"tor"`), otherwise `"raw"`
- `signingKey` &rarr; `signer` (private key or viem `LocalAccount`)
- `serve()` from `@namestone/ezccip/serve` &rarr; `serveEZCCIP(ezccip, options)` or `serveEZCCIP(resolve, options)` (the default signing key is random; `server` is still a `node:http` server; `signer` &rarr; `ezccip.signerAddress`); or use `ezccip.fetch` with any server
- `register(abi, impl)` &rarr; one function per call: `addHandler(signature | AbiFunction, (args, ctx, extra) => ...)`
- handlers receive `(args, ctx, extra)`: `context` and `history` are combined into `ctx`, with `ctx.history` for logging
- extra context keys &rarr; one custom object, passed to handlers as the third argument: `(args, ctx, extra)`
- `ctx.calldata` is the current call's calldata (inside `multicall`, the subcall)
- `enableENSIP10(fn, options)` &rarr; `enableENSIP10({ resolve: fn, ...options })`; `throwErrors` &rarr; `throwUnsupported`
- `addr()` values for EVM coin types must be 20 bytes (were truncated or padded)
- unknown functions are `404` and bad calldata `400` (both were `500`); non-`CCIPReadError` messages are hidden from clients
- `handleRead(sender, calldata, config)` &rarr; `handleRead({ sender, data, ...config })`
- `log` / `formatError` options &rarr; `onResponse` / `onError` hooks (`serveEZCCIP` logs by default)
- `resolvers` option removed &mdash; use `parseOrigin` or `origin`
- `recursionLimit` removed &mdash; `multicall` is only allowed at the top level (see [Multicall](#multicall))
- `History` only builds the log line: set `name` or `show` (an array, or `false`); `enter()` &rarr; `addChild()`, `then()` &rarr; `addInner()`, `next` &rarr; `inner`
- `ENSRecord.ABI(contentTypes)` receives a `bigint`
- `labels_from_dns_encoded` &rarr; `dnsDecodeLabels` (or `dnsDecodeName` for the joined name), `error_with` &rarr; `CCIPReadError`
- `RESOLVE_ABI` &rarr; `resolverAbi`; `multicall` is no longer a handler (`findHandler("multicall")` is `undefined`)
