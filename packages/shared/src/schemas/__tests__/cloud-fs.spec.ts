import { describe, expect, it } from 'vitest';
import {
  CloudFsBrowseRequestSchema,
  CloudFsBrowseResponseSchema,
  CloudFsSearchRequestSchema,
  CloudFsSearchResponseSchema,
} from '../cloud-fs.js';

describe('cloud fs schemas', () => {
  it('parses explicit false query strings as false', () => {
    expect(CloudFsBrowseRequestSchema.parse({ recursive: 'false' }).recursive).toBe(false);
    expect(CloudFsBrowseRequestSchema.parse({ recursive: '0' }).recursive).toBe(false);
    expect(CloudFsBrowseRequestSchema.parse({ recursive: 'true' }).recursive).toBe(true);
  });

  it('rejects invalid browse query booleans and page sizes', () => {
    expect(CloudFsBrowseRequestSchema.safeParse({ recursive: 'maybe' }).success).toBe(false);
    expect(CloudFsBrowseRequestSchema.safeParse({ page_size: 'abc' }).success).toBe(false);
  });

  it('rejects recursive browse with a page token', () => {
    const parsed = CloudFsBrowseRequestSchema.safeParse({ recursive: 'true', page_token: 'next' });
    expect(parsed.success).toBe(false);
  });

  it('accepts browse response pagination metadata', () => {
    const parsed = CloudFsBrowseResponseSchema.parse({
      mount_id: 'mount_a',
      path: '/',
      entries: [],
      next_page_token: 'next',
      truncated: true,
    });
    expect(parsed.next_page_token).toBe('next');
    expect(parsed.truncated).toBe(true);
  });

  it('parses search request paging and MIME filters', () => {
    const parsed = CloudFsSearchRequestSchema.parse({
      q: 'budget',
      mount_id: 'mount_a',
      mime_type: 'application/pdf',
      page_token: 'next',
      page_size: '25',
      order_by: 'modified_desc',
    });

    expect(parsed).toEqual({
      q: 'budget',
      mount_id: 'mount_a',
      mime_type: 'application/pdf',
      page_token: 'next',
      page_size: 25,
      order_by: 'modified_desc',
    });
  });

  it('accepts search response pagination metadata', () => {
    const parsed = CloudFsSearchResponseSchema.parse({
      mount_id: 'mount_a',
      entries: [],
      next_page_token: 'next',
    });
    expect(parsed.next_page_token).toBe('next');
  });
});
