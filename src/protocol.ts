import { AbiParameters, Address, Hash, Hex, Secp256k1, Signature } from "ox";
import type { Signer } from "./signer.ts";

/**
 * Response signing protocol.
 * - `"raw"` &mdash; unsigned response (EVM Gateway, testing, etc.)
 * - `"ens"` &mdash; [ensdomains/offchain-resolver](https://github.com/ensdomains/offchain-resolver/)
 */
export type Protocol = "raw" | "ens";

const ENS_RESPONSE = AbiParameters.from(["bytes", "uint64", "bytes"]);

type ENSHashParameters = {
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
 * Computes the hash signed by the `"ens"` protocol.
 * @see https://github.com/ensdomains/offchain-resolver/blob/main/packages/contracts/contracts/SignatureVerifier.sol
 */
export function getENSResponseHash({
	origin,
	expires,
	request,
	result,
}: ENSHashParameters): Hex.Hex {
	return Hash.keccak256(
		AbiParameters.encodePacked(
			["bytes", "address", "uint64", "bytes32", "bytes32"],
			["0x1900", origin, expires, Hash.keccak256(request), Hash.keccak256(result)]
		)
	);
}

/** Signs and encodes a response using the `"ens"` protocol: `abi.encode(result, expires, signature)`. */
export async function encodeENSResponse({
	signer,
	...parameters
}: ENSHashParameters & { signer: Signer }): Promise<Hex.Hex> {
	const signature = await signer.sign({ hash: getENSResponseHash(parameters) });
	return AbiParameters.encode(ENS_RESPONSE, [
		parameters.result,
		parameters.expires,
		signature,
	]);
}

/** Decodes a response from the `"ens"` protocol and recovers the signer. */
export function decodeENSResponse({
	response,
	request,
	origin,
}: {
	response: Hex.Hex;
	request: Hex.Hex;
	origin: Address.Address;
}): { result: Hex.Hex; expires: bigint; signer: Address.Address } {
	const [result, expires, signature] = AbiParameters.decode(ENS_RESPONSE, response);
	const hash = getENSResponseHash({ origin, expires, request, result });
	const signer = Address.checksum(
		Secp256k1.recoverAddress({ payload: hash, signature: Signature.fromHex(signature) })
	);
	return { result, expires, signer };
}
