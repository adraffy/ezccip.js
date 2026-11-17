import { encodeErrorResult, type Hex, parseAbiItem } from "viem";

/**
 * An error that is safe to show to clients, with an HTTP status code.
 * Messages of other errors are replaced with `"internal error"` in responses.
 */
export class CCIPReadError extends Error {
	override name = "CCIPReadError";
	readonly status: number;

	constructor(message: string, { status = 500, cause }: { status?: number; cause?: unknown } = {}) {
		super(message, { cause });
		this.status = status;
	}
}

/** The message a client may see: a {@link CCIPReadError} message, otherwise `"internal error"`. */
export function publicErrorMessage(error: unknown): string {
	return error instanceof CCIPReadError ? error.message : "internal error";
}

const SOLIDITY_ERROR = parseAbiItem("error Error(string)");

/** Encodes revert data `Error(string)`. Errors are encoded with {@link publicErrorMessage}. */
export function encodeErrorString(error: unknown): Hex {
	const message = typeof error === "string" ? error : publicErrorMessage(error);
	return encodeErrorResult({ abi: [SOLIDITY_ERROR], args: [message] });
}
