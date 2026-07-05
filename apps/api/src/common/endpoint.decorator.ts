import { applyDecorators, Delete, Get, HttpCode, HttpStatus, Patch, Post, Put } from '@nestjs/common';
import {
  ApiBody,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import type { ZodSchema } from 'zod';
import { RequirePermission } from '../auth/permission.decorator.js';
import type { Permission } from '../auth/permissions.js';
import { zodSchemaToOpenApi } from '../openapi.js';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const METHOD_DECORATORS: Record<HttpMethod, (path?: string | string[]) => MethodDecorator> = {
  GET: Get,
  POST: Post,
  PUT: Put,
  PATCH: Patch,
  DELETE: Delete,
};

export interface EndpointOptions {
  method: HttpMethod;
  /** Route path relative to the controller prefix (omit for the collection root). */
  path?: string;
  /** RBAC permission required for the route (emits @RequirePermission). */
  permission?: Permission;
  /** OpenAPI operation summary (emits @ApiOperation). */
  summary?: string;
  /** Zod request-body schema (emits @ApiBody). Requires bodyName. */
  body?: ZodSchema;
  /** OpenAPI component name for the request-body schema. */
  bodyName?: string;
  /**
   * Zod response schema. Emits @ApiCreatedResponse when status is 201,
   * otherwise @ApiOkResponse. Requires responseName.
   */
  response?: ZodSchema;
  /** OpenAPI component name for the response schema. */
  responseName?: string;
  /** Response description. Usable with or without a response schema. */
  responseDescription?: string;
  /**
   * Non-default runtime status code (emits @HttpCode). Also selects the
   * response decorator flavor: 201 -> @ApiCreatedResponse, 204 (without a
   * schema) -> @ApiNoContentResponse.
   */
  status?: HttpStatus;
  /**
   * Escape hatch for anything @Endpoint does not model (@ApiParam, @ApiQuery,
   * @ApiNotFoundResponse, custom response shapes, ...). List them in the same
   * top-to-bottom order they would appear in a hand-written decorator stack.
   *
   * Note: decorators that call zodSchemaToOpenApi() register their schema when
   * the array literal is evaluated — i.e. before @Endpoint's own body/response
   * registrations. If schema-component ordering matters for such an endpoint,
   * pass @ApiBody through extraDecorators as well (see webhooks createReplay).
   */
  extraDecorators?: MethodDecorator[];
}

/**
 * Composes the method-level decorator stack shared by nearly every endpoint:
 * permission guard metadata, HTTP verb + path, status code, and OpenAPI
 * operation/body/response documentation derived from Zod schemas.
 *
 * Parameter-level decorators (@Param, @Query pipes, @Body with
 * ZodValidationPipe, @CurrentUser, ...) cannot be composed with
 * applyDecorators and stay on the handler signature.
 *
 * The stack is applied in reverse list order to mirror TypeScript's bottom-up
 * application of hand-written decorator stacks, so multi-instance Swagger
 * metadata (e.g. repeated @ApiParam/@ApiQuery in extraDecorators) accumulates
 * in exactly the same order — the generated OpenAPI document is byte-identical
 * to the hand-written equivalent.
 */
export function Endpoint(options: EndpointOptions): MethodDecorator {
  const stack: MethodDecorator[] = [];

  if (options.permission) {
    stack.push(RequirePermission(options.permission));
  }
  stack.push(METHOD_DECORATORS[options.method](options.path));
  if (options.status !== undefined) {
    stack.push(HttpCode(options.status));
  }
  if (options.summary) {
    stack.push(ApiOperation({ summary: options.summary }));
  }
  if (options.extraDecorators) {
    stack.push(...options.extraDecorators);
  }
  if (options.body) {
    if (!options.bodyName) {
      throw new Error('Endpoint: body requires bodyName');
    }
    stack.push(ApiBody({ schema: zodSchemaToOpenApi(options.body, options.bodyName) }));
  }

  const responseOptions: { description?: string; schema?: ReturnType<typeof zodSchemaToOpenApi> } = {};
  if (options.responseDescription) {
    responseOptions.description = options.responseDescription;
  }
  if (options.response) {
    if (!options.responseName) {
      throw new Error('Endpoint: response requires responseName');
    }
    responseOptions.schema = zodSchemaToOpenApi(options.response, options.responseName);
  }
  if (responseOptions.schema || responseOptions.description) {
    if (options.status === HttpStatus.CREATED) {
      stack.push(ApiCreatedResponse(responseOptions));
    } else if (options.status === HttpStatus.NO_CONTENT && !responseOptions.schema) {
      stack.push(ApiNoContentResponse(responseOptions));
    } else {
      stack.push(ApiOkResponse(responseOptions));
    }
  }

  stack.reverse();
  return applyDecorators(...stack);
}
