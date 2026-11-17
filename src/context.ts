import { type Address, getAddress, type Hex, isAddress } from "viem";
import { History } from "./history.js";
import { type Protocol, type Signer, type SignerLike, toSigner } from "./signing.js";
import { checkTTL } from "./utils.js";

/**
 * Passed to every handler. One per call: the outer call, each `multicall()` subcall, and so on.
 *
 * `calldata` and `history` belong to this call. Everything else is shared by the whole request:
 * setting `ctx.protocol` in any call changes how the entire response is signed.
 */
export interface CallContext {
	/** Calldata of this call. */
	readonly calldata: Hex;
	/** Log entry for this call: rename it or replace the shown arguments. */
	readonly history: History;
	/** Contract that reverted with `OffchainLookup`. */
	readonly sender: Address;
	/** The HTTP request, if any. */
	readonly request: Request | undefined;
	/** Contract that will verify the response. */
	get origin(): Address;
	set origin(origin: Address);
	/** Signing protocol. (default: `"ens"` with a signer, otherwise `"raw"`) */
	get protocol(): Protocol;
	set protocol(protocol: Protocol);
	get signer(): Signer | undefined;
	set signer(signer: SignerLike | undefined);
	/** Response lifetime in seconds. */
	get ttl(): number;
	set ttl(ttl: number);
}

/** Request-wide state, shared by every context of a request. */
export type ReadState = {
	readonly sender: Address;
	readonly request: Request | undefined;
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

/** @internal Implementation of {@link CallContext}. */
export class Context implements CallContext {
	readonly #state: ReadState;
	readonly calldata: Hex;
	readonly history: History;

	constructor(state: ReadState, calldata: Hex, history = new History(calldata)) {
		this.#state = state;
		this.calldata = calldata;
		this.history = history;
	}

	/** Context for a `multicall()` subcall. */
	child(calldata: Hex): Context {
		return new Context(this.#state, calldata, this.history.addChild(calldata));
	}

	get sender(): Address {
		return this.#state.sender;
	}
	get request(): Request | undefined {
		return this.#state.request;
	}
	get origin(): Address {
		return this.#state.origin;
	}
	set origin(origin: Address) {
		if (!isAddress(origin, { strict: false })) throw new TypeError(`invalid origin: ${origin}`);
		this.#state.origin = getAddress(origin);
	}
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
	get ttl(): number {
		return this.#state.ttl;
	}
	set ttl(ttl: number) {
		this.#state.ttl = checkTTL(ttl);
	}
}
