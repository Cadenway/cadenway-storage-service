/** Actor carried by the event that caused an attachment lifecycle transition. */
export interface AttachmentActor {
  // #region Properties
  /** Actor category from the shared event envelope. */
  readonly type: 'user' | 'automation' | 'git' | 'system';

  /** User, automation, integration or service identity. */
  readonly id: string;
  // #endregion
}
