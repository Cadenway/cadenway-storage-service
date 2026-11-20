import type { ProfileMediaOwnerBinding } from '../../../../../domain/value-objects/media/profile-media-owner-binding.value-object.js';
import type { ProfileMediaVerification } from '../../../../../domain/value-objects/media/profile-media-verification.value-object.js';

/** Produces a bounded PNG and proof from exactly one loaded source generation. */
export interface ProfileMediaImageProcessor {
  // #region Methods
  /** Scoped operation or value. */
  transform(
    input: {
      readonly kind: ProfileMediaOwnerBinding['kind'];
      readonly contentType: string;
      readonly bytes: Buffer;
      readonly candidateId: string;
    },
    signal?: AbortSignal,
  ): Promise<{ readonly png: Buffer; readonly verification: ProfileMediaVerification }>;
  // #endregion
}
