import { describe, expect, it } from 'vitest';

import { Attachment } from './attachment.aggregate.js';
import { AttachmentError } from '../../errors/attachment/attachment.error.js';
import type { AttachmentReservation } from '../../value-objects/attachment/attachment-reservation.value-object.js';
import type { AttachmentVerification } from '../../value-objects/attachment/attachment-verification.value-object.js';

const id = '019a7006-7a8b-7c9d-8e0f-1a2b3c4d5e03';
const organizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
const authorUserId = '019a5f3c-9e1f-7b2a-8c3d-4e5f6a7b8c31';
const taskKey = 'CAD-482';
const objectKey = `org/${organizationId}/${id}`;
const stagingObjectKey = `org/${organizationId}/019a7006-7a8b-7c9d-8e0f-1a2b3c4d5e04`;
const reservedAt = new Date('2026-11-20T14:00:00.000Z');
const verifiedAt = new Date('2026-11-20T14:02:00.000Z');
const expiresAt = new Date('2026-11-20T14:05:00.000Z');
const removedAt = new Date('2026-11-21T03:00:00.000Z');
const maxBytes = 25 * 1024 * 1024;

function reservation(changes: Partial<AttachmentReservation> = {}): AttachmentReservation {
  return {
    id,
    organizationId,
    authorUserId,
    taskKey,
    objectKey,
    stagingObjectKey,
    fileName: 'Capture du Sprint 14.png',
    contentType: 'image/png',
    sizeBytes: 84_216,
    reservedAt,
    expiresAt,
    ...changes,
  };
}

function verification(changes: Partial<AttachmentVerification> = {}): AttachmentVerification {
  return {
    sizeBytes: 84_216,
    contentType: 'image/png',
    verifiedContentType: 'image/png',
    ...changes,
  };
}

function expectRefusal(action: () => unknown, reason: AttachmentError['reason']): void {
  expect(action).toThrow(AttachmentError);
  expect(action).toThrow(expect.objectContaining({ reason }));
}

