/** Account or organization that owns an image independently of the uploader. */
export interface ProfileMediaOwnerBinding {
  // #region Properties
  /** Determines the authorization scope and accepted source media. */
  readonly kind: 'avatar' | 'organization-logo';

  /** Account ID for an avatar and organization ID for a logo. */
  readonly id: string;
  // #endregion
}
