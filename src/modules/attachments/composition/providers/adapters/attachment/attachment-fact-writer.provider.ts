import { OutboxWriter } from '@cadenway/nest-messaging/outbox/writer';
import type { FactoryProvider } from '@nestjs/common';

import { createAttachmentFactWriter } from '../../../../infrastructure/messaging/outbox/attachment/outbox-attachment-facts.adapter.js';
import { ATTACHMENT_FACT_WRITER } from '../../../tokens/attachment/attachment-fact-writer.token.js';

/** Binds attachment lifecycle facts to the service's transactional outbox. */
export const attachmentFactWriterProvider: FactoryProvider<
  ReturnType<typeof createAttachmentFactWriter>
> = {
  provide: ATTACHMENT_FACT_WRITER,
  inject: [OutboxWriter],
  useFactory: createAttachmentFactWriter,
};
