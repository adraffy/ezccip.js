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
```

Before finishing a change, run `bun run check && bun run lint && bun test`. If you touch exports, types, or imports in `src/`, also run `bun run build` and make sure `dist/*.d.ts` contains no `.ts` import specifiers.

## Stack and constraints

- **Bun** for tooling and tests. The library itself is runtime-agnostic except `src/serve.ts` (uses `Bun.serve`).
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
  errors.ts     CCIPReadError (carries HTTP status), encodeErrorString
  serve.ts      serveEZCCIP(): Bun-only quick server, separate export "@namestone/ezccip/serve"
  utils.ts      small internal helpers (some re-exported, eg. asciiize)
  ens/
    abi.ts      RESOLVE_ABI and its items (RESOLVE, MULTICALL, errors)
    ensip10.ts  ENSRecord, processENSIP10, createENSIP10Handler
    coin-type.ts, dns.ts
scripts/demo.ts demo server
test/           mirrors src/ (test/ens/* for src/ens/*)
```

## Conventions

- **Relative imports use `.js` extensions** (`import { x } from "./http.js"`), even though the files are `.ts`. `tsc` does not rewrite `.ts` specifiers inside emitted `.d.ts` files, so `.ts` imports break consumers.
- **Types come from the ABI.** `addHandler()` takes one function (a human-readable signature, with or without the `function` prefix, or a viem `AbiFunction`), and the handler's `args` and return tuple are inferred from it. Keep this inference working, and add `expectTypeOf` / `@ts-expect-error` checks in tests when you change handler or context types.
- **Handler signature** is `(args, ctx) => result`. `ctx` is a `CallContext`, created per call, that reads and writes one request-wide `ReadState`: `origin`, `protocol`, `signer`, and `ttl` are intentionally mutable and shared by every call in the request. `ctx.history` belongs to that call only. Nested calls get their context from `ctx.nested(history)`.
- **Multicall** is only answered as the outer call; subcalls cannot be `multicall()`. Inside `resolve()`, `processENSIP10` allows one `multicall()` at the top of the inner data, and its subcalls cannot be `multicall()` either. There is no recursion limit option.
- **Results**: a tuple is ABI-encoded with the function outputs, `Hex`/`Uint8Array` is treated as already encoded, and falsy means `returns ()`.
- **Errors**: throw `CCIPReadError` with a `status` for client errors (400/405). Other errors become 500. Inside `multicall`, per-call failures are encoded as `Error(string)` instead of failing the whole request.
- **Generic naming** follows viem: lowercase type parameters (`abiFunction`, `extra`), `XParameters` / `XReturnType` for function inputs and outputs, object parameters for public functions with more than two inputs.
- **`extra`** is one custom object (eg. `{ env }` on Cloudflare) typed by `EZCCIP<extra>` and read as `ctx.extra`. Never spread it into the context. It's optional when the type allows `undefined`, otherwise required (see `ExtraParameter`).
- **Hooks** (`onResponse`, `onError`) are observers. They must never change or break a response; exceptions in hooks are swallowed.
- **No signal handlers or global side effects in `src/`.** `serveEZCCIP` logs, but process lifecycle belongs to the caller (see `scripts/demo.ts`).
- Public API changes should update `README.md` (including the migration section) and `src/index.ts`.

## Signing protocols

- `"ens"`: hash `keccak256(0x1900 . origin . uint64 expires . keccak256(request) . keccak256(result))`, response `abi.encode(bytes result, uint64 expires, bytes sig)`.
- `"tor"`: hash `keccak256(origin . uint64 expires . keccak256(request) . keccak256(result))`, response `abi.encode(bytes sig, uint64 expires, bytes result)`.
- `"raw"`: the result itself.

These layouts must match the onchain verifiers. `test/signing.test.ts` pins them; don't change them without a matching contract change.

## Testing

- Prefer calling `ezccip.fetch(new Request(...))` directly over starting servers. Use `Bun.serve({ port: 0 })` only for end-to-end tests (eg. viem `ccipRequest` interop), and always stop it.
- Build calldata with viem (`encodeFunctionData`, `parseAbiItem`) rather than hand-written hex.
