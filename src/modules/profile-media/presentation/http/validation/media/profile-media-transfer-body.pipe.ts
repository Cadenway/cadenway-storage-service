import { SignProfileMediaTransferInternalBody } from '@cadenway/contracts/validators/internal/storage-service';
import { ProblemException, ZodValidationPipe } from '@cadenway/nest-common';
import type { ArgumentMetadata } from '@nestjs/common';

function declarationRefusal(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return null;
  const [avatar, logo] = SignProfileMediaTransferInternalBody.options;
  const declaration =
    value.kind === 'avatar' ? avatar : value.kind === 'organization-logo' ? logo : null;
  if (declaration === null) return null;
  const checked = declaration.safeParse(value);
  if (checked.success) return null;

  const issues = checked.error.issues;
  const policyIssues = issues.filter(
    (issue) =>
      (issue.path[0] === 'sizeBytes' && issue.code === 'too_big') ||
      (issue.path[0] === 'contentType' &&
        issue.code === 'invalid_value' &&
        'contentType' in value &&
        typeof value.contentType === 'string' &&
        value.contentType.length > 0),
  );
  if (policyIssues.length === 0 || policyIssues.length !== issues.length) return null;
  return policyIssues.some((issue) => issue.path[0] === 'sizeBytes')
    ? 'media.file-too-large'
    : 'media.unsupported-type';
}

/** Applies the published strict shape and the transfer route's two declaration refusal codes. */
export class ProfileMediaTransferBodyPipe extends ZodValidationPipe {
  // #region Constructor
  /** Binds the installed contract and keeps common validation for malformed bodies. */
  public constructor() {
    super(SignProfileMediaTransferInternalBody);
  }
  // #endregion

  // #region Methods
  /** Classifies an otherwise well-formed declaration with an unsupported size or encoding. */
  public override transform(value: unknown, metadata: ArgumentMetadata): unknown {
    try {
      return super.transform(value, metadata);
    } catch (error) {
      const code = declarationRefusal(value);
      if (code !== null) throw new ProblemException({ status: 422, code });
      throw error;
    }
  }
  // #endregion
}
