import { GetOrganizationLogoImageInternalParams } from '@cadenway/contracts/validators/internal/storage-service';
import { zodDto } from '@cadenway/nest-common';

/** Validates an opaque organization logo asset identity. */
export class OrganizationLogoImagePath extends zodDto(GetOrganizationLogoImageInternalParams) {}
