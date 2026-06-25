import { readFileSync, statSync } from 'node:fs';
import { resolve as resolvePath, basename } from 'node:path';
import type { FlagValue } from '../lib/args';
import { getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson } from '../lib/client';
import { outputJson } from '../lib/output';

interface CreateIngestResponse {
  ingest_id: string;
  upload_url: string;
  upload_method: string;
  upload_expires_at: string;
  max_bytes: number;
  storage_key: string;
}

interface ConfirmIngestResponse {
  ingest_id: string;
  status: string;
  event_id: string | null;
  job_id: string | null;
}

export async function handleIngest(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);
  const projectId = getStringFlag(flags, ['project', 'project-id', 'project_id']) ?? context.projectId;

  if (!projectId) {
    throw new Error('Missing project id. Provide --project or set a profile default.');
  }

  // Detect if subcommand is actually a file path (eve ingest <file>)
  const isFileSubcommand = subcommand && !['create', 'list', 'show'].includes(subcommand);
  const effectiveSubcommand = isFileSubcommand ? 'create' : subcommand;
  const effectivePositionals = isFileSubcommand ? [subcommand, ...positionals] : positionals;

  switch (effectiveSubcommand) {
    case 'create':
    case undefined: {
      // eve ingest <file> or eve ingest create <file>
      const filePath = effectivePositionals[0];

      if (!filePath) {
        throw new Error(
          'Usage: eve ingest <file> [--title <title>] [--description <desc>] [--instructions <text>] [--tags <a,b>]\n' +
          '       eve ingest create <file> [same flags]\n' +
          '       eve ingest list [--status <status>]\n' +
          '       eve ingest show <ingest_id>',
        );
      }

      const resolvedPath = resolvePath(filePath);
      const stat = statSync(resolvedPath);
      const fileName = basename(resolvedPath);
      const sizeBytes = stat.size;

      // Infer mime type from extension
      const mimeType = getStringFlag(flags, ['mime-type', 'mime_type']) ?? inferMimeType(fileName);
      const title = getStringFlag(flags, ['title']);
      const description = getStringFlag(flags, ['description', 'desc']);
      const instructions = getStringFlag(flags, ['instructions']);
      const tagsRaw = getStringFlag(flags, ['tags']);
      const tags = tagsRaw ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
      const sourceChannel = getStringFlag(flags, ['source-channel', 'source_channel']) ?? 'cli';

      // Step 1: Create ingest record
      const createResp = await requestJson<CreateIngestResponse>(
        context,
        `/projects/${projectId}/ingest`,
        {
          method: 'POST',
          body: {
            file_name: fileName,
            mime_type: mimeType,
            size_bytes: sizeBytes,
            ...(title ? { title } : {}),
            ...(description ? { description } : {}),
            ...(instructions ? { instructions } : {}),
            ...(tags ? { tags } : {}),
            source_channel: sourceChannel,
          },
        },
      );

      // Step 2: Upload file to presigned URL
      const fileContent = readFileSync(resolvedPath);
      const uploadResp = await fetch(createResp.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': mimeType },
        body: fileContent,
      });

      if (!uploadResp.ok) {
        throw new Error(`Upload failed: HTTP ${uploadResp.status}`);
      }

      // Step 3: Confirm upload
      const confirmResp = await requestJson<ConfirmIngestResponse>(
        context,
        `/projects/${projectId}/ingest/${createResp.ingest_id}/confirm`,
        { method: 'POST' },
      );

      if (json) {
        outputJson({
          ingest_id: createResp.ingest_id,
          status: confirmResp.status,
          event_id: confirmResp.event_id,
          job_id: confirmResp.job_id,
          file_name: fileName,
          size_bytes: sizeBytes,
          storage_key: createResp.storage_key,
        }, json);
      } else {
        console.log(`Ingested: ${fileName} (${sizeBytes} bytes)`);
        console.log(`  ingest_id: ${createResp.ingest_id}`);
        console.log(`  status: ${confirmResp.status}`);
        if (confirmResp.event_id) console.log(`  event_id: ${confirmResp.event_id}`);
        if (confirmResp.job_id) console.log(`  job_id: ${confirmResp.job_id}`);
      }
      return;
    }

    case 'list': {
      const status = getStringFlag(flags, ['status']);
      const limit = getStringFlag(flags, ['limit']);
      const offset = getStringFlag(flags, ['offset']);
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (limit) params.set('limit', limit);
      if (offset) params.set('offset', offset);
      const suffix = params.toString() ? `?${params.toString()}` : '';

      const result = await requestJson<{ items: unknown[]; total: number }>(
        context,
        `/projects/${projectId}/ingest${suffix}`,
      );

      if (json) {
        outputJson(result, json);
      } else {
        const items = result.items as Array<Record<string, unknown>>;
        if (items.length === 0) {
          console.log('No ingest records found.');
          return;
        }
        console.log(`Ingest records (${items.length} of ${result.total}):\n`);
        for (const item of items) {
          const statusStr = item.status === 'done' ? 'done' :
            item.status === 'failed' ? 'FAILED' :
            item.status === 'processing' ? 'processing...' :
            String(item.status);
          console.log(`  ${item.id}  ${item.file_name}  [${statusStr}]`);
        }
      }
      return;
    }

    case 'show': {
      const ingestId = positionals[0];
      if (!ingestId) {
        throw new Error('Usage: eve ingest show <ingest_id> [--json]');
      }

      const result = await requestJson<Record<string, unknown>>(
        context,
        `/projects/${projectId}/ingest/${ingestId}`,
      );

      if (json) {
        outputJson(result, json);
      } else {
        console.log(`Ingest: ${result.id}`);
        console.log(`  file: ${result.file_name} (${result.size_bytes} bytes)`);
        console.log(`  status: ${result.status}`);
        console.log(`  mime: ${result.mime_type}`);
        if (result.title) console.log(`  title: ${result.title}`);
        if (result.description) console.log(`  description: ${result.description}`);
        if (result.instructions) console.log(`  instructions: ${result.instructions}`);
        if (result.event_id) console.log(`  event_id: ${result.event_id}`);
        if (result.job_id) console.log(`  job_id: ${result.job_id}`);
        if (result.error_message) console.log(`  error: ${result.error_message}`);
        console.log(`  created: ${result.created_at}`);
        if (result.completed_at) console.log(`  completed: ${result.completed_at}`);
      }
      return;
    }

    default:
      throw new Error(
        'Usage: eve ingest <file> [--title <title>] [--description <desc>] [--instructions <text>] [--tags <a,b>]\n' +
        '       eve ingest list [--status <status>]\n' +
        '       eve ingest show <ingest_id>',
      );
  }
}

