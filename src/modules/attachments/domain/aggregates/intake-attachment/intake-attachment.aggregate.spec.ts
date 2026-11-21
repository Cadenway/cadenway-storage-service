import { describe, expect, it } from 'vitest';

import { IntakeAttachment } from './intake-attachment.aggregate.js';
import { Attachment } from '../attachment/attachment.aggregate.js';
import { AttachmentError } from '../../errors/attachment/attachment.error.js';
import type { AttachmentVerification } from '../../value-objects/attachment/attachment-verification.value-object.js';
import type { IntakeAttachmentReservation } from '../../value-objects/intake-attachment/intake-attachment-reservation.value-object.js';

const identity = {
  organizationId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f',
  publicationId: '019a7006-7a8b-7c9d-8e0f-1a2b3c4d5e01',
  id: '019a7006-7a8b-7c9d-8e0f-1a2b3c4d5e04',
};
const stagingObjectKey = 'intake/019a7006-7a8b-7c9d-8e0f-1a2b3c4d5e03';
const candidateKey = `org/${identity.organizationId}/019a7006-7a8b-7c9d-8e0f-1a2b3c4d5e05`;
const otherCandidateKey = `org/${identity.organizationId}/019a7006-7a8b-7c9d-8e0f-1a2b3c4d5e06`;
const reservedAt = new Date('2026-11-20T14:00:00Z');
const signedExpiry = new Date('2026-11-20T14:05:00Z');
const verifiedAt = new Date('2026-11-20T14:04:00Z');
const expiresAt = new Date('2026-11-20T14:30:00Z');
const lateDecision = new Date('2026-11-21T09:00:00Z');
const taskKey = 'CAD-482';

function reservation(
  changes: Partial<IntakeAttachmentReservation> = {},
): IntakeAttachmentReservation {
  return {
    ...identity,
    stagingObjectKey,
    fileName: 'Capture du Sprint 14.png',
    contentType: 'image/png',
    sizeBytes: 84_216,
    reservedAt,
    expiresAt,
    ...changes,
  };
}

const verification: AttachmentVerification = {
  sizeBytes: 84_216,
  contentType: 'IMAGE/PNG',
  verifiedContentType: 'image/png',
};

function verified(): IntakeAttachment {
  return IntakeAttachment.reserve(reservation()).verify(candidateKey, verification, verifiedAt)
    .intakeAttachment;
}

function expectRefusal(action: () => unknown, reason: AttachmentError['reason']): void {
  expect(action).toThrow(AttachmentError);
  expect(action).toThrow(expect.objectContaining({ reason }));
}

