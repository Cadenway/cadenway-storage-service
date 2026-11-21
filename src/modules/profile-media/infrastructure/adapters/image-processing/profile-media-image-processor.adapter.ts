import { fileTypeFromBuffer } from 'file-type';
import sharp, { type Sharp } from 'sharp';

import type { ProfileMediaImageProcessor as ImageProcessorPort } from '../../../application/ports/outbound/image-processing/media/profile-media-image-processor.port.js';
import { ProfileMediaError } from '../../../domain/errors/media/profile-media.error.js';
import {
  MAX_PROFILE_MEDIA_DERIVATIVE_SIDE,
  MAX_PROFILE_MEDIA_SOURCE_SIDE,
  MIN_AVATAR_SOURCE_SIDE,
  requireProfileMediaDeclaration,
} from '../../../domain/policies/media/profile-media-verification.policy.js';
import type { ProfileMediaOwnerBinding } from '../../../domain/value-objects/media/profile-media-owner-binding.value-object.js';
import type { ProfileMediaVerification } from '../../../domain/value-objects/media/profile-media-verification.value-object.js';
import { profilePng } from './profile-png.js';
import { sanitizeProfileSvg } from './profile-svg.js';

/** The replica already has a native image decode in progress. */
export class ProfileMediaImageProcessingBusyError extends Error {
  // #region Constructor
  /** Reports a retryable capacity limit without details about the image. */
  public constructor() {
    super('Profile image processing is busy.');
    this.name = 'ProfileMediaImageProcessingBusyError';
  }
  // #endregion
}

type OwnerKind = ProfileMediaOwnerBinding['kind'];
type SourceProof = ProfileMediaVerification['source'];

interface PreparedInput {
  // #region Properties
  /** The validated decoder and the source observations for the resulting candidate. */
  readonly image: Sharp;
  readonly source: SourceProof;
  // #endregion
}

function invalidImage(): never {
  throw new ProfileMediaError('invalid-image');
}

function decoder(bytes: Buffer): Sharp {
  return sharp(bytes, {
    failOn: 'warning',
    ignoreIcc: true,
    limitInputChannels: 4,
    limitInputPixels: MAX_PROFILE_MEDIA_SOURCE_SIDE ** 2,
    pages: 1,
    sequentialRead: true,
  });
}

function dimensions(kind: OwnerKind, width: number, height: number, frames: number): void {
  const minimum = kind === 'avatar' ? MIN_AVATAR_SOURCE_SIDE : 1;
  if (
    !Number.isSafeInteger(width) ||
    width < minimum ||
    width > MAX_PROFILE_MEDIA_SOURCE_SIDE ||
    width !== height ||
    frames !== 1
  ) {
    invalidImage();
  }
}

async function prepareInput(
  kind: OwnerKind,
  contentType: string,
  bytes: Buffer,
): Promise<PreparedInput> {
  const sizeBytes = bytes.byteLength;
  if (contentType === 'image/svg+xml') {
    const { svg, sourceSide } = sanitizeProfileSvg(bytes);
    return {
      image: decoder(svg),
      source: {
        contentType,
        sizeBytes,
        width: sourceSide,
        height: sourceSide,
        frames: 1,
        selfContainedSvg: true,
      },
    };
  }

  // The PNG preflight excludes animation and avoids handing compressed ancillary metadata to libvips.
  if (contentType === 'image/png') {
    const png = profilePng(bytes);
    dimensions(kind, png.width, png.height, 1);
    return {
      image: decoder(png.bytes),
      source: { contentType, sizeBytes, width: png.width, height: png.height, frames: 1 },
    };
  }

  const detected = await fileTypeFromBuffer(bytes);
  if (detected?.mime !== contentType) return invalidImage();
  const image = decoder(bytes);
  const { width, height, pages = 1, format } = await image.metadata();
  if (`image/${format}` !== contentType) return invalidImage();
  dimensions(kind, width, height, pages);
  return {
    image: image.autoOrient(),
    source: { contentType, sizeBytes, width, height, frames: pages },
  };
}

/** Decodes one bounded source at a time and encodes only static PNG bytes. Register as a singleton. */
export class ProfileMediaImageProcessor implements ImageProcessorPort {
  // #region Properties
  /** The replica admits one native decode without an unbounded queue of uploaded buffers. */
  private processing = false;
  // #endregion

  // #region Constructor
  /** Limits the only libvips workload in Storage to one thread without an operation cache. */
  public constructor() {
    sharp.block({ operation: ['VipsForeignLoad'] });
    sharp.unblock({
      operation: [
        'VipsForeignLoadJpegBuffer',
        'VipsForeignLoadPngBuffer',
        'VipsForeignLoadWebpBuffer',
        'VipsForeignLoadSvgBuffer',
      ],
    });
    sharp.cache(false);
    sharp.concurrency(1);
  }
  // #endregion

  // #region Methods
  /** Returns inspected proof for the exact source and its immutable candidate PNG. */
  public async transform(
    input: {
      readonly kind: OwnerKind;
      readonly contentType: string;
      readonly bytes: Buffer;
      readonly candidateId: string;
    },
    signal?: AbortSignal,
  ): Promise<{ readonly png: Buffer; readonly verification: ProfileMediaVerification }> {
    signal?.throwIfAborted();
    requireProfileMediaDeclaration(input.kind, input.contentType, input.bytes.byteLength);
    if (this.processing) throw new ProfileMediaImageProcessingBusyError();
    this.processing = true;
    try {
      const { image, source } = await prepareInput(input.kind, input.contentType, input.bytes);
      signal?.throwIfAborted();
      const side = Math.min(source.width, MAX_PROFILE_MEDIA_DERIVATIVE_SIDE);
      const encoded = await image
        .resize(side, side, { fit: 'inside', withoutEnlargement: true })
        .toColourspace('srgb')
        .png()
        .timeout({ seconds: 3 })
        .toBuffer();
      signal?.throwIfAborted();
      const result = profilePng(encoded);
      if (result.width !== side || result.height !== side) return invalidImage();
      return {
        png: result.bytes,
        verification: {
          candidateId: input.candidateId,
          source,
          derivative: {
            contentType: 'image/png',
            width: result.width,
            height: result.height,
            sizeBytes: result.bytes.byteLength,
            metadataFree: true,
          },
        },
      };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof ProfileMediaError) throw error;
      return invalidImage();
    } finally {
      this.processing = false;
    }
  }
  // #endregion
}
