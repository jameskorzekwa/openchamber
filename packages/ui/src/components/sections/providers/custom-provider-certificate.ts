import { z } from 'zod';

export type ClientCertificateFields = {
  cert: string;
  key: string;
  passphrase: string;
};

export type StoredClientCertificate = { cert: string; key: string; passphrase?: string };

export const EMPTY_CLIENT_CERTIFICATE: ClientCertificateFields = { cert: '', key: '', passphrase: '' };

const FILE_REFERENCE_PATTERN = /^\{file:([^}]+)\}$/;

export const storedTlsSchema = z.object({
  cert: z.string().optional(),
  key: z.string().optional(),
  passphrase: z.string().optional(),
});
type StoredTlsFields = z.infer<typeof storedTlsSchema>;

const clientCertificateFieldOf = (value: string | undefined): string => {
  if (value === undefined) return '';
  return value.trim().match(FILE_REFERENCE_PATTERN)?.[1]?.trim() ?? value;
};

const storedClientCertificateValueOf = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('{') || trimmed.includes('-----BEGIN')) return trimmed;
  return `{file:${trimmed}}`;
};

export const isRelativeCertificatePath = (value: string): boolean => {
  const trimmed = value.trim();
  const path = trimmed.match(FILE_REFERENCE_PATTERN)?.[1]?.trim()
    ?? (trimmed.startsWith('{') || trimmed.includes('-----BEGIN') ? '' : trimmed);
  return Boolean(path) && !/^(\/|~\/|[A-Za-z]:[\\/]|\\\\)/.test(path);
};

export const clientCertificateFieldsOf = (stored: StoredTlsFields | undefined): ClientCertificateFields => {
  if (!stored) return EMPTY_CLIENT_CERTIFICATE;
  return {
    cert: clientCertificateFieldOf(stored.cert),
    key: clientCertificateFieldOf(stored.key),
    passphrase: stored.passphrase ?? '',
  };
};

export const storedClientCertificateOf = (
  fields: ClientCertificateFields | null,
): StoredClientCertificate | null | undefined => {
  if (fields === null) return undefined;
  const cert = storedClientCertificateValueOf(fields.cert);
  const key = storedClientCertificateValueOf(fields.key);
  const passphrase = fields.passphrase.trim() ? fields.passphrase : '';
  if (!cert && !key && !passphrase) return null;
  const stored: StoredClientCertificate = { cert, key };
  if (passphrase) stored.passphrase = passphrase;
  return stored;
};
