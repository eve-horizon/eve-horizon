import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  Inject,
} from '@nestjs/common';
import { existsSync, statSync, unlinkSync } from 'fs';
import { loadConfig, generateUserId, generateIdentityId } from '@eve/shared';
import { type Db, userQueries, identityQueries } from '@eve/db';
import { AppAuthService } from './app-auth.service.js';
import { safeEqual, fingerprintPublicKey } from './auth.util.js';
import type { BootstrapStatus } from './auth.types.js';

// Track when the API started for auto-open bootstrap window
const API_START_TIME = Date.now();

/**
 * First-admin bootstrap flow: window/mode resolution and admin provisioning.
 * Extracted verbatim from AuthService (refactor batch R-C3); AuthService
 * delegates here.
 */
@Injectable()
export class BootstrapService {
  private readonly users: ReturnType<typeof userQueries>;
  private readonly identities: ReturnType<typeof identityQueries>;
  private readonly bootstrapToken?: string;
  private readonly bootstrapTriggerFile: string;
  private readonly bootstrapWindowMinutes: number;

  constructor(
    @Inject('DB') db: Db,
    private readonly appAuth: AppAuthService,
  ) {
    const config = loadConfig();
    this.users = userQueries(db);
    this.identities = identityQueries(db);
    this.bootstrapToken = config.EVE_BOOTSTRAP_TOKEN;
    this.bootstrapTriggerFile = config.EVE_BOOTSTRAP_TRIGGER_FILE;
    this.bootstrapWindowMinutes = config.EVE_BOOTSTRAP_WINDOW_MINUTES;
  }

  async getBootstrapStatus(): Promise<BootstrapStatus> {
    const config = loadConfig();
    const isProduction = config.NODE_ENV === 'production';
    const existingAdmin = await this.users.findFirstAdmin();
    const completed = Boolean(existingAdmin);

    // If bootstrap already completed, return early
    if (completed) {
      return {
        completed: true,
        windowOpen: false,
        windowClosesAt: null,
        requiresToken: false,
        mode: 'closed',
      };
    }

    if (isProduction) {
      if (!this.bootstrapToken) {
        return {
          completed: false,
          windowOpen: false,
          windowClosesAt: null,
          requiresToken: true,
          mode: 'closed',
        };
      }

      return {
        completed: false,
        windowOpen: true,
        windowClosesAt: null,
        requiresToken: true,
        mode: 'secure',
      };
    }

    // Secure mode: EVE_BOOTSTRAP_TOKEN is set
    if (this.bootstrapToken) {
      return {
        completed: false,
        windowOpen: true,
        windowClosesAt: null,
        requiresToken: true,
        mode: 'secure',
      };
    }

    const windowMs = this.bootstrapWindowMinutes * 60 * 1000;

    // Check recovery mode: trigger file exists and was modified within window
    const triggerFileStatus = this.checkTriggerFile();
    if (triggerFileStatus.exists && triggerFileStatus.withinWindow) {
      const windowClosesAt = new Date(triggerFileStatus.mtime! + windowMs);
      return {
        completed: false,
        windowOpen: true,
        windowClosesAt,
        requiresToken: false,
        mode: 'recovery',
      };
    }

    // Check auto-open mode: within startup window
    const apiWindowClosesAt = new Date(API_START_TIME + windowMs);
    const withinStartupWindow = Date.now() < apiWindowClosesAt.getTime();

    if (withinStartupWindow) {
      return {
        completed: false,
        windowOpen: true,
        windowClosesAt: apiWindowClosesAt,
        requiresToken: false,
        mode: 'auto-open',
      };
    }

    // Window closed
    return {
      completed: false,
      windowOpen: false,
      windowClosesAt: null,
      requiresToken: false,
      mode: 'closed',
    };
  }

  private checkTriggerFile(): { exists: boolean; withinWindow: boolean; mtime?: number } {
    try {
      if (!existsSync(this.bootstrapTriggerFile)) {
        return { exists: false, withinWindow: false };
      }

      const stats = statSync(this.bootstrapTriggerFile);
      const mtime = stats.mtimeMs;
      const windowMs = this.bootstrapWindowMinutes * 60 * 1000;
      const withinWindow = Date.now() - mtime < windowMs;

      return { exists: true, withinWindow, mtime };
    } catch {
      return { exists: false, withinWindow: false };
    }
  }

  private cleanupTriggerFile(): void {
    try {
      if (existsSync(this.bootstrapTriggerFile)) {
        unlinkSync(this.bootstrapTriggerFile);
      }
    } catch {
      // Ignore cleanup errors - file may have been deleted or permission issues
    }
  }

  async bootstrapAdmin(input: { token?: string; email: string; public_key: string; display_name?: string }) {
    const config = loadConfig();
    const bootstrapStatus = await this.getBootstrapStatus();

    if (bootstrapStatus.completed) {
      // Non-production mode: allow re-bootstrap and return existing admin token
      if (config.NODE_ENV !== 'production') {
        const existingAdmin = await this.users.findFirstAdmin();
        if (existingAdmin) {
          const token = await this.appAuth.mintUserToken(existingAdmin.id, existingAdmin.email);
          return { ...token, user_id: existingAdmin.id };
        }
      }
      throw new ForbiddenException('Bootstrap already completed');
    }

    if (bootstrapStatus.requiresToken) {
      // Secure mode - verify token
      if (!input.token || !this.bootstrapToken || !safeEqual(input.token, this.bootstrapToken)) {
        throw new UnauthorizedException('Invalid bootstrap token');
      }
    } else if (!bootstrapStatus.windowOpen) {
      if (config.NODE_ENV === 'production') {
        throw new ForbiddenException(
          'Bootstrap window closed. Set EVE_BOOTSTRAP_TOKEN to enable bootstrap.',
        );
      }
      throw new ForbiddenException(
        'Bootstrap window closed. Set EVE_BOOTSTRAP_TOKEN or create trigger file on host.',
      );
    }

    const userId = generateUserId();
    const user = await this.users.create({
      id: userId,
      email: input.email,
      display_name: input.display_name ?? null,
      is_admin: true,
    });

    const fingerprint = fingerprintPublicKey(input.public_key);
    await this.identities.create({
      id: generateIdentityId(),
      user_id: user.id,
      provider: 'github_ssh',
      public_key: input.public_key,
      fingerprint,
      label: 'bootstrap',
    });

    // Clean up trigger file if it was used (recovery mode)
    if (bootstrapStatus.mode === 'recovery') {
      this.cleanupTriggerFile();
    }

    const token = await this.appAuth.mintUserToken(user.id, user.email);
    return { ...token, user_id: user.id };
  }
}
