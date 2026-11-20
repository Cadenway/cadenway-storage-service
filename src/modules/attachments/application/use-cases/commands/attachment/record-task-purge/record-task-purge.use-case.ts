import type { AttachmentUnitOfWork } from '../../../../ports/outbound/transactions/attachment/attachment-unit-of-work.port.js';
import type { RecordTaskPurgeInput } from './record-task-purge.input.js';
import type { RecordTaskPurgeOutput } from './record-task-purge.output.js';

/** Prevents finalization after task purge and schedules bounded attachment cleanup. */
export class RecordTaskPurge {
  // #region Constructor
  /** Binds the tenant transaction shared with the event handler. */
  public constructor(private readonly work: AttachmentUnitOfWork) {}
  // #endregion

  // #region Methods
  /** Makes repeated task purge deliveries converge on the same tombstone and cleanup work. */
  public execute(input: RecordTaskPurgeInput): Promise<RecordTaskPurgeOutput> {
    return this.work.run(input.organizationId, async (store) => {
      await store.lockTask(input.taskKey);
      await store.registerTaskPurge(input.taskKey, input.actor);
      return undefined;
    });
  }
  // #endregion
}
