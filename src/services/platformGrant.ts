import { PlatformRole, PlatformUserStatus } from '../constants/models.ts';
import { PlatformGrantSource } from '../constants/platformGrantSource.ts';

export const canUsePlatformGrant = (
  row: { status: PlatformUserStatus; role: PlatformRole; grantSource?: PlatformGrantSource } | null,
  allowlisted: boolean,
): boolean =>
  row !== null &&
  row.status === PlatformUserStatus.ACTIVE &&
  row.role === PlatformRole.SUPER_ADMIN &&
  (allowlisted || row.grantSource === PlatformGrantSource.PROVISIONED);
