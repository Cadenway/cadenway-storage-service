import { ProfileMediaError } from '../../errors/media/profile-media.error.js';
import {
  profileMediaIdentity,
  profileMediaOwner,
  sameProfileMediaOwner,
} from '../../policies/media/profile-media-identity.policy.js';
import {
  checkedProfileMediaDerivative,
  requireProfileMediaDeclaration,
  verifyProfileMedia,
} from '../../policies/media/profile-media-verification.policy.js';
import type { ProfileMediaDerivative } from '../../value-objects/media/profile-media-derivative.value-object.js';
import type { ProfileMediaOwnerBinding } from '../../value-objects/media/profile-media-owner-binding.value-object.js';
import type { ProfileMediaTransfer } from '../../value-objects/media/profile-media-transfer.value-object.js';
import type { ProfileMediaUploadSnapshot } from '../../value-objects/media/profile-media-upload-snapshot.value-object.js';
import type { ProfileMediaVerification } from '../../value-objects/media/profile-media-verification.value-object.js';

type Declaration = Omit<ProfileMediaTransfer, 'owner' | 'uploadId'>;

interface StoredUpload {
  // #region Properties
  /** Fields read from Storage before reconstituting the discriminated state. */
  readonly owner: ProfileMediaOwnerBinding;
  readonly uploadId: string;
  readonly status: string;
  readonly declaration: Declaration | null;
  readonly derivative: ProfileMediaDerivative | null;
  // #endregion
}

interface Preparation {
  // #region Properties
  /** Public identity and verified metadata, without the private candidate selector. */
  readonly uploadId: string;
  readonly contentType: 'image/png';
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  // #endregion
}

const maximumSigningWindowMs = 5 * 60 * 1000;

function instant(date: Date): number {
  const milliseconds = date.getTime();
  if (!Number.isFinite(milliseconds)) throw new ProfileMediaError('invalid-state');
  return milliseconds;
}

function checkedDeclaration(owner: ProfileMediaOwnerBinding, input: Declaration): Declaration {
  const uploaderUserId = profileMediaIdentity(input.uploaderUserId);
  if (owner.kind === 'avatar' && owner.id !== uploaderUserId) {
    throw new ProfileMediaError('not-found');
  }
  requireProfileMediaDeclaration(owner.kind, input.contentType, input.sizeBytes);
  return {
    uploaderUserId,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    expiresAt: new Date(instant(input.expiresAt)),
  };
}

/** Owns a staged profile upload and exactly one elected, immutable derivative. */
export class ProfileMediaUpload {
  // #region Constructor
  /** Retains a validated snapshot that only this aggregate owns. */
  private constructor(private readonly state: ProfileMediaUploadSnapshot) {}
  // #endregion

  // #region Properties
  /** Returns a detached snapshot for the owner-scoped persistence adapter. */
  public get snapshot(): ProfileMediaUploadSnapshot {
    return ProfileMediaUpload.restore(this.state).state;
  }
  // #endregion

  // #region Methods
  /** Records the exclusive deadline already allocated by the owner per Storage OpenAPI. */
  public static reserve(input: ProfileMediaTransfer, now: Date): ProfileMediaUpload {
    const owner = profileMediaOwner(input.owner);
    const declaration = checkedDeclaration(owner, input);
    const duration = instant(declaration.expiresAt) - instant(now);
    if (duration <= 0) throw new ProfileMediaError('upload-expired');
    if (duration > maximumSigningWindowMs) throw new ProfileMediaError('invalid-state');
    return new ProfileMediaUpload({
      owner,
      uploadId: profileMediaIdentity(input.uploadId, true),
      status: 'pending',
      declaration,
      derivative: null,
    });
  }

  /** Restores validated state while copying the owner, declaration and derivative. */
  public static restore(snapshot: StoredUpload): ProfileMediaUpload {
    const owner = profileMediaOwner(snapshot.owner);
    const uploadId = profileMediaIdentity(snapshot.uploadId, true);
    const { status } = snapshot;
    if (status === 'retired') {
      const declaration =
        snapshot.declaration === null ? null : checkedDeclaration(owner, snapshot.declaration);
      const derivative =
        snapshot.derivative === null ? null : checkedProfileMediaDerivative(snapshot.derivative);
      if (declaration === null && derivative !== null) throw new ProfileMediaError('invalid-state');
      return new ProfileMediaUpload({ owner, uploadId, status, declaration, derivative });
    }

    if (snapshot.declaration === null) throw new ProfileMediaError('invalid-state');
    const declaration = checkedDeclaration(owner, snapshot.declaration);
    if (status === 'pending' && snapshot.derivative === null) {
      return new ProfileMediaUpload({ owner, uploadId, status, declaration, derivative: null });
    }
    if ((status === 'prepared' || status === 'attached') && snapshot.derivative !== null) {
      const derivative = checkedProfileMediaDerivative(snapshot.derivative);
      return new ProfileMediaUpload({ owner, uploadId, status, declaration, derivative });
    }
    throw new ProfileMediaError('invalid-state');
  }

