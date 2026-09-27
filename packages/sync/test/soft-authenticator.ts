/**
 * A minimal software WebAuthn authenticator (platform, resident keys, ES256,
 * "none" attestation) built on WebCrypto, so passkey flows can be tested
 * end-to-end against the real SimpleWebAuthn verification.
 */
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

const b64u = (b: Uint8Array | ArrayBuffer) => isoBase64URL.fromBuffer(new Uint8Array(b as ArrayBuffer));
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

/** WebCrypto ECDSA gives raw r||s; WebAuthn ES256 wants ASN.1 DER. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (x: Uint8Array) => {
    let i = 0;
    while (i < x.length - 1 && x[i] === 0) i++;
    let v = x.slice(i);
    if (v[0]! & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([0x02, v.length]), v);
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return concat(new Uint8Array([0x30, r.length + s.length]), r, s);
}

type Credential = { id: Uint8Array; keys: CryptoKeyPair; userHandle: Uint8Array; rpID: string; counter: number };

export class SoftAuthenticator {
  credentials: Credential[] = [];

  constructor(readonly origin: string) {}

  private flags(extra = 0) {
    // UP | UV | BE | BS: a synced (multi-device) passkey
    return 0x01 | 0x04 | 0x08 | 0x10 | extra;
  }

  /** navigator.credentials.create() equivalent, from server-provided options JSON. */
  async create(options: any) {
    const excluded = new Set((options.excludeCredentials ?? []).map((c: any) => c.id));
    if (this.credentials.some((c) => excluded.has(b64u(c.id)))) throw new Error("InvalidStateError: credential excluded");
    const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    const cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, isoBase64URL.toBuffer(jwk.x!)],
        [-3, isoBase64URL.toBuffer(jwk.y!)],
      ]),
    );
    const id = crypto.getRandomValues(new Uint8Array(16));
    const rpID = options.rp.id as string;
    const cred: Credential = { id, keys, userHandle: isoBase64URL.toBuffer(options.user.id), rpID, counter: 0 };
    const authData = concat(
      await sha256(new TextEncoder().encode(rpID)),
      new Uint8Array([this.flags(0x40)]), // + AT (attested credential data)
      u32(0),
      new Uint8Array(16), // aaguid
      new Uint8Array([0, id.length]),
      id,
      cose,
    );
    const clientDataJSON = new TextEncoder().encode(
      JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: this.origin, crossOrigin: false }),
    );
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]) as never,
    );
    this.credentials.push(cred);
    return {
      id: b64u(id),
      rawId: b64u(id),
      type: "public-key",
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ["internal", "hybrid"] },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** navigator.credentials.get() equivalent. With empty allowCredentials, picks a discoverable credential. */
  async get(options: any, pick?: (c: Credential) => boolean) {
    const allowed = (options.allowCredentials ?? []).map((c: any) => c.id);
    const cred = this.credentials.find(
      (c) => c.rpID === options.rpId && (allowed.length === 0 || allowed.includes(b64u(c.id))) && (!pick || pick(c)),
    );
    if (!cred) throw new Error("NotAllowedError: no credential");
    cred.counter++;
    const authData = concat(await sha256(new TextEncoder().encode(cred.rpID)), new Uint8Array([this.flags()]), u32(cred.counter));
    const clientDataJSON = new TextEncoder().encode(
      JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: this.origin, crossOrigin: false }),
    );
    const signed = concat(authData, await sha256(clientDataJSON));
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, cred.keys.privateKey, signed as BufferSource));
    return {
      id: b64u(cred.id),
      rawId: b64u(cred.id),
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(rawToDer(raw)),
        userHandle: b64u(cred.userHandle),
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