describe('Anonymous intake reservation', () => {
  it('bounds the signed capability by five minutes and the draft cutoff', () => {
    expect(IntakeAttachment.reserve(reservation()).snapshot.reservation?.uploadExpiresAt).toEqual(
      signedExpiry,
    );
    const shortDraft = new Date('2026-11-20T14:02:00Z');
    expect(
      IntakeAttachment.reserve(reservation({ expiresAt: shortDraft })).snapshot.reservation
        ?.uploadExpiresAt,
    ).toEqual(shortDraft);
    expectRefusal(
      () => IntakeAttachment.reserve(reservation({ uploadExpiresAt: expiresAt })),
      'invalid-state',
    );
  });

  it('refuses a staging path containing tenant or intake binding information', () => {
    for (const key of [
      candidateKey,
      `intake/${identity.id}`,
      `intake/${identity.publicationId}`,
      `intake/${identity.organizationId}`,
    ]) {
      expectRefusal(
        () => IntakeAttachment.reserve(reservation({ stagingObjectKey: key })),
        'invalid-object-key',
      );
    }
  });

  it('accepts only the registered file extension media type for the signed upload', () => {
    const pending = IntakeAttachment.reserve(reservation());
    expect(() => {
      pending.requireExtensionMediaType('IMAGE/PNG');
    }).not.toThrow();
    expectRefusal(() => {
      pending.requireExtensionMediaType('image/jpeg');
    }, 'upload-metadata-mismatch');
  });

  it('replays only the original declaration for the exact reservation binding', () => {
    const pending = IntakeAttachment.reserve(reservation());
    expect(() => {
      pending.requireReservation(reservation({ contentType: 'IMAGE/PNG' }));
    }).not.toThrow();
    expectRefusal(() => {
      pending.requireReservation(reservation({ fileName: 'Une autre capture.png' }));
    }, 'reservation-conflict');
    expectRefusal(() => {
      pending.requireReservation(reservation({ expiresAt: signedExpiry }));
    }, 'reservation-conflict');
    expectRefusal(() => {
      pending.requireReservation(reservation({ publicationId: identity.id }));
    }, 'invalid-identity');
  });

  it('keeps a release tombstone when the allocation has never reached Storage', () => {
    const released = IntakeAttachment.releaseUnallocated(identity, reservedAt);
    const restored = IntakeAttachment.rehydrate(released.snapshot);

    expect(restored.snapshot).toMatchObject({ ...identity, status: 'released', reservation: null });
    expect(restored.release(lateDecision)).toBe(restored);
    expectRefusal(() => {
      restored.requireReservation(reservation());
    }, 'attachment-deleted');
    expectRefusal(
      () => restored.verify(candidateKey, verification, verifiedAt),
      'attachment-deleted',
    );
  });

  it('records the task on a claim tombstone when the allocation has never reached Storage', () => {
    const claim = IntakeAttachment.claimUnallocated(identity, taskKey, lateDecision);
    const restored = IntakeAttachment.rehydrate(claim.snapshot);

    expect(restored.snapshot).toMatchObject({
      ...identity,
      status: 'claimed',
      taskKey,
      decidedAt: lateDecision,
      reservation: null,
      candidateKey: null,
    });
    expect(restored.claim(taskKey, false, lateDecision)).toEqual({
      intakeAttachment: restored,
      attachment: null,
      event: null,
    });
    expect(restored.release(lateDecision)).toBe(restored);
    expectRefusal(() => {
      restored.requireReservation(reservation());
    }, 'attachment-deleted');
    expectRefusal(
      () => restored.verify(candidateKey, verification, verifiedAt),
      'attachment-deleted',
    );
  });
});

