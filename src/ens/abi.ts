import { getAbiItem, parseAbi } from "viem";

/** [ENSIP-10](https://docs.ens.domains/ensip/10) resolver ABI with the supported profiles. */
export const RESOLVE_ABI = parseAbi([
	"function resolve(bytes name, bytes data) view returns (bytes)",
	"function multicall(bytes[] calls) view returns (bytes[])",
	//
	"function name(bytes32 node) view returns (string)",
	"function addr(bytes32 node) view returns (address)",
	"function addr(bytes32 node, uint256 coinType) view returns (bytes)",
	"function hasAddr(bytes32 node, uint256 coinType) view returns (bool)",
	"function data(bytes32 node, string key) view returns (bytes)",
	"function text(bytes32 node, string key) view returns (string)",
	"function contenthash(bytes32 node) view returns (bytes)",
	"function pubkey(bytes32 node) view returns (uint256 x, uint256 y)",
	"function ABI(bytes32 node, uint256 contentTypes) view returns (uint256 contentType, bytes data)",
	//
	"error UnsupportedResolverProfile(bytes4 selector)",
	"error UnreachableName(bytes name)",
]);

export const RESOLVE = getAbiItem({ abi: RESOLVE_ABI, name: "resolve" });
export const MULTICALL = getAbiItem({ abi: RESOLVE_ABI, name: "multicall" });
export const UNSUPPORTED_RESOLVER_PROFILE = getAbiItem({ abi: RESOLVE_ABI, name: "UnsupportedResolverProfile" });
export const UNREACHABLE_NAME = getAbiItem({ abi: RESOLVE_ABI, name: "UnreachableName" });
