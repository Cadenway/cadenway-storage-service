import { randomBytes } from 'node:crypto';

import { expect, it, vi } from 'vitest';

import { UploadTransferTicket } from './upload-transfer-ticket.js';

const endpoint = 'http://127.0.0.1/internal/v1/upload-transfers';
const keyring = {
  activeKeyId: 'transfer-test',
  keys: [{ id: 'transfer-test', key: randomBytes(32).toString('base64url') }],
};

function uploadId(at: number): string {
  const timestamp = at.toString(16).padStart(12, '0');
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-000000000001`;
}

it('invalidates the original ticket and profile upload identity after the issuer restarts', async () => {
  vi.useFakeTimers();
  try {
    const initialBoot = Date.now();
    const identity = uploadId(initialBoot);
    const authorization = {
      key: `profile-media/staging/${identity}`,
      expiresAt: new Date(initialBoot + 120_000).toISOString(),
      contentType: 'image/png',
      sizeBytes: 72,
    };
    const original = new UploadTransferTicket(endpoint, keyring);
    const issued = original.issue(authorization);
    const ticket = issued.fields.ticket;
    if (ticket === undefined) throw new Error('Missing local upload ticket');
    expect(original.open(ticket)).toEqual(authorization);
    expect(original.acceptsProfileUploadId(identity)).toBe(true);

    vi.setSystemTime(initialBoot + 1);
    vi.resetModules();
    const restarted = await import('./upload-transfer-ticket.js');
    const next = new restarted.UploadTransferTicket(endpoint, keyring);
    expect(next.open(ticket)).toBeNull();
    expect(next.acceptsProfileUploadId(identity)).toBe(false);
    expect(next.acceptsProfileUploadId(uploadId(Date.now()))).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
