import type { ProfileMediaDerivative } from './profile-media-derivative.value-object.js';
import type { ProfileMediaOwnerBinding } from './profile-media-owner-binding.value-object.js';
import type { ProfileMediaTransfer } from './profile-media-transfer.value-object.js';

type Declaration = Omit<ProfileMediaTransfer, 'owner' | 'uploadId'>;

/** Persisted reservation or terminal fence, with an elected candidate only after verification. */
export type ProfileMediaUploadSnapshot = {
  readonly owner: ProfileMediaOwnerBinding;
  readonly uploadId: string;
} & (
  | {
      readonly status: 'pending';
      readonly declaration: Declaration;
      readonly derivative: null;
    }
  | {
      readonly status: 'prepared' | 'attached';
      readonly declaration: Declaration;
      readonly derivative: ProfileMediaDerivative;
    }
  | {
      readonly status: 'retired';
      readonly declaration: Declaration | null;
      readonly derivative: ProfileMediaDerivative | null;
    }
);