describe('Anonymous intake verified pin', () => {
  it('pins one candidate without a task or a ready file fact and ignores a competing completion', () => {
    const pending = IntakeAttachment.reserve(reservation());
    const confirmed = pending.verify(candidateKey, verification, verifiedAt);

    expect(confirmed.intakeAttachment.snapshot).toMatchObject({
      status: 'verified',
      candidateKey,
      verifiedAt,
      taskKey: null,
    });
    expect(confirmed.event).toEqual({
      type: 'intake.attachment-verified.v1',
      organizationId: identity.organizationId,
      publicationId: identity.publicationId,
      attachmentId: identity.id,
      occurredAt: verifiedAt.toISOString(),
      version: 1,
    });
    expect(
      confirmed.intakeAttachment.verify(otherCandidateKey, verification, lateDecision),
    ).toEqual({
      intakeAttachment: confirmed.intakeAttachment,
      event: null,
    });
    expect(confirmed.intakeAttachment.snapshot.candidateKey).toBe(candidateKey);
  });

  it('refuses post-draft completion and bytes that differ from the declaration', () => {
    const pending = IntakeAttachment.reserve(reservation());
    expectRefusal(() => pending.verify(candidateKey, verification, signedExpiry), 'upload-expired');
    expectRefusal(() => pending.verify(candidateKey, verification, expiresAt), 'upload-expired');
    expectRefusal(
      () =>
        pending.verify(candidateKey, { ...verification, verifiedContentType: null }, verifiedAt),
      'upload-metadata-mismatch',
    );
    expectRefusal(
      () => pending.verify(candidateKey, { ...verification, sizeBytes: 26_214_401 }, verifiedAt),
      'file-too-large',
    );
    expectRefusal(
      () =>
        pending.verify(`org/${identity.publicationId}/${identity.id}`, verification, verifiedAt),
      'invalid-object-key',
    );
    expect(pending.snapshot.candidateKey).toBeNull();
  });

  it('keeps the pin through expiry and binds exactly that candidate once after Task claims it', () => {
    const pin = IntakeAttachment.rehydrate(verified().snapshot);
    const result = pin.claim(taskKey, false, lateDecision);

    expect(result.intakeAttachment.snapshot).toMatchObject({
      status: 'claimed',
      candidateKey,
      taskKey,
    });
    expect(result.attachment?.snapshot).toMatchObject({
      id: identity.id,
      authorUserId: null,
      taskKey,
      status: 'ready',
      stagingObjectKey,
      uploadedAt: verifiedAt,
    });
    expect(result.event).toEqual({
      type: 'file.uploaded.v1',
      organizationId: identity.organizationId,
      fileId: identity.id,
      taskKey,
      occurredAt: lateDecision.toISOString(),
      sizeBytes: verification.sizeBytes,
      version: 1,
    });
    const replay = result.intakeAttachment.claim(taskKey, false, lateDecision);
    expect(replay).toEqual({
      intakeAttachment: result.intakeAttachment,
      attachment: null,
      event: null,
    });
    expect(result.intakeAttachment.release(lateDecision)).toBe(result.intakeAttachment);
    expect(result.attachment?.delete(lateDecision).attachment.snapshot.authorUserId).toBeNull();
  });

  it('discards a pin without a file fact if the target task is already purged', () => {
    const purged = verified().claim(taskKey, true, lateDecision);

    expect(purged.intakeAttachment.snapshot).toMatchObject({
      status: 'claimed',
      taskKey,
      candidateKey,
    });
    expect(purged.attachment).toBeNull();
    expect(purged.event).toBeNull();
    expect(purged.intakeAttachment.claim(taskKey, false, lateDecision).event).toBeNull();
  });

  it('keeps the candidate reference for cleanup on release and fences late claims and completions', () => {
    const released = verified().release(lateDecision);

    expect(released.snapshot).toMatchObject({ status: 'released', candidateKey, taskKey: null });
    expect(released.claim(taskKey, false, lateDecision).attachment).toBeNull();
    expectRefusal(
      () => released.verify(otherCandidateKey, verification, verifiedAt),
      'attachment-deleted',
    );
  });

  it('keeps the staged key for cleanup after release during verification', () => {
    const pending = IntakeAttachment.reserve(reservation());
    const released = pending.release(verifiedAt);

    expect(released.snapshot).toMatchObject({
      status: 'released',
      reservation: { stagingObjectKey },
      candidateKey: null,
    });
    expectRefusal(
      () => released.verify(candidateKey, verification, verifiedAt),
      'attachment-deleted',
    );
  });

  it('records a claim of a pending upload without creating an unverified file', () => {
    const pending = IntakeAttachment.reserve(reservation());
    const result = pending.claim(taskKey, false, lateDecision);

    expect(result.intakeAttachment.snapshot).toMatchObject({
      status: 'claimed',
      taskKey,
      candidateKey: null,
    });
    expect(result.attachment).toBeNull();
    expect(result.event).toBeNull();
    expectRefusal(
      () => result.intakeAttachment.verify(candidateKey, verification, verifiedAt),
      'attachment-deleted',
    );
  });

  it('rejects impossible rehydrated states', () => {
    const pending = IntakeAttachment.reserve(reservation());
    expectRefusal(
      () => IntakeAttachment.rehydrate({ ...pending.snapshot, status: 'verified' }),
      'invalid-state',
    );
    expectRefusal(
      () => IntakeAttachment.rehydrate({ ...pending.snapshot, publicationId: identity.id }),
      'invalid-identity',
    );
    expectRefusal(
      () => IntakeAttachment.rehydrate({ ...verified().snapshot, candidateKey: null }),
      'invalid-state',
    );
  });

  it('keeps stored timestamps immutable and rejects unauthored pending task attachments', () => {
    const pin = verified();
    const snapshot = pin.snapshot;
    snapshot.verifiedAt?.setUTCFullYear(2000);
    snapshot.reservation?.expiresAt.setUTCFullYear(2000);
    expect(pin.snapshot.verifiedAt).toEqual(verifiedAt);
    expect(pin.snapshot.reservation?.expiresAt).toEqual(expiresAt);

    const attachment = pin.claim(taskKey, false, lateDecision).attachment;
    if (attachment === null) throw new Error('The fixture must have a claimed task attachment.');
    expectRefusal(
      () =>
        Attachment.rehydrate({
          ...attachment.snapshot,
          status: 'pending',
          uploadedAt: null,
          version: 0,
        }),
      'invalid-state',
    );
  });
});
