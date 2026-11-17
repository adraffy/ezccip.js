import { Address, Hex, Secp256k1, Signature } from "ox";
import type { Awaitable } from "./utils.ts";

/** Signs a 32-byte hash and returns a 65-byte `(r, s, v)` signature. */
export type Signer = {
	readonly address: Address.Address;
	sign(parameters: { hash: Hex.Hex }): Awaitable<Hex.Hex>;
};

/**
 * A private key or anything that can sign a raw hash,
 * eg. a viem `LocalAccount` from `privateKeyToAccount()`.
 */
export type SignerLike =
	| Hex.Hex
	| {
			readonly address: Address.Address;
			sign?: ((parameters: { hash: Hex.Hex }) => Awaitable<Hex.Hex>) | undefined;
	  };

/** Creates a {@link Signer} from a private key. */
export function privateKeyToSigner(privateKey: Hex.Hex): Signer {
	const address = Address.fromPublicKey(Secp256k1.getPublicKey({ privateKey }), {
		checksum: true,
	});
	return {
		address,
		sign: ({ hash }) =>
			Signature.toHex(Secp256k1.sign({ payload: hash, privateKey })),
	};
}

/** Normalizes a {@link SignerLike} into a {@link Signer}. */
export function toSigner(signer: SignerLike): Signer {
	if (typeof signer === "string") return privateKeyToSigner(signer);
	const { address, sign } = signer;
	if (!sign) throw new TypeError("signer must support sign({ hash })");
	return { address: Address.checksum(address), sign: sign.bind(signer) };
}
