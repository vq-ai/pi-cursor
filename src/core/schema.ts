import { type TUnsafe, Type } from "typebox";

/** A plain JSON Schema string enum, which every provider accepts, with a usable static type. */
export function stringEnum<const T extends readonly string[]>(values: T, options?: { description?: string }): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...options });
}
