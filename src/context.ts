import type { Address, Hex } from "viem";
import type { History } from "./history.js";
import { type Protocol, type Signer, type SignerLike, toSigner } from "./signing.js";

/** Request-wide state, shared by every {@link CallContext} of a request. */
export type ReadState<extra = undefined> = {
	readonly sender: Address;
	readonly request: Request | undefined;
	readonly extra: extra;
	origin: Address;
	/** `undefined` means: `"ens"` with a signer, otherwise `"raw"`. */
	protocol: Protocol | undefined;
	signer: Signer | undefined;
	ttl: number;
};

/** The protocol used when none is set. */
export function defaultProtocol(signer: Signer | undefined): Protocol {
	return signer ? "ens" : "raw";
}

/**
 * Passed to every handler. One per call: the outer call, each `multicall()` subcall, and so on.
 *
 * `calldata` and `history` belong to this call. Everything else is shared by the whole request:
 * setting `ctx.protocol` in any call changes how the entire response is signed.
 *
 * @typeParam extra - Custom object passed with each request, eg. `{ env }` on Cloudflare.
 */
export class CallContext<extra = undefined> {
	readonly #state: ReadState<extra>;
	/** Calldata of this call. */
	readonly calldata: Hex;
	/** Log entry for this call. */
	readonly history: History;

	constructor(state: ReadState<extra>, calldata: Hex, history: History) {
		this.#state = state;
		this.calldata = calldata;
		this.history = history;
		history.calldata = calldata;
	}

	/** Creates the context for a call made inside this one. */
	nested(calldata: Hex, history: History): CallContext<extra> {
		return new CallContext(this.#state, calldata, history);
	}

	/** Contract that reverted with `OffchainLookup`. */
	get sender(): Address {
		return this.#state.sender;
	}
	/** The HTTP request, if any. */
	get request(): Request | undefined {
		return this.#state.request;
	}
	/** Custom object passed with the request. */
	get extra(): extra {
		return this.#state.extra;
	}

	/** Contract that will verify the response. */
	get origin(): Address {
		return this.#state.origin;
	}
	set origin(origin: Address) {
		this.#state.origin = origin;
	}
	/** Signing protocol. (default: `"ens"` with a signer, otherwise `"raw"`) */
	get protocol(): Protocol {
		return this.#state.protocol ?? defaultProtocol(this.#state.signer);
	}
	set protocol(protocol: Protocol) {
		this.#state.protocol = protocol;
	}
	get signer(): Signer | undefined {
		return this.#state.signer;
	}
	set signer(signer: SignerLike | undefined) {
		this.#state.signer = signer ? toSigner(signer) : undefined;
	}
	/** Response lifetime in seconds. */
	get ttl(): number {
		return this.#state.ttl;
	}
	set ttl(ttl: number) {
		this.#state.ttl = ttl;
	}
}
