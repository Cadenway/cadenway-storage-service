import { describe, expect, it } from 'vitest';

import { registeredAttachmentMediaType } from './registered-attachment-media-type.adapter.js';

describe('registeredAttachmentMediaType', () => {
  it.each([
    ['capture-login.PNG', 'image/png'],
    ['atelier-nord.LOG', 'text/plain'],
    ['sprint-14.png.txt', 'text/plain'],
    ['preuve.pdf', 'application/pdf'],
    ['png', null],
    ['.log', null],
    ['journal.cadenway-unknown', null],
  ])('resolves the last extension of %s', (fileName, mediaType) => {
    expect(registeredAttachmentMediaType.lookup(fileName)).toBe(mediaType);
  });
});
