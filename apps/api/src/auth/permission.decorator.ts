import { SetMetadata } from '@nestjs/common';
import type { Permission } from './permissions.js';

export const PERMISSION_KEY = 'required_permission';

/**
 * Declare what permission(s) an endpoint requires.
 * Multiple permissions use OR semantics — any one suffices.
 */
export const RequirePermission = (...permissions: Permission[]) =>
  SetMetadata(PERMISSION_KEY, permissions);