  /** Records the owner's terminal decision even when the original reservation never arrived. */
  public static retired(owner: ProfileMediaOwnerBinding, uploadId: string): ProfileMediaUpload {
    return ProfileMediaUpload.restore({
      owner,
      uploadId,
      status: 'retired',
      declaration: null,
      derivative: null,
    });
  }

  /** Requires the exact actor and scope used to sign the staging transfer. */
  public assertUploader(owner: ProfileMediaOwnerBinding, uploaderUserId: string): void {
    this.requireUploader(owner, uploaderUserId);
  }

  /** A retry cannot switch owner, uploader, declaration, or original signing expiry. */
  public assertEquivalent(input: ProfileMediaTransfer): void {
    if (
      this.state.declaration === null ||
      profileMediaIdentity(input.uploadId, true) !== this.state.uploadId
    ) {
      throw new ProfileMediaError('not-found');
    }
    const declaration = this.requireUploader(input.owner, input.uploaderUserId);
    if (
      input.contentType !== declaration.contentType ||
      input.sizeBytes !== declaration.sizeBytes ||
      instant(input.expiresAt) !== instant(declaration.expiresAt)
    ) {
      throw new ProfileMediaError('key-reused');
    }
  }

  /** Only the original signed receipt may replay after the exclusive signing deadline. */
  public requireSignable(now: Date, hasSignedReceipt: boolean): void {
    const { status, declaration } = this.state;
    if (status === 'retired') {
      if (declaration !== null && hasSignedReceipt) return;
      throw new ProfileMediaError('not-found');
    }
    if (hasSignedReceipt) return;
    this.requireBeforeExpiry(now, declaration.expiresAt);
    if (status !== 'pending') throw new ProfileMediaError('invalid-state');
  }

  /** Checks whether work may start, while allowing the elected preparation to replay after expiry. */
  public requirePreparable(now: Date): void {
    const { status, declaration } = this.state;
    if (status === 'retired') throw new ProfileMediaError('upload-superseded');
    if (status === 'pending') this.requireBeforeExpiry(now, declaration.expiresAt);
  }

  /** Elects the first verified PNG; replay keeps the candidate that already won. */
  public prepare(proof: ProfileMediaVerification, now: Date): ProfileMediaUpload {
    this.requirePreparable(now);
    const { owner, uploadId, declaration, status } = this.state;
    if (status !== 'pending') return this;
    const derivative = verifyProfileMedia({ owner, uploadId, ...declaration }, proof);
    return new ProfileMediaUpload({ owner, uploadId, status: 'prepared', declaration, derivative });
  }

  /** Reports an accepted immutable preparation without disclosing its private object identity. */
  public getPreparation(): Preparation | null {
    const { uploadId, status, derivative } = this.state;
    if (status === 'pending' || status === 'retired') return null;
    const { contentType, width, height, sizeBytes } = derivative;
    return { uploadId, contentType, width, height, sizeBytes };
  }

  /** Applies the owner's committed reference decision to an already verified candidate. */
  public adopt(): ProfileMediaUpload {
    const { status } = this.state;
    if (status === 'attached') return this;
    if (status === 'retired') throw new ProfileMediaError('upload-superseded');
    if (status === 'pending') throw new ProfileMediaError('upload-not-ready');
    return new ProfileMediaUpload({ ...this.state, status: 'attached' });
  }

  /** Persists an irrevocable fence and keeps the elected metadata available for physical cleanup. */
  public retire(): ProfileMediaUpload {
    return this.state.status === 'retired'
      ? this
      : new ProfileMediaUpload({ ...this.state, status: 'retired' });
  }

  /** Returns a derivative only for the exact owner-authorized reference, including during event lag. */
  public readDerivative(owner: ProfileMediaOwnerBinding, assetId: string): ProfileMediaDerivative {
    const { owner: storedOwner, uploadId, status, derivative } = this.state;
    if (
      !sameProfileMediaOwner(profileMediaOwner(owner), storedOwner) ||
      profileMediaIdentity(assetId, true) !== uploadId ||
      status === 'pending' ||
      status === 'retired'
    ) {
      throw new ProfileMediaError('not-found');
    }
    return { ...derivative };
  }

  private requireBeforeExpiry(now: Date, expiresAt: Date): void {
    if (instant(now) >= instant(expiresAt)) throw new ProfileMediaError('upload-expired');
  }

  private requireUploader(owner: ProfileMediaOwnerBinding, uploaderUserId: string): Declaration {
    const requestedOwner = profileMediaOwner(owner);
    const uploader = profileMediaIdentity(uploaderUserId);
    const { declaration } = this.state;
    const boundUploader =
      declaration?.uploaderUserId ?? (requestedOwner.kind === 'avatar' ? requestedOwner.id : null);
    if (!sameProfileMediaOwner(requestedOwner, this.state.owner) || boundUploader !== uploader) {
      throw new ProfileMediaError('not-found');
    }
    if (declaration === null) throw new ProfileMediaError('upload-superseded');
    return declaration;
  }
  // #endregion
}
