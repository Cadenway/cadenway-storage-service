import type { ProfileMediaOwnerBinding } from '../../../../../domain/value-objects/media/profile-media-owner-binding.value-object.js';
import type { ProfileMediaCapability } from '../../../../models/media/profile-media-capability.model.js';

export { ProfileMediaUnavailable } from '../../../../models/media/profile-media-unavailable.model.js';

/** Storage operations occur outside the owner database transaction. */
export interface ProfileMediaObjects {
  // #region Methods
  /** Signs one bounded staging upload at the owner's original exclusive expiry. */
  sign(
    input: {
      readonly owner: ProfileMediaOwnerBinding;
      readonly uploadId: string;
      readonly contentType: string;
      readonly expiresAt: Date;
    },
    signal?: AbortSignal,
  ): Promise<ProfileMediaCapability>;

  /** Reads one staging generation, aborting its stream if it exceeds the declared size. */
  readSource(
    input: {
      readonly owner: ProfileMediaOwnerBinding;
      readonly uploadId: string;
      readonly contentType: string;
      readonly sizeBytes: number;
    },
    signal?: AbortSignal,
  ): Promise<Buffer | null>;

  /** Writes a previously registered candidate once, never replacing another generation. */
  putCandidate(
    input: {
      readonly owner: ProfileMediaOwnerBinding;
      readonly uploadId: string;
      readonly candidateId: string;
      readonly png: Buffer;
    },
    signal?: AbortSignal,
  ): Promise<void>;

  /** Reads at most the accepted derivative length from its private candidate. */
  readCandidate(
    input: {
      readonly owner: ProfileMediaOwnerBinding;
      readonly uploadId: string;
      readonly candidateId: string;
      readonly sizeBytes: number;
    },
    signal?: AbortSignal,
  ): Promise<Buffer | null>;
  // #endregion
}
