/** Observations made by the bounded decoder and encoder on one pinned source and candidate. */
export interface ProfileMediaVerification {
  // #region Properties
  /** Private object candidate already reserved for this verification attempt. */
  readonly candidateId: string;

  /** Decoded characteristics from the exact bytes transformed by the adapter. */
  readonly source: {
    readonly contentType: string;
    readonly sizeBytes: number;
    readonly width: number;
    readonly height: number;
    readonly frames: number;
    readonly selfContainedSvg?: boolean;
  };

  /** Inspected characteristics of the candidate produced from that source. */
  readonly derivative: {
    readonly contentType: string;
    readonly width: number;
    readonly height: number;
    readonly sizeBytes: number;
    readonly metadataFree: boolean;
  };
  // #endregion
}