describe('Attachment reservation', () => {
  it.each([1, maxBytes])(
    'reserves an upload of %i bytes in a tenant-owned staging key',
    (sizeBytes) => {
      expect(Attachment.reserve(reservation({ sizeBytes })).snapshot).toMatchObject({
        id,
        organizationId,
        authorUserId,
        taskKey,
        objectKey,
        stagingObjectKey,
        sizeBytes,
        status: 'pending',
        version: 0,
        uploadedAt: null,
        deletedAt: null,
      });
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses the invalid byte count %i before a signed upload',
    (sizeBytes) => {
      expectRefusal(() => Attachment.reserve(reservation({ sizeBytes })), 'invalid-size');
    },
  );

  it('refuses one byte over the mockup limit', () => {
    expectRefusal(
      () => Attachment.reserve(reservation({ sizeBytes: maxBytes + 1 })),
      'file-too-large',
    );
  });

  it.each([
    '',
    '   ',
    '.',
    ' .. ',
    '../capture.png',
    'C:\\capture.png',
    'a\nb.png',
    'x'.repeat(256),
  ])('refuses a file name that cannot be used as a safe original basename (%s)', (fileName) => {
    expectRefusal(() => Attachment.reserve(reservation({ fileName })), 'invalid-file-name');
  });

  it('counts supplementary characters as one code point per character in a basename', () => {
    const supplementaryLetter = '\u{10400}';
    const fileName = supplementaryLetter.repeat(251) + '.png';

    expect(Attachment.reserve(reservation({ fileName })).snapshot.fileName).toBe(fileName);
    expectRefusal(
      () => Attachment.reserve(reservation({ fileName: supplementaryLetter + fileName })),
      'invalid-file-name',
    );
  });

  it('accepts the HTTP token punctuation in both case-insensitive media parts', () => {
    const punctuation = "!#$%&'*+-.^_`|~";
    const contentType = `${punctuation}ApP/X${punctuation}`;

    expect(Attachment.reserve(reservation({ contentType })).snapshot.contentType).toBe(
      `${punctuation}app/x${punctuation}`,
    );
  });

  it.each([
    'image',
    '*/*',
    'image/*',
    '*/png',
    'application/vnd.K',
    'text/plain; charset=utf-8',
    'image/png\r\nimage/jpeg',
    'image/png\n',
  ])('refuses the invalid concrete media type %s', (contentType) => {
    expectRefusal(() => Attachment.reserve(reservation({ contentType })), 'invalid-content-type');
  });

  it('refuses unsafe object keys and prevents signing the final object for upload', () => {
    expectRefusal(
      () => Attachment.reserve(reservation({ stagingObjectKey: objectKey })),
      'invalid-object-key',
    );
    expectRefusal(
      () => Attachment.reserve(reservation({ objectKey: `org/${authorUserId}/${id}` })),
      'invalid-object-key',
    );
    expectRefusal(
      () => Attachment.reserve(reservation({ stagingObjectKey: `org/${organizationId}/../${id}` })),
      'invalid-object-key',
    );
  });

  it('opens a pending state only for a valid task and interval', () => {
    expectRefusal(
      () => Attachment.reserve(reservation({ taskKey: '../CAD-482' })),
      'invalid-identity',
    );
    expectRefusal(
      () => Attachment.reserve(reservation({ expiresAt: reservedAt })),
      'invalid-state',
    );
  });

  it('keeps its time bounds immutable when inputs and returned snapshots are changed', () => {
    const input = reservation({ expiresAt: new Date(expiresAt) });
    const attachment = Attachment.reserve(input);

    input.expiresAt.setUTCFullYear(2000);
    attachment.snapshot.expiresAt.setUTCFullYear(2001);

    expect(attachment.snapshot.expiresAt).toEqual(expiresAt);
  });
});

describe('Attachment finalization', () => {
  it('accepts a verified object at the byte limit', () => {
    const pending = Attachment.reserve(reservation({ sizeBytes: maxBytes }));
    const { attachment } = pending.finalize(verification({ sizeBytes: maxBytes }), verifiedAt);

    expect(attachment.snapshot).toMatchObject({ sizeBytes: maxBytes, status: 'ready' });
  });

  it('reports the stored byte limit even when verification skipped content detection', () => {
    const pending = Attachment.reserve(reservation({ sizeBytes: maxBytes }));

    expectRefusal(
      () =>
        pending.finalize(
          verification({ sizeBytes: maxBytes + 1, verifiedContentType: null }),
          verifiedAt,
        ),
      'file-too-large',
    );
    expect(pending.snapshot).toMatchObject({ sizeBytes: maxBytes, status: 'pending', version: 0 });
  });

  it('requires matching bytes, stored media type, and verified real type', () => {
    const pending = Attachment.reserve(reservation());

    for (const metadata of [
      verification({ sizeBytes: 84_215 }),
      verification({ contentType: 'image/jpeg' }),
      verification({ contentType: null }),
      verification({ verifiedContentType: 'image/jpeg' }),
      verification({ verifiedContentType: null }),
    ]) {
      expectRefusal(() => pending.finalize(metadata, verifiedAt), 'upload-metadata-mismatch');
    }

    expect(pending.snapshot.status).toBe('pending');
    expect(pending.snapshot.version).toBe(0);
  });

  it('refuses verification at expiry and any transition before the reservation', () => {
    const pending = Attachment.reserve(reservation());
    expectRefusal(() => pending.finalize(verification(), expiresAt), 'upload-expired');
    expectRefusal(
      () => pending.finalize(verification(), new Date(reservedAt.getTime() - 1)),
      'invalid-state',
    );
  });

  it('commits version one and a minimal fact when the normalized media types match', () => {
    const pending = Attachment.reserve(reservation({ contentType: 'Image/PNG' }));
    const result = pending.finalize(
      verification({ contentType: 'IMAGE/PNG', verifiedContentType: 'image/png' }),
      verifiedAt,
    );

    expect(result.attachment.snapshot).toMatchObject({
      status: 'ready',
      version: 1,
      uploadedAt: verifiedAt,
      contentType: 'image/png',
    });
    expect(result.event).toEqual({
      type: 'file.uploaded.v1',
      occurredAt: verifiedAt.toISOString(),
      organizationId,
      fileId: id,
      taskKey,
      sizeBytes: 84_216,
      version: 1,
    });
    expect(pending.snapshot.status).toBe('pending');
  });

  it('replays a ready result after expiry without new verification, version or fact', () => {
    const { attachment } = Attachment.reserve(reservation()).finalize(verification(), verifiedAt);
    expect(attachment.finalize(verification({ contentType: null }), expiresAt)).toEqual({
      attachment,
      event: null,
    });
  });
});

describe('Attachment removal', () => {
  it('does not let the ready deletion operation remove a pending upload', () => {
    const pending = Attachment.reserve(reservation());
    expectRefusal(() => pending.delete(verifiedAt), 'upload-not-ready');
  });

  it('expires abandoned pending attempts without announcing an attachment deletion', () => {
    const pending = Attachment.reserve(reservation());
    const early = pending.expire(verifiedAt);
    const expired = pending.expire(expiresAt);

    expect(early).toBe(pending);
    expect(expired.snapshot).toMatchObject({ status: 'deleted', version: 1, uploadedAt: null });
    expect(expired.expire(removedAt)).toBe(expired);
    expect(expired.delete(removedAt)).toEqual({ attachment: expired, event: null });
    expectRefusal(() => expired.finalize(verification(), removedAt), 'attachment-deleted');
  });

  it('discards a pending upload during task purge before its expiry', () => {
    const pending = Attachment.reserve(reservation());
    expect(pending.discard(verifiedAt).snapshot).toMatchObject({
      status: 'deleted',
      version: 1,
      uploadedAt: null,
      deletedAt: verifiedAt,
    });
  });

  it('emits one deletion fact for a ready attachment and never makes it ready again', () => {
    const { attachment: ready } = Attachment.reserve(reservation()).finalize(
      verification(),
      verifiedAt,
    );
    const { attachment: deleted, event } = ready.delete(removedAt);

    expect(ready.expire(removedAt)).toBe(ready);
    expectRefusal(() => ready.discard(removedAt), 'invalid-state');
    expect(deleted.snapshot).toMatchObject({
      status: 'deleted',
      version: 2,
      uploadedAt: verifiedAt,
      deletedAt: removedAt,
    });
    expect(event).toEqual({
      type: 'file.deleted.v1',
      occurredAt: removedAt.toISOString(),
      organizationId,
      fileId: id,
      taskKey,
      sizeBytes: 84_216,
      version: 2,
    });
    expect(deleted.delete(removedAt)).toEqual({ attachment: deleted, event: null });
    expectRefusal(() => deleted.finalize(verification(), removedAt), 'attachment-deleted');
  });
});

describe('Attachment rehydration', () => {
  it('restores the reserved, verified and removed snapshots without new facts', () => {
    const pending = Attachment.reserve(reservation());
    const ready = pending.finalize(verification(), verifiedAt).attachment;
    const deleted = ready.delete(removedAt).attachment;
    const abandoned = pending.discard(verifiedAt);

    for (const attachment of [pending, ready, deleted, abandoned]) {
      expect(Attachment.rehydrate(attachment.snapshot).snapshot).toEqual(attachment.snapshot);
    }
  });

  it('rejects persisted lifecycle contradictions', () => {
    const snapshot = Attachment.reserve(reservation()).snapshot;
    expectRefusal(() => Attachment.rehydrate({ ...snapshot, status: 'ready' }), 'invalid-state');
    expectRefusal(
      () =>
        Attachment.rehydrate({ ...snapshot, status: 'deleted', version: 2, deletedAt: removedAt }),
      'invalid-state',
    );
    expectRefusal(
      () =>
        Attachment.rehydrate({ ...snapshot, status: 'ready', version: 1, uploadedAt: expiresAt }),
      'invalid-state',
    );
  });
});
