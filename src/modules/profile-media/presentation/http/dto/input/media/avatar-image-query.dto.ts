import { GetAvatarImageInternalQueryParams } from '@cadenway/contracts/validators/internal/storage-service';
import { zodDto } from '@cadenway/nest-common';

/** Validates the account identified by the gateway's current authorization check. */
export class AvatarImageQuery extends zodDto(GetAvatarImageInternalQueryParams) {}
