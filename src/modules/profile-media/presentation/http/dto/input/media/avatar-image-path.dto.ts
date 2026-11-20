import { GetAvatarImageInternalParams } from '@cadenway/contracts/validators/internal/storage-service';
import { zodDto } from '@cadenway/nest-common';

/** Validates an opaque avatar asset identity. */
export class AvatarImagePath extends zodDto(GetAvatarImageInternalParams) {}
