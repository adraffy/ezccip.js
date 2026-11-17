import { encodeErrorResult, type Hex, parseAbiItem } from "viem";

/** An error with an HTTP status code. */
export class CCIPReadError extends Error {
	override name = "CCIPReadError";
	readonly status: number;

	constructor(message: string, { status = 500, cause }: { status?: number; cause?: unknown } = {}) {
		super(message, { cause });
		this.status = status;
	}
}

const SOLIDITY_ERROR = parseAbiItem("error Error(string)");

/** Encodes an error as revert data: `Error(string)`. */
export function encodeErrorString(error: unknown): Hex {
	const message = error instanceof Error ? error.message : String(error);
	return encodeErrorResult({ abi: [SOLIDITY_ERROR], args: [message] });
}
