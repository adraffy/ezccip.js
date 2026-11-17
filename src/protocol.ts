import { AbiParameters, Address, Hash, Hex, Secp256k1, Signature } from "ox";
import type { Signer } from "./signer.ts";

/** Response signing protocol that requires a {@link Signer}. */
export type SignedProtocol = "ens" | "tor";

/**
 * Response signing protocol.
 * - `"raw"` &mdash; unsigned response (EVM Gateway, testing, etc.)
 * - `"ens"` &mdash; [ensdomains/offchain-resolver](https://github.com/ensdomains/offchain-resolver/)
 * - `"tor"` &mdash; [namestonehq/TheOffchainResolver.sol](https://github.com/namestonehq/TheOffchainResolver.sol)
 */
export type Protocol = "raw" | SignedProtocol;

const RESPONSE_TYPES = AbiParameters.from(["bytes", "uint64", "bytes"]);

export type ResponseHashParameters = {
	/** Address of the contract that will verify the response. */
	origin: Address.Address;
	/** Unix timestamp (seconds). */
	expires: bigint;
	/** Original calldata. */
	request: Hex.Hex;
	/** ABI-encoded answer. */
	result: Hex.Hex;
};

/**
 * Computes the hash signed by a protocol.
 * - `"ens"`: `keccak256(0x1900 . origin . expires . keccak256(request) . keccak256(result))`
 *   ([SignatureVerifier.sol](https://github.com/ensdomains/offchain-resolver/blob/main/packages/contracts/contracts/SignatureVerifier.sol))
 * - `"tor"`: `keccak256(origin . expires . keccak256(request) . keccak256(result))`
 *   ([TOR protocol](https://github.com/namestonehq/TheOffchainResolver.sol#tor-protocol))
 */
export function getResponseHash(
	protocol: SignedProtocol,
	{ origin, expires, request, result }: ResponseHashParameters
): Hex.Hex {
	const tail = [origin, expires, Hash.keccak256(request), Hash.keccak256(result)] as const;
	switch (protocol) {
		case "ens":
			return Hash.keccak256(
				AbiParameters.encodePacked(
					["bytes", "address", "uint64", "bytes32", "bytes32"],
					["0x1900", ...tail]
				)
			);
		case "tor":
			return Hash.keccak256(
				AbiParameters.encodePacked(["address", "uint64", "bytes32", "bytes32"], tail)
			);
		default:
			throw new TypeError(`unknown protocol: ${protocol}`);
	}
}

/**
 * Signs and encodes a response.
 * - `"ens"`: `abi.encode(result, expires, signature)`
 * - `"tor"`: `abi.encode(signature, expires, result)`
 */
export async function signResponse({
	protocol,
	signer,
	...parameters
}: ResponseHashParameters & { protocol: SignedProtocol; signer: Signer }): Promise<Hex.Hex> {
	const signature = await signer.sign({ hash: getResponseHash(protocol, parameters) });
	const { result, expires } = parameters;
	return AbiParameters.encode(
		RESPONSE_TYPES,
		protocol === "tor" ? [signature, expires, result] : [result, expires, signature]
	);
}

/** Decodes a signed response and recovers the signer. */
export function verifyResponse({
	protocol,
	response,
	request,
	origin,
}: {
	protocol: SignedProtocol;
	response: Hex.Hex;
	request: Hex.Hex;
	origin: Address.Address;
}): { result: Hex.Hex; expires: bigint; signer: Address.Address } {
	const [a, expires, b] = AbiParameters.decode(RESPONSE_TYPES, response);
	const [result, signature] = protocol === "tor" ? [b, a] : [a, b];
	const hash = getResponseHash(protocol, { origin, expires, request, result });
	const signer = Address.checksum(
		Secp256k1.recoverAddress({ payload: hash, signature: Signature.fromHex(signature) })
	);
	return { result, expires, signer };
}
