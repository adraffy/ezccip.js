import {
	type Address,
	decodeAbiParameters,
	encodeAbiParameters,
	encodePacked,
	getAddress,
	type Hex,
	isAddressEqual,
	keccak256,
	type LocalAccount,
	parseAbiParameters,
	recoverAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** Response signing protocol that requires a {@link Signer}. */
export type SignedProtocol = "ens" | "tor";

/**
 * Response signing protocol.
 * - `"raw"` &mdash; unsigned (EVM Gateway, testing, etc.)
 * - `"ens"` &mdash; [ensdomains/offchain-resolver](https://github.com/ensdomains/offchain-resolver/)
 * - `"tor"` &mdash; [namestonehq/TheOffchainResolver.sol](https://github.com/namestonehq/TheOffchainResolver.sol)
 */
export type Protocol = "raw" | SignedProtocol;

/** Signs raw 32-byte hashes, eg. a viem `LocalAccount`. */
export type Signer = Pick<LocalAccount, "address"> & Required<Pick<LocalAccount, "sign">>;

/** A private key or a {@link Signer}. */
export type SignerLike = Hex | Pick<LocalAccount, "address" | "sign">;

/** Normalizes a {@link SignerLike} into a {@link Signer}. */
export function toSigner(signer: SignerLike): Signer {
	if (typeof signer === "string") return privateKeyToAccount(signer);
	const { address, sign } = signer;
	if (!sign) throw new TypeError("signer must support sign({ hash })");
	return { address: getAddress(address), sign: sign.bind(signer) };
}

export type ResponseHashParameters = {
	protocol: SignedProtocol;
	/** Contract that will verify the response. */
	origin: Address;
	/** Unix timestamp in seconds. */
	expires: bigint;
	/** Calldata from `OffchainLookup`. */
	calldata: Hex;
	/** ABI-encoded answer. */
	result: Hex;
};

const RESPONSE_PARAMETERS = parseAbiParameters("bytes, uint64, bytes");

/**
 * Computes the hash a protocol signs.
 * - `"ens"`: `keccak256(0x1900 . origin . expires . keccak256(calldata) . keccak256(result))`
 *   ([SignatureVerifier.sol](https://github.com/ensdomains/offchain-resolver/blob/main/packages/contracts/contracts/SignatureVerifier.sol))
 * - `"tor"`: `keccak256(origin . expires . keccak256(calldata) . keccak256(result))`
 *   ([TOR protocol](https://github.com/namestonehq/TheOffchainResolver.sol#tor-protocol))
 */
export function getResponseHash({ protocol, origin, expires, calldata, result }: ResponseHashParameters): Hex {
	const values = [origin, expires, keccak256(calldata), keccak256(result)] as const;
	switch (protocol) {
		case "ens":
			return keccak256(encodePacked(["bytes", "address", "uint64", "bytes32", "bytes32"], ["0x1900", ...values]));
		case "tor":
			return keccak256(encodePacked(["address", "uint64", "bytes32", "bytes32"], values));
		default:
			throw new TypeError(`unknown protocol: ${protocol satisfies never}`);
	}
}

/**
 * Signs and encodes a response.
 * - `"ens"`: `abi.encode(result, expires, signature)`
 * - `"tor"`: `abi.encode(signature, expires, result)`
 */
export async function signResponse({
	signer,
	...parameters
}: ResponseHashParameters & { signer: Signer }): Promise<Hex> {
	const signature = await signer.sign({ hash: getResponseHash(parameters) });
	const { protocol, result, expires } = parameters;
	return encodeAbiParameters(
		RESPONSE_PARAMETERS,
		protocol === "tor" ? [signature, expires, result] : [result, expires, signature],
	);
}

export type VerifyResponseParameters = {
	protocol: SignedProtocol;
	/** Signed response from the gateway. */
	response: Hex;
	/** Calldata that was sent to the gateway. */
	calldata: Hex;
	/** Contract that verifies the response. */
	origin: Address;
	/** Expected signer. If set, a different signer throws. */
	signer?: Address | undefined;
	/** Current time in seconds, to check expiry. (default: now) */
	now?: number | bigint | undefined;
};

/**
 * Decodes a signed response, recovers its signer, and checks it the way the onchain verifier would:
 * throws if it has expired, or if `signer` is set and doesn't match.
 */
export async function verifyResponse({
	protocol,
	response,
	calldata,
	origin,
	signer: expected,
	now = Math.floor(Date.now() / 1000),
}: VerifyResponseParameters): Promise<{ result: Hex; expires: bigint; signer: Address }> {
	const [a, expires, b] = decodeAbiParameters(RESPONSE_PARAMETERS, response);
	const [result, signature] = protocol === "tor" ? [b, a] : [a, b];
	const hash = getResponseHash({ protocol, origin, expires, calldata, result });
	const signer = await recoverAddress({ hash, signature });
	if (expires <= BigInt(now)) throw new Error(`response expired at ${expires}`);
	if (expected && !isAddressEqual(signer, expected)) throw new Error(`unexpected signer: ${signer}`);
	return { result, expires, signer };
}
