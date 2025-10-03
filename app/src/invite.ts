export type InvitePayload = {
  v: number;
  room: string;
  nonce: string;
  exp: number;
  ts: number;
  inviterPub: JsonWebKey;
  sig: string;
};

export type InviteToken = { token: string; payload: InvitePayload };

export type InviteCreationResult = InviteToken & {
  privateKey: CryptoKey;
  privJwk: JsonWebKey;
};

export const INVITE_TTL_MS = 30 * 60 * 1000;

export const INVITE_KEY_ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;
export const INVITE_SIG_ALG = { name: 'ECDSA', hash: 'SHA-256' } as const;

export function b64urlEncode(str: string): string {
  const b64 = btoa(str);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/,'');
}

export function b64urlDecode(b64url: string): string {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  return atob(b64 + pad);
}

export function b64urlEncodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let i=0;i<bytes.length;i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

export function b64urlDecodeToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g,'+').replace(/_/g,'/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function canonicalRoom(room: string): string {
  return (room || '').trim().toLowerCase();
}

export function randNonceHex(n = 16, cryptoImpl: Crypto = globalThis.crypto): string {
  if (!cryptoImpl?.getRandomValues) throw new Error('crypto.getRandomValues unavailable');
  const bytes = new Uint8Array(n);
  cryptoImpl.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2,'0')).join('');
}

type CanonicalInvite = Pick<InvitePayload, 'room' | 'nonce' | 'exp' | 'ts' | 'inviterPub'>;

export function inviteSignatureBytes(payload: CanonicalInvite): Uint8Array {
  const canonical = JSON.stringify({
    room: payload.room,
    nonce: payload.nonce,
    exp: payload.exp,
    ts: payload.ts,
    inviterPub: {
      kty: payload.inviterPub.kty,
      crv: payload.inviterPub.crv,
      x: payload.inviterPub.x,
      y: payload.inviterPub.y
    }
  });
  return new TextEncoder().encode(canonical);
}

export async function createInvite(room: string, cryptoImpl: Crypto = globalThis.crypto): Promise<InviteCreationResult> {
  if (!cryptoImpl?.subtle) throw new Error('crypto.subtle unavailable');
  const cleanRoom = canonicalRoom(room);
  const nonce = randNonceHex(16, cryptoImpl);
  const exp = Date.now() + INVITE_TTL_MS;
  const ts = Date.now();

  const keyPair = await cryptoImpl.subtle.generateKey(INVITE_KEY_ALG, true, ['sign', 'verify']);
  const privJwk = await cryptoImpl.subtle.exportKey('jwk', keyPair.privateKey) as JsonWebKey;
  const pubJwk = await cryptoImpl.subtle.exportKey('jwk', keyPair.publicKey);
  const minimalPub: JsonWebKey = {
    kty: pubJwk.kty,
    crv: pubJwk.crv,
    x: pubJwk.x,
    y: pubJwk.y
  };

  const payloadFields: CanonicalInvite = {
    room: cleanRoom,
    nonce,
    exp,
    ts,
    inviterPub: minimalPub
  };

  const sigBytes = await cryptoImpl.subtle.sign(INVITE_SIG_ALG, keyPair.privateKey, inviteSignatureBytes(payloadFields));
  const signature = b64urlEncodeBytes(new Uint8Array(sigBytes));

  const payload: InvitePayload = {
    v: 2,
    ...payloadFields,
    sig: signature
  };

  return {
    token: b64urlEncode(JSON.stringify(payload)),
    payload,
    privateKey: keyPair.privateKey,
    privJwk
  };
}

export function parseInviteJson(json: string): InvitePayload | null {
  try {
    const data = JSON.parse(json);
    if (!data || typeof data !== 'object') return null;
    if (data.v !== 2) return null;
    if (!data.room || !data.nonce || !data.exp || !data.inviterPub || !data.sig) return null;
    return {
      v: 2,
      room: String(data.room || '').trim().toLowerCase(),
      nonce: String(data.nonce),
      exp: Number(data.exp),
      ts: Number(data.ts || 0),
      inviterPub: {
        kty: data.inviterPub.kty,
        crv: data.inviterPub.crv,
        x: data.inviterPub.x,
        y: data.inviterPub.y
      },
      sig: String(data.sig || '').trim()
    };
  } catch {
    return null;
  }
}

export function decodeInviteToken(token: string): InvitePayload | null {
  try {
    const raw = b64urlDecode(token.trim());
    return parseInviteJson(raw);
  } catch {
    return null;
  }
}

export async function verifyInviteTokenSignature(payload: InvitePayload, cryptoImpl: Crypto = globalThis.crypto): Promise<boolean> {
  if (!payload.sig) return false;
  if (!cryptoImpl?.subtle) throw new Error('crypto.subtle unavailable');
  try {
    const pubKey = await cryptoImpl.subtle.importKey('jwk', payload.inviterPub, INVITE_KEY_ALG, true, ['verify']);
    const sig = b64urlDecodeToBytes(payload.sig);
    return await cryptoImpl.subtle.verify(INVITE_SIG_ALG, pubKey, sig, inviteSignatureBytes(payload));
  } catch {
    return false;
  }
}

