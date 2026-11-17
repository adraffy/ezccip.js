/** [ENSIP-9](https://docs.ens.domains/ensip/9) coin type for Ethereum. */
export const COIN_TYPE_ETH = 60n;

/** [ENSIP-19](https://docs.ens.domains/ensip/19) default EVM coin type. */
export const COIN_TYPE_DEFAULT = 0x8000_0000n;

/** Returns the EVM chain id of an [ENSIP-11](https://docs.ens.domains/ensip/11) coin type, or `0` if not EVM. */
export function chainFromCoinType(coinType: bigint): number {
	if (coinType === COIN_TYPE_ETH) return 1;
	const chain = coinType ^ COIN_TYPE_DEFAULT;
	return chain >= 0n && chain < COIN_TYPE_DEFAULT ? Number(chain) : 0;
}

/** Short description of a coin type for logging, eg. `evm:10`. */
export function formatCoinType(coinType: bigint): string {
	const chain = coinType ^ COIN_TYPE_DEFAULT;
	return chain < COIN_TYPE_DEFAULT ? `evm:${chain}` : String(coinType);
}
