# ezccip.js

[![CI](https://github.com/adraffy/ezccip.js/actions/workflows/ci.yml/badge.svg)](https://github.com/adraffy/ezccip.js/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@adraffy/ezccip)](https://www.npmjs.com/package/@adraffy/ezccip)

Turnkey [EIP-3668: CCIP-Read](https://eips.ethereum.org/EIPS/eip-3668) handler for ENS and arbitrary functions.

`bun add @adraffy/ezccip viem` / `npm i @adraffy/ezccip viem` (Node 20+)

- TypeScript, ESM-only, built on [viem](https://viem.sh) (peer dependency)
- handler arguments and return values are typed from the ABI
- runtime-agnostic core: `handleRequest(sender, calldata)`, plus HTTP adapters for `fetch` runtimes (Bun, Deno, Cloudflare Workers, Hono) and `node:http`
- signing protocols:
  - `"ens"` &mdash; [ensdomains/**offchain-resolver**](https://github.com/ensdomains/offchain-resolver/) and [ccip.tools](https://ccip.tools/)
  - `"tor"` &mdash; TheOffchainResolver (TOR)
  - `"raw"` &mdash; unsigned response (EVM Gateway, testing, etc.)
- `enableENSIP10()` wildcard resolver from plain record objects
- supports _Multicall-over-CCIP-Read_ (see [Multicall](#multicall))
- `serveEZCCIP()` to quickly launch a server (Node, Bun, Deno), `createFetchHandler()` for everything else

## Demo

`bun run start` starts a **TOR** CCIP-Read server on port `8016` (or `PORT`) (see [scripts/demo.ts](./scripts/demo.ts))

## Usage

```ts
import { createFetchHandler, EZCCIP } from "@adraffy/ezccip";
import { serveEZCCIP } from "@adraffy/ezccip/serve";
import { getAbiItem } from "viem";

const ezccip = new EZCCIP({
	signer: privateKey, // Hex private key or viem LocalAccount
	// protocol: "tor", // default: "ens" with a signer, otherwise "raw"
	// ttl: 60, // response lifetime in seconds
});

// implement an arbitrary function
// args and return type are inferred from the signature
ezccip.addFunctionHandler("function plus(uint256 a, uint256 b) returns (uint256)", ([a, b]) => [a + b]);

// or from an existing ABI
ezccip.addFunctionHandler(getAbiItem({ abi, name: "f" }), async ([x], ctx, history) => {
	history.show = [ctx.sender]; // replace arguments of f(...) in logger
	history.name = "Chonk"; // rename f() to Chonk() in logger
	ctx.protocol = "raw"; // override signing protocol for this request
	return "0x..."; // return already-encoded bytes
});

// or by name from an ABI: human-readable (which can declare structs) or JSON
// (the name must not be overloaded; for overloads, pass getAbiItem({ abi, name, args }) above)
const abi = ["struct Point { uint256 x; uint256 y; }", "function flip(Point p) returns (Point)"] as const;
ezccip.addAbiHandler(abi, "flip", ([{ x, y }]) => [{ x: y, y: x }]);

// implement a wildcard ENSIP-10 resolver
// which handles resolve() automatically
ezccip.enableENSIP10({
	async resolve(name, ctx) {
		// return nothing (undefined or null) if the name doesn't exist: reverts UnreachableName
		// return {} if the name exists without records: every profile answers empty
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
});

// signer and protocol can change later (the protocol isn't changed by setting a signer)
ezccip.signer = otherKey; // or undefined to clear it
ezccip.protocol = "tor";

// answer a request directly
const { data, history } = await ezccip.handleRequest(sender, calldata); // { origin, extra, ... } optional
console.log(history.toString()); // eg. resolve(raffy.eth).text(name)

// or serve it over HTTP
export default { fetch: createFetchHandler(ezccip) }; // Bun, Deno, Cloudflare Workers, ...
await serveEZCCIP(ezccip, { port: 8016 }); // Node, Bun, Deno (from "@adraffy/ezccip/serve")
```

### Handlers

`(args, ctx, history) => result`

- `args` &mdash; decoded arguments
- `ctx` &mdash; a `ReadContext`: one plain object shared by the whole request (every `multicall` subcall gets the same one)
  - `sender`, `calldata` &mdash; the request
  - `chainId` &mdash; the origin's chain, if the request says (see [Sender vs Origin](#sender-vs-origin))
  - `origin`, `protocol`, `signer`, `ttl` &mdash; how the response is signed. Set them in any call to change the entire response; they're validated when signing. They start from the `handleRequest()` options, then the `EZCCIP` defaults. Setting `ctx.signer` doesn't change `ctx.protocol`
  - `extra` &mdash; custom values from the caller, eg. `ctx.extra.ip`, see [Extra](#extra)
- `history` &mdash; this call's line in the log: set `name`, or `show` (an array of values to print instead of the arguments, or `false` to hide them)
- `result` &mdash; tuple of outputs (ABI-encoded for you) or already-encoded `Hex | Uint8Array`. Functions without outputs may return nothing

#### Errors

- throw a `CCIPReadError` to send its message and status to the client, eg. `new CCIPReadError("not found", { status: 404 })`
- `handleRequest()` throws; the HTTP adapters turn other errors into `500` `{"message": "internal error"}`, and log the real error when `log` is on
- bad requests and calldata are `400`, unknown functions are `404`
- inside `multicall()`, each failed subcall is answered with `Error(string)` using the same rule

#### Multicall

`multicall(bytes[])` is built in (it isn't a handler, so it can't be replaced) and is answered only as the outer call; its subcalls cannot be `multicall()`. `resolve()` may contain one `multicall()` of its own:

- `multicall([f(), g()])`
- `multicall([resolve(name, ...), ...])`
- `resolve(name, multicall([...]))`
- `multicall([resolve(name, multicall([...])), ...])`

### HTTP

Both adapters answer `POST {sender, data}` and `GET .../{sender}/{data}.json` with `{data}`, or `{message}` and an HTTP status, and take the same options:

- `cors` &mdash; add CORS headers and answer `OPTIONS` preflight requests (default: `true`)
- `parseOrigin: (url: URL) => { origin?, chainId? }` &mdash; default: `?origin=0x...&chainId=1`, see [Sender vs Origin](#sender-vs-origin)
- `log` &mdash; log every response and error with `console.log`

#### serveEZCCIP()

Start a [simple `node:http` server](./src/serve.ts) (works on Node, Bun, and Deno) for an `EZCCIP` instance, or for an ENSIP-10 `resolve` function: `serveEZCCIP(resolve, options)` is `serveEZCCIP(new EZCCIP(options).enableENSIP10({ resolve }), options)`, signed with a random key unless `signer` is set. Request bodies over 1 MiB are rejected. It logs startup, every response, every error, and shutdown unless `log: false`.

```ts
import { serveEZCCIP } from "@adraffy/ezccip/serve";

const ccip = await serveEZCCIP(ezccip, { port: 8016 }); // default: random port
// 2026-01-01T00:00:00.000Z Serving "tor" 0xd00d726b2aD6C81E894DC6B87BE6Ce9c5572D2cd http://localhost:8016
// 2026-01-01T00:00:01.000Z ::1 1:0xABCD... resolve(raffy.eth).text(name)    ({chainId}:{origin}, "?" if no chainId)
ccip.endpoint; // "http://localhost:8016"
ccip.context; // "{signer} {endpoint}"
await ccip.shutdown();
// 2026-01-01T00:00:02.000Z Shutdown<2000ms>

// minimal example: fixed text() for any name
await using ccip = await serveEZCCIP(() => ({ text: () => "Raffy" }));

// with ENSIP-10 options: enableENSIP10() returns the instance
await serveEZCCIP(new EZCCIP({ signer: privateKey }).enableENSIP10({ resolve, multicall: false }));

// every name exists: unknown names answer empty instead of UnreachableName
await serveEZCCIP((name) => db.get(name) ?? {});
```

#### createFetchHandler()

Returns a `fetch(request, extra?) => response` handler for fetch-based runtimes.

```ts
import { createFetchHandler } from "@adraffy/ezccip";

// Bun / Cloudflare Workers / Deno
export default { fetch: createFetchHandler(ezccip) };

// or pass your own extra values
const handler = createFetchHandler(ezccip);
Bun.serve({ port: 8000, fetch: (req) => handler(req, { region: "us" }) });
```

#### Extra

`ctx.extra` is a `Record<string, unknown>` of custom values for handlers (and `resolve`), filled by whoever calls `handleRequest()`. Handlers may read or add to it.

```ts
ezccip.addFunctionHandler("function whoami() returns (string)", (_, ctx) => [`${ctx.extra.ip}`]);

// serveEZCCIP(): the client's ip (x-forwarded-for, or the socket address), plus your own values
await serveEZCCIP(ezccip, { extra: { region: "us" } }); // ctx.extra = { region: "us", ip: "::1" }

// createFetchHandler(): the fields of its second argument, eg. Cloudflare's env
export default { fetch: createFetchHandler(ezccip) }; // ctx.extra = { ...env }

// directly
await ezccip.handleRequest(sender, calldata, { extra: { ip } });
```

### Sender vs Origin

- ⚠️ `sender` may not be the contract that issued the request: `OffchainLookup` only carries `sender` and the URLs, and a lookup can be wrapped and rethrown (see [recursive CCIP-Read](https://eips.ethereum.org/EIPS/eip-3668#recursive-calls-in-ccip-aware-contracts))
- so the gateway URL is the only thing that identifies the contract, and its network
- **Best Solution**: put them in the URL as query parameters (both optional):
  1. `https://my.server/?chainId=1&origin=0xABCD...` (`GET`: `https://my.server/{sender}/{data}.json?chainId=1&origin=0xABCD...`)
  1. `ctx.origin = 0xABCD...`, `ctx.chainId = 1`
  - this is what the HTTP adapters do by default (`originFromQuery`); `chainId` must be decimal
  - pass `parseOrigin: (url: URL) => { origin?, chainId? }` to read them some other way
- or, pass them to `handleRequest(sender, calldata, { origin, chainId })`
- if there's no origin, `origin = sender`; if there's no chain, `chainId` is `undefined`
- `origin` is signed (`"ens"`, `"tor"`); `chainId` is only for handlers, eg. to pick which network to read

### Unknown names vs empty records

What `resolve(name, ctx, history)` returns decides how `resolve()` is answered:

- nothing (`undefined` or `null`) &rarr; the name doesn't exist: reverts `UnreachableName(bytes)`
- `{}` &rarr; the name exists without records: every profile answers empty (`""`, `0x`, the zero address)
- a record &rarr; each profile calls its method; missing methods and missing values answer empty

```ts
resolve: (name) => db.get(name); // unknown names revert UnreachableName
resolve: (name) => db.get(name) ?? {}; // every name exists
```

### processENSIP10()

Answers ENSIP-10 `calldata` from a record object and returns the ABI-encoded response. It's a standalone function, so you can use it without an `EZCCIP` instance.

```ts
const record = {
	text(key) { if (key === "name") return "raffy"; },
	addr(coinType) { if (coinType === 60n) return "0x51050ec063d393217b436747617ad1c2285aeeee"; },
};
const res = await processENSIP10(record, calldata); // (record, calldata, options?, history?)
```

`addr()` values for EVM coin types (`60`, and [ENSIP-11](https://docs.ens.domains/ensip/11) chains including the default) must be 20 bytes or empty; anything else throws. Other coin types are returned as-is. Empty bytes (`"0x"`) count as no address, so the [ENSIP-19](https://docs.ens.domains/ensip/19) default address still applies.

### Verifying responses

Checks a signed response the way the onchain verifier would: throws if it has expired, or if `signer` is given and doesn't match.

```ts
import { verifyResponse } from "@adraffy/ezccip";
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
- default protocol is `"ens"` when constructed with a signer (was `"tor"`), otherwise `"raw"`; change it later with `ezccip.protocol = ...` and the signer with `ezccip.signer = ...` (or `undefined`)
- `signingKey` &rarr; `signer` (private key or viem `LocalAccount`)
- `serve()` from `@adraffy/ezccip/serve` &rarr; `serveEZCCIP(ezccip, options)` or `serveEZCCIP(resolve, options)` (the default signing key is random; `server` is still a `node:http` server; `signer` &rarr; `ezccip.signerAddress`; `resolvers` &rarr; `parseOrigin`); or `createFetchHandler(ezccip)` for fetch-based runtimes
- `register(abi, impl)` &rarr; one function per call: `addFunctionHandler(signature | AbiFunction, (args, ctx, history) => ...)` or `addAbiHandler(abi, functionName, ...)`; signatures must be valid human-readable ABI, starting with `function `
- extra context keys (eg. `context.ip`) &rarr; `ctx.extra.ip`
- `ttlSec` &rarr; `ttl`, `signingKey` &rarr; `signer`, and `context.history` &rarr; the handler's third argument
- `enableENSIP10(fn, options)` &rarr; `enableENSIP10({ resolve: fn, ...options })`; `throwErrors` &rarr; `throwUnsupported`
- `addr()` values for EVM coin types must be 20 bytes (were truncated or padded)
- unknown functions are `404` and bad calldata `400` (both were `500`); non-`CCIPReadError` messages are hidden from clients
- `handleRead(sender, calldata, config)` &rarr; `handleRequest(sender, calldata, { origin, chainId, protocol, signer, ttl, extra })`
- `log` / `formatError` options &rarr; `log: boolean` on `serveEZCCIP` (default on) and `createFetchHandler`
- `serveEZCCIP` sets `ctx.extra.ip`; `context.url` is gone (use `parseOrigin` or call `handleRequest()` yourself)
- the origin is read from the query (`?origin=0x...&chainId=1`), not the first `/0x...` path component; for existing URLs with the origin in the path, pass `parseOrigin: (url) => ({ origin: url.pathname.match(/\/(0x[0-9a-f]{40})(?=\/|$)/i)?.[1] })`
- `recursionLimit` removed &mdash; `multicall` is only allowed at the top level (see [Multicall](#multicall))
- `History` only builds the log line: set `name` or `show` (an array, or `false`); `enter()` &rarr; `addChild()`, `then()` &rarr; `addInner()`, `next` &rarr; `inner`
- `ENSRecord.ABI(contentTypes)` receives a `bigint` and returns `type` as a `bigint`; `pubkey()` returns `x` and `y` as `bigint` or `Hex` (no `number`)
- `unreachableAsEmpty` removed &mdash; return `{}` from `resolve` for names that exist without records (see [Unknown names vs empty records](#unknown-names-vs-empty-records))
- `labels_from_dns_encoded` &rarr; `dnsDecodeLabels` (or `dnsDecodeName` for the joined name), `error_with` &rarr; `CCIPReadError`
- `RESOLVE_ABI` &rarr; `resolverAbi`; `multicall` is no longer a handler (`findHandler("multicall")` is `undefined`)
