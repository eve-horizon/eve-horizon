import { SetMetadata } from '@nestjs/common';
import type { Permission } from './permissions.js';

export const PERMISSION_KEY = 'required_permission';

/**
 * Declare what permission(s) an endpoint requires.
 * Multiple permissions use OR semantics — any one suffices.
 */
export const RequirePermission = (...permissions: Permission[]) =>
  SetMetadata(PERMISSION_KEY, permissions);

export const SCOPE_NARROWED_KEY = 'scope_narrowed';

/**
 * Mark a handler that narrows its own results to a restricted caller's scope
 * (a job, service or service-principal token, or an org-bound user token).
 * Org-bound user tokens may call such a handler without a project, org or
 * project-owned resource in the path; every other handler needs one.
 */
export const ScopeNarrowed = () => SetMetadata(SCOPE_NARROWED_KEY, true);
