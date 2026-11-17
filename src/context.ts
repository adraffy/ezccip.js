import type { Address, Hex } from "viem";
import type { History } from "./history.js";
import { type Protocol, type Signer, type SignerLike, toSigner } from "./signing.js";

/** Request-wide state, shared by every {@link CallContext} of a request. */
export type ReadState<extra = undefined> = {
	readonly sender: Address;
	readonly calldata: Hex;
	readonly request: Request | undefined;
	readonly extra: extra;
	origin: Address;
	protocol: Protocol;
	signer: Signer | undefined;
	ttl: number;
};

/**
 * Passed to every handler. One per call: the outer call, each `multicall()` subcall, and so on.
 *
 * Request fields (`sender`, `calldata`, `request`, `extra`) and response fields
 * (`origin`, `protocol`, `signer`, `ttl`) are shared by the whole request:
 * setting `ctx.protocol` in any call changes how the entire response is signed.
 * {@link history} belongs to this call only.
 *
 * @typeParam extra - Custom object passed with each request, eg. `{ env }` on Cloudflare.
 */
export class CallContext<extra = undefined> {
	readonly #state: ReadState<extra>;
	/** Log entry for this call. */
	readonly history: History;

	constructor(state: ReadState<extra>, history: History) {
		this.#state = state;
		this.history = history;
	}

	/** Creates the context for a call made inside this one. */
	nested(history: History): CallContext<extra> {
		return new CallContext(this.#state, history);
	}

	/** Contract that reverted with `OffchainLookup`. */
	get sender(): Address {
		return this.#state.sender;
	}
	/** Calldata of the request (lowercase). For this call's calldata, see `history.calldata`. */
	get calldata(): Hex {
		return this.#state.calldata;
	}
	/** The HTTP request, if any. */
	get request(): Request | undefined {
		return this.#state.request;
	}
	/** Custom object passed with the request. */
	get extra(): extra {
		return this.#state.extra;
	}

	/** Contract that will verify the response. (default: `sender`) */
	get origin(): Address {
		return this.#state.origin;
	}
	set origin(origin: Address) {
		this.#state.origin = origin;
	}
	get protocol(): Protocol {
		return this.#state.protocol;
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
