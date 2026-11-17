import { parseAbiItem } from "viem";

export const RESOLVE = parseAbiItem("function resolve(bytes name, bytes data) view returns (bytes)");
export const MULTICALL = parseAbiItem("function multicall(bytes[] calls) view returns (bytes[])");
export const UNSUPPORTED_RESOLVER_PROFILE = parseAbiItem("error UnsupportedResolverProfile(bytes4 selector)");
export const UNREACHABLE_NAME = parseAbiItem("error UnreachableName(bytes name)");

// resolver profiles answered by processENSIP10()
export const NAME = parseAbiItem("function name(bytes32 node) view returns (string)");
export const ADDR = parseAbiItem("function addr(bytes32 node) view returns (address)");
export const ADDR_COIN_TYPE = parseAbiItem("function addr(bytes32 node, uint256 coinType) view returns (bytes)");
export const HAS_ADDR = parseAbiItem("function hasAddr(bytes32 node, uint256 coinType) view returns (bool)");
export const DATA = parseAbiItem("function data(bytes32 node, string key) view returns (bytes)");
export const TEXT = parseAbiItem("function text(bytes32 node, string key) view returns (string)");
export const CONTENTHASH = parseAbiItem("function contenthash(bytes32 node) view returns (bytes)");
export const PUBKEY = parseAbiItem("function pubkey(bytes32 node) view returns (uint256 x, uint256 y)");
export const ABI = parseAbiItem(
	"function ABI(bytes32 node, uint256 contentTypes) view returns (uint256 contentType, bytes data)",
);

/**
 * [ENSIP-10](https://docs.ens.domains/ensip/10) resolver ABI: `resolve()`, `multicall()`,
 * the profiles answered by `processENSIP10()`, and its errors.
 */
export const resolverAbi = [
	RESOLVE,
	MULTICALL,
	NAME,
	ADDR,
	ADDR_COIN_TYPE,
	HAS_ADDR,
	DATA,
	TEXT,
	CONTENTHASH,
	PUBKEY,
	ABI,
	UNSUPPORTED_RESOLVER_PROFILE,
	UNREACHABLE_NAME,
] as const;
