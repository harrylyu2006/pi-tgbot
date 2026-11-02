/**
 * Browser → daemon envelope, independent of TLS.
 *
 * Why a second layer: the input page sits behind nginx, and the nginx → daemon
 * hop is plain HTTP on loopback. Anything that logs request bodies or sniffs
 * that hop (a debug log, a future CDN, a packet capture) would otherwise see the
 * password. Instead the page encrypts the value in the browser to a *one-time*
 * P-256 key minted for this link; the matching private key exists only in this
 * process's memory and is dropped as soon as the link is used or expires.
 *
 *   key = HKDF-SHA256(ECDH(client_eph, server_eph),
 *                     salt = token, info = label || server_pub || client_pub)
 *   body = AES-256-GCM(key, iv, plaintext, aad = token)
 *
 * What this does NOT do: defeat an attacker who can already serve the page's
 * JavaScript (they could swap the public key). That attacker owns the host.
 */

import { webcrypto } from "node:crypto";

type CryptoKey = webcrypto.CryptoKey;
type CryptoKeyPair = webcrypto.CryptoKeyPair;
const subtle = webcrypto.subtle;
const LABEL = "pi-tg-secret-v1";
const te = new TextEncoder();

export const b64u = {
	enc(bytes: Uint8Array): string { return Buffer.from(bytes).toString("base64url"); },
	dec(s: string): Uint8Array<ArrayBuffer> {
		if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("bad base64url");
		const buf = Buffer.from(s, "base64url");
		return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
	},
};

export interface LinkKey {
	publicRaw: Uint8Array;
	privateKey: CryptoKey;
}

export async function newLinkKey(): Promise<LinkKey> {
	const kp = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])) as CryptoKeyPair;
	return { publicRaw: new Uint8Array(await subtle.exportKey("raw", kp.publicKey)), privateKey: kp.privateKey };
}

export interface Envelope { epk: string; iv: string; ct: string }

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let off = 0;
	for (const p of parts) { out.set(p, off); off += p.length; }
	return out;
}

/** Returns the decrypted UTF-8 plaintext; throws on any malformed or forged input. */
export async function openEnvelope(key: LinkKey, token: string, env: Envelope): Promise<string> {
	const clientPubRaw = b64u.dec(env.epk);
	const iv = b64u.dec(env.iv);
	const ct = b64u.dec(env.ct);
	if (clientPubRaw.length !== 65 || clientPubRaw[0] !== 4) throw new Error("bad ephemeral key");
	if (iv.length !== 12) throw new Error("bad iv");
	if (ct.length < 17 || ct.length > 200_000) throw new Error("bad ciphertext size");
	const clientPub = await subtle.importKey("raw", clientPubRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
	const bits = await subtle.deriveBits({ name: "ECDH", public: clientPub }, key.privateKey, 256);
	const hk = await subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
	const aes = await subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: te.encode(token), info: concat(te.encode(LABEL), key.publicRaw, clientPubRaw) },
		hk, { name: "AES-GCM", length: 256 }, false, ["decrypt"],
	);
	const pt = await subtle.decrypt({ name: "AES-GCM", iv, additionalData: te.encode(token) }, aes, ct);
	return new TextDecoder("utf-8", { fatal: true }).decode(pt);
}

/**
 * The browser half, as source text. It is embedded verbatim in the page and also
 * evaluated by the test suite under Node's WebCrypto, so the code that runs on
 * the phone is the code that is tested.
 */
export const CLIENT_CRYPTO_JS = `
const piB64u = {
  enc(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, ''); },
  dec(str) { str = str.replace(/-/g, '+').replace(/_/g, '/'); while (str.length % 4) str += '='; const bin = atob(str); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; },
};
async function piSealSecret(serverPubB64u, token, plaintext) {
  if (!globalThis.crypto || !crypto.subtle) throw new Error('no-webcrypto');
  const te = new TextEncoder();
  const serverPubRaw = piB64u.dec(serverPubB64u);
  const serverPub = await crypto.subtle.importKey('raw', serverPubRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const clientPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: serverPub }, kp.privateKey, 256);
  const hk = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const label = te.encode('${LABEL}');
  const info = new Uint8Array(label.length + serverPubRaw.length + clientPubRaw.length);
  info.set(label, 0); info.set(serverPubRaw, label.length); info.set(clientPubRaw, label.length + serverPubRaw.length);
  const aes = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: te.encode(token), info }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(token) }, aes, te.encode(plaintext)));
  return { epk: piB64u.enc(clientPubRaw), iv: piB64u.enc(iv), ct: piB64u.enc(ct) };
}
`;
