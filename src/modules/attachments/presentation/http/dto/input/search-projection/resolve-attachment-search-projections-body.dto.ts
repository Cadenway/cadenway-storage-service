import { ResolveAttachmentSearchProjectionsInternalBody } from '@cadenway/contracts/validators/internal/storage-service';
import { zodDto } from '@cadenway/nest-common';

/** Rejects duplicate IDs before any read, including duplicates with different casing. */
export class ResolveAttachmentSearchProjectionsBody extends zodDto(
  ResolveAttachmentSearchProjectionsInternalBody.refine(
    ({ fileIds }) => new Set(fileIds.map((id) => id.toLowerCase())).size === fileIds.length,
    { path: ['fileIds'], message: 'File IDs must be unique.' },
  ),
) {}
