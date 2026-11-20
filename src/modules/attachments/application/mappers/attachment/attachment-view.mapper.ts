import type { Attachment } from '../../../domain/aggregates/attachment/attachment.aggregate.js';
import type { AttachmentView } from '../../models/attachment/attachment-view.model.js';

/** Projects an accepted attachment without exposing storage keys. */
export function attachmentView(attachment: Attachment): AttachmentView {
  const state = attachment.snapshot;
  if (state.status !== 'ready' || state.uploadedAt === null) {
    throw new Error('A ready attachment is required.');
  }
  return {
    id: state.id,
    taskKey: state.taskKey,
    fileName: state.fileName,
    contentType: state.contentType,
    sizeBytes: state.sizeBytes,
    authorUserId: state.authorUserId,
    uploadedAt: state.uploadedAt.toISOString(),
    version: state.version,
  };
}
