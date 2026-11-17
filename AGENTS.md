# AGENTS.md

Guidance for coding agents working on **ezccip.js** (`@namestone/ezccip`), a turnkey [EIP-3668 CCIP-Read](https://eips.ethereum.org/EIPS/eip-3668) gateway library for ENS and arbitrary offchain functions.

## Commands

```sh
bun install
bun run check    # tsc --noEmit (src, test, scripts)
bun run lint     # biome check
bun run format   # biome check --write (format + organize imports + safe fixes)
bun test         # bun:test, includes type assertions via expectTypeOf / @ts-expect-error
bun run build    # tsc -p tsconfig.build.json -> dist/ (ESM + .d.ts)
bun run start    # scripts/demo.ts on :8016
bun run smoke    # build, then run scripts/smoke.mjs against dist/ on Node
```

Before finishing a change, run `bun run check && bun run lint && bun test`. If you touch exports, types, or imports in `src/`, also run `bun run build` and make sure `dist/*.d.ts` contains no `.ts` import specifiers.

## Stack and constraints

- **Bun** for tooling and tests. The library itself is runtime-agnostic: core code only uses web standards (`Request`, `Response`, `URL`), and `src/serve.ts` only uses `node:http`, which Node, Bun, and Deno all support. Never use `Bun.*` APIs in `src/`. Build types are `["node"]`, so emitted `.d.ts` files don't depend on Bun types.
- **viem** is a **peer dependency**: use it for all ABI coding, hashing, addresses, and signing. Do not add ethers, ox (directly), or other crypto libraries.
- **abitype** is a dependency for types only (`AbiParametersToPrimitiveTypes`), since viem does not re-export it.
- **TypeScript 7** (`tsc` is the native compiler), `strict` + `noUncheckedIndexedAccess`.
- **ESM-only**. No CommonJS build.
- **Biome** for formatting and lint: tabs, double quotes, 120 columns. Do not hand-format; run `bun run format`.

## Layout

```
src/
  index.ts      public API; explicit named exports only (no `export *`)
  ezccip.ts     EZCCIP class: addHandler/findHandler, dispatch, built-in multicall, handleRead()
  context.ts    CallContext: per-call view of request-wide state (+ this call's History)
  types.ts      shared public types: Handler, HandlerFunction, HandlerResult, ExtraParameter
  http.ts       Request -> Response: parseCCIPReadRequest, originFromPath, handleRequest, hooks
  signing.ts    "raw" | "ens" | "tor" protocols, Signer/SignerLike, signResponse, verifyResponse
  history.ts    History: per-call log entry; tree via children (multicall) and inner (resolve)
  errors.ts     CCIPReadError (carries HTTP status); publicErrorMessage, encodeErrorString (internal)
  serve.ts      serveEZCCIP(): node:http quick server (Node, Bun, Deno), separate export "@namestone/ezccip/serve"
  utils.ts      small internal helpers (some re-exported, eg. asciiize)
  ens/
    abi.ts      resolverAbi (public) and its SCREAMING_CASE items (internal)
    ensip10.ts  ENSRecord, processENSIP10, createENSIP10Handler
    coin-type.ts, dns.ts
scripts/demo.ts   demo server
scripts/smoke.mjs runs dist/ on any runtime (CI runs it on Node 20/22/24)
.github/workflows/ci.yml  bun: check, lint, test, build, smoke; node: build, smoke
test/           mirrors src/ (test/ens/* for src/ens/*)
```

## Conventions

- **Relative imports use `.js` extensions** (`import { x } from "./http.js"`), even though the files are `.ts`. `tsc` does not rewrite `.ts` specifiers inside emitted `.d.ts` files, so `.ts` imports break consumers.
- **Types come from the ABI.** `addHandler()` takes one function (a human-readable signature, with or without the `function` prefix, or a viem `AbiFunction`), and the handler's `args` and return tuple are inferred from it. Keep this inference working, and add `expectTypeOf` / `@ts-expect-error` checks in tests when you change handler or context types.
- **Handler signature** is `(args, ctx, extra) => result`. `CallContext` is a public *interface*; the class is the internal `Context`, created per call, which reads and writes one request-wide `ReadState`: `origin`, `protocol`, `signer`, and `ttl` are intentionally mutable and shared by every call in the request, and their setters validate. `ctx.calldata` and `ctx.history` belong to that call only. Subcalls get their context from `Context.child(calldata)`.
- **`multicall`** is handled in `#call`, not registered as a handler, so it can't be replaced and isn't listed in `handlers`.
- **`History`** only exists to build the log line: `name`, `show` (`readonly unknown[] | false`), `error`, `children`, `inner`. Don't add fields that aren't printed.
- **Public exports** are listed explicitly in `src/index.ts`. Keep internal helpers (eg. `encodeErrorString`, `formatCoinType`, the ABI items) out of it; tests may import internal modules directly.
- **ENSIP-10 answers** are built from typed ABI items in `src/ens/abi.ts` via `profile(abiItem, answer)`, so `args` and results are type-checked. Add new profiles the same way. EVM `addr()` values must be 20 bytes or empty (`toEVMAddress`).
- **Object parameters**: `enableENSIP10({ resolve, ...options })` (returns the instance, for chaining) and the signing functions take a single object. `serveEZCCIP` takes an `EZCCIP` or a `resolve` function, then options; only the `resolve` form creates the instance, with a random signer unless one is given.
- **Multicall** is only answered as the outer call; subcalls cannot be `multicall()`. Inside `resolve()`, `processENSIP10` allows one `multicall()` at the top of the inner data, and its subcalls cannot be `multicall()` either. There is no recursion limit option.
- **Results**: a tuple is ABI-encoded with the function outputs, and `Hex`/`Uint8Array` is treated as already encoded. Returning nothing is only allowed (by type) for functions without outputs.
- **Options are private**: `EZCCIP` copies its options at construction. Don't add a public `options` property; expose a getter if something is needed (eg. `signerAddress`, `protocol`).
- **Protocol is resolved late**: `ReadState.protocol` may be `undefined`, meaning `"ens"` with a signer, otherwise `"raw"` (`defaultProtocol`), so handlers can set `ctx.signer` alone.
- **Errors**: `CCIPReadError` messages and statuses reach clients (400 bad input, 404 unknown function/profile, 405 method). Any other error is a 500 with message `"internal error"` (see `publicErrorMessage`), and the real error goes to `onError` and `History`. Inside `multicall`, failed subcalls are encoded as `Error(string)` using the same rule.
- **Generic naming** follows viem: lowercase type parameters (`abiFunction`, `extra`), `XParameters` / `XReturnType` for function inputs and outputs, object parameters for public functions with more than two inputs.
- **`extra`** is one custom object (eg. `{ env }` on Cloudflare) typed by `EZCCIP<extra>` and passed as the third argument to handlers and `resolve`: `(args, ctx, extra)`. It is threaded through `#call` (including `multicall` subcalls), not stored on `CallContext`, so `CallContext` and the hook events are not generic. It's optional when the type allows `undefined`, otherwise required (see `ExtraParameter`).
- **Hooks** (`onResponse`, `onError`) are observers. They must never change or break a response; exceptions in hooks are swallowed.
- **No signal handlers or global side effects in `src/`.** `serveEZCCIP` logs, but process lifecycle belongs to the caller (see `scripts/demo.ts`).
- Public API changes should update `README.md` (including the migration section) and `src/index.ts`.

## Signing protocols

- `"ens"`: hash `keccak256(0x1900 . origin . uint64 expires . keccak256(request) . keccak256(result))`, response `abi.encode(bytes result, uint64 expires, bytes sig)`.
- `"tor"`: hash `keccak256(origin . uint64 expires . keccak256(request) . keccak256(result))`, response `abi.encode(bytes sig, uint64 expires, bytes result)`.
- `"raw"`: the result itself.

These layouts must match the onchain verifiers. `test/signing.test.ts` pins them; don't change them without a matching contract change.

## Testing

- Prefer calling `ezccip.fetch(new Request(...))` directly over starting servers. Use `Bun.serve({ port: 0 })` or `serveEZCCIP()` only for end-to-end tests (eg. viem `ccipRequest` interop), and always stop it.
- Build calldata with viem (`encodeFunctionData`, `parseAbiItem`) rather than hand-written hex.
