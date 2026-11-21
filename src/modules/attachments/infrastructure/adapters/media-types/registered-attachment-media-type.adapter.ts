import { lookup } from 'mime-types';
import { extname } from 'node:path';

import type { AttachmentMediaTypeLookup } from '../../../application/ports/outbound/media-types/attachment/attachment-media-type-lookup.port.js';

/** Returns the canonical media type registered for an extension. */
export function registeredMediaTypeForExtension(extension: string): string | null {
  return lookup(extension) || null;
}

/** Looks up the canonical type of the final extension, including common text log files. */
export const registeredAttachmentMediaType: AttachmentMediaTypeLookup = {
  lookup: (fileName: string): string | null => registeredMediaTypeForExtension(extname(fileName)),
};
