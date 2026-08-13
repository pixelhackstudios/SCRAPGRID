import { createHash } from 'node:crypto';

export class AttachmentError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AttachmentError';
  }
}

export const ATTACHMENT_MAX_FILES = 8;
export const ATTACHMENT_MAX_BYTES = 256 * 1024;
export const ATTACHMENT_MAX_REQUEST_BYTES = 1024 * 1024;

const ALLOWED_EXTENSIONS = new Set(['md', 'txt', 'json', 'yaml', 'yml', 'toml', 'csv', 'tsv', 'xml']);

const MEDIA_TYPES: Record<string, string> = {
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  yaml: 'application/yaml; charset=utf-8',
  yml: 'application/yaml; charset=utf-8',
  toml: 'application/toml; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
};

export interface AttachmentDraft {
  filename: string;
  media_type: string;
  body: string;
  byte_size: number;
  sha256: string;
}

export interface AttachmentInput {
  filename: string;
  content: string;
}

function attachmentError(message: string, code = 'invalid_attachment'): never {
  throw new AttachmentError(message, code);
}

export function sanitizeAttachmentFilename(raw: string): string {
  const trimmed = raw.trim().replaceAll('\\', '/');
  const base = trimmed.split('/').pop() ?? '';
  if (!base || base === '.' || base === '..' || base.includes('\0')) {
    attachmentError('attachment filename must be a plain file name');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(base) || base.startsWith('.')) {
    attachmentError(`attachment filename is not allowed: ${base}`);
  }
  return base;
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) attachmentError(`attachment ${filename} needs a text extension`);
  return filename.slice(dot + 1).toLowerCase();
}

function requireUtf8Text(filename: string, content: string): Buffer {
  if (content.includes('\0')) attachmentError(`${filename} contains a NUL byte`);
  let encoded: Buffer;
  try {
    encoded = Buffer.from(content, 'utf8');
  } catch {
    attachmentError(`${filename} is not valid UTF-8`);
  }
  if (encoded.toString('utf8') !== content) attachmentError(`${filename} is not valid UTF-8`);
  return encoded;
}

export function parseAttachmentInputs(value: unknown): AttachmentInput[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) attachmentError('files must be an array');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      attachmentError(`files[${index}] must be an object`);
    }
    const row = item as Record<string, unknown>;
    if (typeof row['filename'] !== 'string' || row['filename'].length === 0) {
      attachmentError(`files[${index}].filename must be a non-empty string`);
    }
    if (typeof row['content'] !== 'string') {
      attachmentError(`files[${index}].content must be a string`);
    }
    return { filename: row['filename'], content: row['content'] };
  });
}

export function prepareAttachments(inputs: AttachmentInput[]): AttachmentDraft[] {
  if (inputs.length > ATTACHMENT_MAX_FILES) {
    attachmentError(`at most ${ATTACHMENT_MAX_FILES} files may be sent in one request`, 'attachment_limit');
  }
  let total = 0;
  const drafts = inputs.map((input) => {
    const filename = sanitizeAttachmentFilename(input.filename);
    const extension = extensionOf(filename);
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      attachmentError(`${filename} is not an allowed text type`);
    }
    const encoded = requireUtf8Text(filename, input.content);
    if (encoded.byteLength > ATTACHMENT_MAX_BYTES) {
      attachmentError(`${filename} exceeds ${ATTACHMENT_MAX_BYTES} bytes`, 'attachment_too_large');
    }
    total += encoded.byteLength;
    return {
      filename,
      media_type: MEDIA_TYPES[extension] ?? 'text/plain; charset=utf-8',
      body: input.content,
      byte_size: encoded.byteLength,
      sha256: createHash('sha256').update(encoded).digest('hex'),
    };
  });
  if (total > ATTACHMENT_MAX_REQUEST_BYTES) {
    attachmentError(`attachments exceed ${ATTACHMENT_MAX_REQUEST_BYTES} bytes`, 'attachment_too_large');
  }
  return drafts;
}
