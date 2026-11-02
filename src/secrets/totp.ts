/**
 * RFC 6238 TOTP for KeePass entries. Layouts seen in the wild, all read here:
 *  - KeePassXC: `otp` = `otpauth://totp/...?secret=...&period=&digits=&algorithm=` (also written by most authenticator exports)
 *  - KeeOtp / old KeePassXC: `otp` = `key=BASE32&size=6&step=30&otpHashMode=Sha1`
 *  - a bare base32 secret in `otp`
 *  - KeePass 2 / KeeTrayTOTP: `TimeOtp-Secret` (UTF-8) or `-Hex` / `-Base32` / `-Base64`, plus `TimeOtp-Length|Period|Algorithm`
 */

import { createHmac } from "node:crypto";

export class TotpError extends Error {}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(input: string): Buffer {
	const clean = input.replace(/[\s=-]/g, "").toUpperCase();
	if (!clean || /[^A-Z2-7]/.test(clean)) throw new TotpError("TOTP secret is not valid base32");
	let bits = 0, value = 0;
	const out: number[] = [];
	for (const ch of clean) {
		value = (value << 5) | B32.indexOf(ch);
		bits += 5;
		if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
	}
	return Buffer.from(out);
}

export interface TotpParams { secret: Buffer; digits: number; period: number; algorithm: "sha1" | "sha256" | "sha512" }

const ALGS: Record<string, TotpParams["algorithm"]> = { SHA1: "sha1", "HMAC-SHA-1": "sha1", SHA256: "sha256", "HMAC-SHA-256": "sha256", SHA512: "sha512", "HMAC-SHA-512": "sha512" };

function checked(secret: Buffer, digits: number, period: number, algorithm: TotpParams["algorithm"] | undefined): TotpParams {
	if (!secret.length) throw new TotpError("TOTP secret is empty");
	if (!Number.isInteger(digits) || digits < 6 || digits > 10) throw new TotpError("unsupported digit count");
	if (!Number.isInteger(period) || period < 1 || period > 300) throw new TotpError("unsupported period");
	if (!algorithm) throw new TotpError("unsupported OTP algorithm");
	return { secret, digits, period, algorithm };
}

/** The `otp` attribute: an otpauth URI, a KeeOtp `key=...&step=...` string, or a bare base32 secret. */
export function parseOtpAuth(value: string): TotpParams {
	const v = value.trim();
	if (!/^otpauth:/i.test(v) && /(?:^|&)key=/i.test(v)) {
		const q = new URLSearchParams(v);
		const get = (n: string): string | null => { for (const [k, val] of q) if (k.toLowerCase() === n.toLowerCase()) return val; return null; };
		if ((get("type") ?? get("encoder") ?? "").toLowerCase() === "steam") throw new TotpError("Steam Guard codes are not supported");
		return checked(base32Decode(get("key") ?? ""), Number(get("size") ?? 6), Number(get("step") ?? 30), ALGS[(get("otpHashMode") ?? get("algorithm") ?? "SHA1").toUpperCase()]);
	}
	if (!/^otpauth:/i.test(v)) return { secret: base32Decode(v), digits: 6, period: 30, algorithm: "sha1" };
	let url: URL;
	try { url = new URL(v); } catch { throw new TotpError("unparseable otpauth URI"); }
	if (url.hostname.toLowerCase() !== "totp") throw new TotpError(`unsupported OTP type: ${url.hostname}`);
	if ((url.searchParams.get("encoder") ?? "").toLowerCase() === "steam") throw new TotpError("Steam Guard codes are not supported");
	const secret = url.searchParams.get("secret");
	if (!secret) throw new TotpError("otpauth URI has no secret");
	return checked(base32Decode(secret), Number(url.searchParams.get("digits") ?? 6), Number(url.searchParams.get("period") ?? 30), ALGS[(url.searchParams.get("algorithm") ?? "SHA1").toUpperCase()]);
}

/** KeePass 2 style `TimeOtp-*` custom fields. Returns null when the entry has none. */
export function timeOtpParams(get: (name: string) => string | undefined): TotpParams | null {
	const b32 = get("TimeOtp-Secret-Base32"), hex = get("TimeOtp-Secret-Hex"), b64 = get("TimeOtp-Secret-Base64"), utf = get("TimeOtp-Secret");
	let secret: Buffer;
	if (b32) secret = base32Decode(b32);
	else if (hex) {
		const h = hex.replace(/\s/g, "");
		if (!/^(?:[0-9a-f]{2})+$/i.test(h)) throw new TotpError("TimeOtp-Secret-Hex is not valid hex");
		secret = Buffer.from(h, "hex");
	} else if (b64) secret = Buffer.from(b64.trim(), "base64");
	else if (utf) secret = Buffer.from(utf, "utf8");
	else return null;
	return checked(secret, Number(get("TimeOtp-Length") || 6), Number(get("TimeOtp-Period") || 30), ALGS[(get("TimeOtp-Algorithm") || "HMAC-SHA-1").toUpperCase()]);
}

export function totpAt(p: TotpParams, epochMs: number): string {
	const counter = Math.floor(epochMs / 1000 / p.period);
	const msg = Buffer.alloc(8);
	msg.writeBigUInt64BE(BigInt(counter));
	const h = createHmac(p.algorithm, p.secret).update(msg).digest();
	const off = h[h.length - 1]! & 0x0f;
	const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
	return String(bin % 10 ** p.digits).padStart(p.digits, "0");
}

/** Seconds until the current code stops being valid. */
export function totpRemaining(p: TotpParams, epochMs: number): number {
	return p.period - (Math.floor(epochMs / 1000) % p.period);
}
