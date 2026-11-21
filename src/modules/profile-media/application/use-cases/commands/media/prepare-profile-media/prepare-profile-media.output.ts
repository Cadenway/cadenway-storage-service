import type { ProfileMediaPreparation } from '../../../../models/media/profile-media-preparation.model.js';

/** Elected derivative metadata, excluding the private candidate ID. */
export interface PrepareProfileMediaOutput {
  // #region Properties
  /** Scoped operation or value. */
  readonly preparation: ProfileMediaPreparation;
  // #endregion
}
