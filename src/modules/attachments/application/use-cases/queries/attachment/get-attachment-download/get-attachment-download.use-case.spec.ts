import { describe, expect, it, vi } from 'vitest';

import { Attachment } from '../../../../../domain/aggregates/attachment/attachment.aggregate.js';
import type { AttachmentTransaction } from '../../../../models/attachment/attachment-transaction.model.js';
import type { AttachmentObjectStore } from '../../../../ports/outbound/object-storage/attachment/attachment-object-store.port.js';
import type { AttachmentReader } from '../../../../ports/outbound/persistence/attachment/attachment-reader.port.js';
import type { AttachmentUnitOfWork } from '../../../../ports/outbound/transactions/attachment/attachment-unit-of-work.port.js';
import { GetAttachmentDownload } from './get-attachment-download.use-case.js';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const authorUserId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const attachmentId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f15';
const stagingId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f16';
const objectKey = `org/${organizationId}/verified-candidate`;
const input = { organizationId, taskKey: 'CAD-482', attachmentId };
const signed = {
  url: 'https://files.example.test/download',
  expiresAt: '2026-11-08T08:05:00.000Z',
};

function fixture() {
  let attachment = Attachment.reserve({
    id: attachmentId,
    organizationId,
    authorUserId,
    taskKey: input.taskKey,
    objectKey: `org/${organizationId}/${attachmentId}`,
    stagingObjectKey: `org/${organizationId}/${stagingId}`,
    fileName: 'example.png',
    contentType: 'image/png',
    sizeBytes: 20,
    reservedAt: new Date('2026-11-08T08:00:00.000Z'),
    expiresAt: new Date('2026-11-08T08:05:00.000Z'),
  }).finalize(
    { sizeBytes: 20, contentType: 'image/png', verifiedContentType: 'image/png' },
    new Date('2026-11-08T08:01:00.000Z'),
  ).attachment;
  let purged = false;
  let elected = objectKey;
  let signing = false;
  let releaseSigning: () => void = () => undefined;
  const signingStarted = new Promise<void>((resolve) => {
    releaseSigning = resolve;
  });
  let finishSigning: () => void = () => undefined;
  const signingFinished = new Promise<void>((resolve) => {
    finishSigning = resolve;
  });
  const reader = {
    findReady: vi.fn<AttachmentReader['findReady']>().mockResolvedValue({
      attachment: {
        id: attachmentId,
        taskKey: input.taskKey,
        fileName: 'example.png',
        contentType: 'image/png',
        sizeBytes: 20,
        authorUserId,
        uploadedAt: '2026-11-08T08:01:00.000Z',
        version: 1,
      },
      objectKey,
    }),
    listTask: vi.fn<AttachmentReader['listTask']>(),
    listLargest: vi.fn<AttachmentReader['listLargest']>(),
  } satisfies AttachmentReader;
  const store = {
    lockTask: vi.fn<AttachmentTransaction['lockTask']>(() => Promise.resolve(purged)),
    lockAttachment: vi.fn<AttachmentTransaction['lockAttachment']>((_task, _id, expected) =>
      Promise.resolve(expected === elected ? attachment : null),
    ),
    registerTaskPurge: vi.fn<AttachmentTransaction['registerTaskPurge']>(),
    insertReservation: vi.fn<AttachmentTransaction['insertReservation']>(),
    claimUpload: vi.fn<AttachmentTransaction['claimUpload']>(),
    completeUploadClaim: vi.fn<AttachmentTransaction['completeUploadClaim']>(),
    releaseUploadClaim: vi.fn<AttachmentTransaction['releaseUploadClaim']>(),
    registerCandidate: vi.fn<AttachmentTransaction['registerCandidate']>(),
    electCandidate: vi.fn<AttachmentTransaction['electCandidate']>(),
    deleteAttachment: vi.fn<AttachmentTransaction['deleteAttachment']>(),
    appendFact: vi.fn<AttachmentTransaction['appendFact']>(),
  } satisfies AttachmentTransaction;
  const objects = {
    signUpload: vi.fn<AttachmentObjectStore['signUpload']>(),
    copyAndVerify: vi.fn<AttachmentObjectStore['copyAndVerify']>(),
    signDownload: vi.fn<AttachmentObjectStore['signDownload']>(async () => {
      signing = true;
      releaseSigning();
      await signingFinished;
      signing = false;
      return signed;
    }),
  } satisfies AttachmentObjectStore;
  const work: AttachmentUnitOfWork = {
    run: async (tenant, operation) => {
      expect(tenant).toBe(organizationId);
      expect(signing).toBe(false);
      return operation(store);
    },
  };
  return {
    useCase: new GetAttachmentDownload(reader, objects, work),
    reader,
    store,
    objects,
    signingStarted,
    finishSigning,
    purge: () => {
      purged = true;
    },
    delete: () => {
      attachment = attachment.delete(new Date('2026-11-08T08:02:00.000Z')).attachment;
    },
    replaceWinner: () => {
      elected = `${objectKey}-other`;
    },
  };
}

describe('GetAttachmentDownload', () => {
  it('signs outside the transaction and releases the URL after checking the locked winner', async () => {
    const f = fixture();
    const result = f.useCase.execute(input);
    await f.signingStarted;
    expect(f.store.lockTask).not.toHaveBeenCalled();
    f.finishSigning();
    await expect(result).resolves.toEqual(signed);
    expect(f.reader.findReady).toHaveBeenCalledWith(organizationId, input.taskKey, attachmentId);
    expect(f.objects.signDownload).toHaveBeenCalledWith({ objectKey, fileName: 'example.png' });
    expect(f.store.lockTask).toHaveBeenCalledWith(input.taskKey);
    expect(f.store.lockAttachment).toHaveBeenCalledWith(input.taskKey, attachmentId, objectKey);
    expect(f.store.lockTask.mock.invocationCallOrder[0]).toBeLessThan(
      f.store.lockAttachment.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each([
    [
      'deletion',
      (f: ReturnType<typeof fixture>) => {
        f.delete();
      },
    ],
    [
      'task purge',
      (f: ReturnType<typeof fixture>) => {
        f.purge();
      },
    ],
    [
      'a changed elected object',
      (f: ReturnType<typeof fixture>) => {
        f.replaceWinner();
      },
    ],
  ])('withholds a URL when %s occurs during signing', async (_name, change) => {
    const f = fixture();
    const result = f.useCase.execute(input);
    await f.signingStarted;
    change(f);
    f.finishSigning();
    await expect(result).rejects.toMatchObject({ reason: 'not-found' });
  });

  it('refuses missing metadata before asking storage to sign', async () => {
    const f = fixture();
    f.reader.findReady.mockResolvedValueOnce(null);
    await expect(f.useCase.execute(input)).rejects.toMatchObject({ reason: 'not-found' });
    expect(f.objects.signDownload).not.toHaveBeenCalled();
    expect(f.store.lockTask).not.toHaveBeenCalled();
  });
});
