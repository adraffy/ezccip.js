/** [ENSIP-9](https://docs.ens.domains/ensip/9) coin type for Ethereum. */
export const COIN_TYPE_ETH = 60n;

/** [ENSIP-19](https://docs.ens.domains/ensip/19) default EVM coin type. */
export const COIN_TYPE_DEFAULT = 0x8000_0000n;

/**
 * Returns the EVM chain id of an [ENSIP-11](https://docs.ens.domains/ensip/11) coin type,
 * `0` for {@link COIN_TYPE_DEFAULT}, or `undefined` if the coin type is not EVM.
 */
export function chainFromCoinType(coinType: bigint): number | undefined {
	if (coinType === COIN_TYPE_ETH) return 1;
	const chain = coinType ^ COIN_TYPE_DEFAULT;
	return chain >= 0n && chain < COIN_TYPE_DEFAULT ? Number(chain) : undefined;
}

/** Short description of a coin type for logging: `evm:{chain}` for EVM coin types (eg. `evm:1` for `60`), otherwise the number. */
export function formatCoinType(coinType: bigint): string {
	const chain = chainFromCoinType(coinType);
	return chain === undefined ? String(coinType) : `evm:${chain}`;
}
