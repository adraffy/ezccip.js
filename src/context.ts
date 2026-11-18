import type { Address, Hex } from "viem";
import type { Protocol, SignerLike } from "./signing.js";

/**
 * State of one request, passed to every handler as `ctx`. One object is shared by the whole request
 * (the outer call and every `multicall()` subcall), so a handler that changes `protocol`, `signer`,
 * `ttl`, or `origin` changes how the entire response is signed. They are validated when signing.
 */
export type ReadContext = {
	/** Contract that reverted with `OffchainLookup`. */
	readonly sender: Address;
	/** Calldata of the request. */
	readonly calldata: Hex;
	/** Contract that will verify the response. */
	origin: Address;
	/** Chain of the origin, if the request says, eg. from the gateway URL. */
	readonly chainId: number | undefined;
	/** Signing protocol. */
	protocol: Protocol;
	/** A private key or eg. a viem `LocalAccount`. */
	signer: SignerLike | undefined;
	/** Response lifetime in seconds. */
	ttl: number;
	/** Custom values from the caller of `handleRequest()`, eg. `ip` from `serveEZCCIP()`. */
	extra: Record<string, unknown>;
};
