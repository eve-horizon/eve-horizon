import {
  Controller,
  Get,
  Param,
  Req,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse, ApiBearerAuth } from '@nestjs/swagger';
import { RequirePermission } from '../auth/permission.decorator.js';
import { UsersService } from './users.service.js';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @RequirePermission('orgs:read')
  @Get(':user_id')
  @ApiOperation({ summary: 'Get user profile with org and project memberships' })
  @ApiOkResponse({ description: 'User profile with memberships' })
  async show(
    @Param('user_id') userId: string,
    @Req() request: { user?: { user_id?: string; is_admin?: boolean } },
  ) {
    const callerId = request.user?.user_id;
    const isAdmin = request.user?.is_admin ?? false;

    // "me" is shorthand for the current user
    const targetId = userId === 'me' ? callerId : userId;
    if (!targetId) {
      throw new NotFoundException('User not found');
    }

    return this.usersService.show(targetId, callerId, isAdmin);
  }
}
