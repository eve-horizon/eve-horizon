export type ParsedOrgDocUri = {
  scheme: 'org_docs';
  path: string;
  version?: number;
};

export type ParsedJobAttachmentUri = {
  scheme: 'job_attachments';
  jobId: string;
  name: string;
};

export type ParsedIngestUri = {
  scheme: 'ingest';
  ingestId: string;
  fileName: string;
};

export type ParsedResourceUri = ParsedOrgDocUri | ParsedJobAttachmentUri | ParsedIngestUri;

const ORG_DOCS_PREFIX = 'org_docs:/';
const JOB_ATTACHMENTS_PREFIX = 'job_attachments:/';
const INGEST_PREFIX = 'ingest:/';

export function normalizeOrgDocPath(path: string): string {
  if (!path) return '/';
  return path.startsWith('/') ? path : `/${path}`;
}

export function parseResourceUri(uri: string): ParsedResourceUri | null {
  if (!uri || typeof uri !== 'string') return null;

  if (uri.startsWith(ORG_DOCS_PREFIX)) {
    const raw = uri.slice(ORG_DOCS_PREFIX.length);
    if (!raw) return null;

    const match = raw.match(/^(.*)@v(\d+)$/);
    if (match) {
      const path = normalizeOrgDocPath(match[1]);
      const version = Number(match[2]);
      if (!Number.isFinite(version) || version <= 0) return null;
      return { scheme: 'org_docs', path, version };
    }

    return { scheme: 'org_docs', path: normalizeOrgDocPath(raw) };
  }

  if (uri.startsWith(JOB_ATTACHMENTS_PREFIX)) {
    const raw = uri.slice(JOB_ATTACHMENTS_PREFIX.length);
    if (!raw) return null;
    const parts = raw.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const [jobId, ...nameParts] = parts;
    const name = nameParts.join('/');
    if (!jobId || !name) return null;
    return { scheme: 'job_attachments', jobId, name };
  }

  if (uri.startsWith(INGEST_PREFIX)) {
    const raw = uri.slice(INGEST_PREFIX.length);
    if (!raw) return null;
    const parts = raw.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const [ingestId, ...fileNameParts] = parts;
    const fileName = decodeURIComponent(fileNameParts.join('/'));
    if (!ingestId || !fileName) return null;
    return { scheme: 'ingest', ingestId, fileName };
  }

  return null;
}

export function buildOrgDocUri(path: string, version?: number): string {
  const normalized = normalizeOrgDocPath(path).replace(/^\//, '');
  return version ? `org_docs:/${normalized}@v${version}` : `org_docs:/${normalized}`;
}

export function buildJobAttachmentUri(jobId: string, name: string): string {
  const trimmed = name.startsWith('/') ? name.slice(1) : name;
  return `job_attachments:/${jobId}/${trimmed}`;
}

export function buildIngestUri(ingestId: string, fileName: string): string {
  const encoded = encodeURIComponent(fileName);
  return `ingest:/${ingestId}/${encoded}`;
}

export function defaultMountPathForUri(uri: ParsedResourceUri): string {
  if (uri.scheme === 'org_docs') {
    return `org_docs/${uri.path.replace(/^\//, '')}`;
  }
  if (uri.scheme === 'ingest') {
    return `ingest/${uri.ingestId}/${uri.fileName}`;
  }
  return `job_attachments/${uri.jobId}/${uri.name}`;
}

export function isValidMountPath(value: string): boolean {
  if (!value) return false;
  if (value.startsWith('/')) return false;
  if (value.includes('..')) return false;
  return true;
}