function inferMimeType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase();
  switch (ext) {
    // Text
    case 'md': return 'text/markdown';
    case 'txt': return 'text/plain';
    case 'csv': return 'text/csv';
    case 'html':
    case 'htm': return 'text/html';
    // Structured data
    case 'json': return 'application/json';
    case 'yaml':
    case 'yml': return 'application/yaml';
    case 'xml': return 'application/xml';
    // Documents
    case 'pdf': return 'application/pdf';
    case 'doc': return 'application/msword';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'rtf': return 'application/rtf';
    // Images
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
    case 'tiff':
    case 'tif': return 'image/tiff';
    // Audio
    case 'mp3': return 'audio/mpeg';
    case 'wav': return 'audio/wav';
    case 'm4a': return 'audio/mp4';
    case 'aac': return 'audio/aac';
    case 'ogg': return 'audio/ogg';
    case 'opus': return 'audio/opus';
    case 'flac': return 'audio/flac';
    case 'wma': return 'audio/x-ms-wma';
    case 'amr': return 'audio/amr';
    case 'm4b': return 'audio/mp4';
    case 'm4r': return 'audio/mp4';
    case 'oga': return 'audio/ogg';
    // Video
    case 'mp4': return 'video/mp4';
    case 'mkv': return 'video/x-matroska';
    case 'mov': return 'video/quicktime';
    case 'avi': return 'video/x-msvideo';
    case 'wmv': return 'video/x-ms-wmv';
    case 'webm': return 'video/webm';
    case 'flv': return 'video/x-flv';
    case 'm4v': return 'video/x-m4v';
    case 'mpeg':
    case 'mpg': return 'video/mpeg';
    case '3gp': return 'video/3gpp';
    case 'ogv': return 'video/ogg';
    default: return 'application/octet-stream';
  }
}
