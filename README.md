# ezccip.js

Turnkey [EIP-3668: CCIP-Read](https://eips.ethereum.org/EIPS/eip-3668) handler for ENS and arbitrary functions.

`bun add @namestone/ezccip` / `npm i @namestone/ezccip` [&check;](https://www.npmjs.com/package/@namestone/ezccip)

- TypeScript, ESM-only, built on [ox](https://oxlib.sh) (no ethers)
- handler arguments and return values are fully typed from the ABI
- works with any runtime that speaks `fetch(Request) => Response`: Bun, Deno, Cloudflare Workers, Hono, Node adapters, etc.
- signing protocols:
  - `"ens"` &mdash; [ensdomains/**offchain-resolver**](https://github.com/ensdomains/offchain-resolver/) and [ccip.tools](https://ccip.tools/)
  - `"raw"` &mdash; unsigned response (EVM Gateway, testing, etc.)
- `enableENSIP10()` wildcard resolver support with drop-in [namestonehq/**enson.js**](https://github.com/namestonehq/enson.js) **Record**-type support
- supports _Multicall-over-CCIP-Read_
  - `resolve(name, multicall([...]))`
  - `multicall([resolve(name, ...), ...])`
  - `multicall([resolve(name, multicall([...])), ...])`
- [**CCIP Postman**](https://namestonehq.github.io/ezccip.js/test/postman.html) ⭐️
  - directly debug any CCIP-Read server (no RPC)

## Demo

1. `bun run start` &mdash; starts a CCIP-Read server on port `8016` (see [demo.ts](./demo.ts))
1. check [Postman](https://namestonehq.github.io/ezccip.js/test/postman.html) &larr; change endpoint to `http://localhost:8016`

## Usage

```ts
import { EZCCIP } from "@namestone/ezccip";

const ezccip = new EZCCIP({
	signer: privateKey, // Hex private key or viem LocalAccount
	// protocol: "ens", // default: "ens" if signer, otherwise "raw"
	// ttl: 60, // response lifetime in seconds
});

// implement an arbitrary function
// args and return type are inferred from the signature
ezccip.register(
	"function plus(uint256 a, uint256 b) returns (uint256)",
	([a, b]) => [a + b]
);

// or from an existing ABI
import { AbiFunction } from "ox";
ezccip.register(AbiFunction.fromAbi(abi, "f"), async ([x], context, history) => {
	history.show = [context.sender]; // replace arguments of f(...) in logger
	history.name = "Chonk"; // rename f() to Chonk() in logger
	context.protocol = "raw"; // override signing protocol for this request
	return "0x..."; // return already-encoded bytes
});

// implement a wildcard ENSIP-10 resolver
// which handles resolve() automatically
ezccip.enableENSIP10(async (name, context) => {
	return {
		text(key) {
			switch (key) {
				case "name": return "Raffy";
				case "avatar": return "https://raffy.antistupid.com/ens.jpg";
			}
		},
	};
});

export default ezccip; // has a bound fetch() handler
```

### Handlers

`(args, context, history) => result`

- `args` &mdash; decoded arguments
- `context` &mdash; shared request information: `sender`, `origin`, `calldata`, `request`, and mutable `protocol`, `signer`, `ttl`
- `history` &mdash; per-call description of the response (used for logging)
- `result` &mdash; tuple of outputs (encoded automatically), ABI-encoded `Hex | Uint8Array`, or nothing for `returns ()`

### Serving

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

Need per-request data (eg. Cloudflare `env`)? Type it and pass it to `handleRequest()`:

```ts
const ezccip = new EZCCIP<{ env: Env }>();
ezccip.register("function f() returns (string)", (_, { env }) => [env.NAME]);
export default {
	fetch: (request: Request, env: Env) => ezccip.handleRequest(request, { env }),
};
```

Or skip HTTP entirely:

```ts
const { data, history } = await ezccip.handleRead({ sender, data: calldata });
console.log(history.toString());
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

Apply ENSIP-10 `calldata` to a `Record`-object and generate the corresponding ABI-encoded response. This is a free function.

```ts
const record = {
	text(key) { if (key === "name") return "raffy"; },
	addr(coinType) { if (coinType === 60n) return "0x1234"; },
};
const res = await processENSIP10(record, calldata);
```

### Verifying responses

```ts
import { decodeENSResponse } from "@namestone/ezccip";
const { result, expires, signer } = decodeENSResponse({ response, request, origin });
```

## Development

```sh
bun install
bun test
bun run check  # typecheck
bun run build  # dist/
```

### Migrating from 0.1

- `ethers` &rarr; `ox`; values are `Hex` strings / `bigint`
- `"tor"` protocol removed &mdash; use `"ens"` or `"raw"`
- `signingKey` &rarr; `signer` (private key or viem `LocalAccount`)
- `serve()` removed &mdash; use `ezccip.fetch` with your runtime's server
- `register(abi, impl)` &rarr; one function per call: `register(signature | AbiFunction, (args, context, history) => ...)`
- `handleRead(sender, calldata, config)` &rarr; `handleRead({ sender, data, ...config })`
- `history.then()` &rarr; `history.chain()`, `history.head()` &rarr; `history.last()`
- `labels_from_dns_encoded` &rarr; `labelsFromDnsEncoded`, `error_with` &rarr; `CCIPReadError`
- `resolvers` option removed &mdash; use `parseOrigin` or `origin`; disable multicall with `recursionLimit: 0`
