import { Readable } from 'node:stream';
import { google } from 'googleapis';
import { CONFIG } from '../config.ts';
import { logger } from '../services/logger.ts';

const TAG = '[googleDrive]';

// TODO: Drive is an MVP image host, not a CDN — Google throttles hot-linked
// files and can serve an HTML interstitial instead of bytes, so Meta's crawler
// may see flaky image_link fetches at scale. Migrate to object storage
// (S3/GCS/R2) behind this same uploadImageToDrive-shaped interface.
// TODO: all tenants share one folder; isolation is only the unguessable file
// id (acceptable for public catalog images). Consider per-tenant subfolders to
// bound the blast radius of a credential leak or listing bug.

// Lazily-built Drive client so the app boots without Google creds; only the
// image-upload path requires them.
let driveClient: ReturnType<typeof google.drive> | null = null;

const getDrive = (): ReturnType<typeof google.drive> => {
  if (driveClient) {
    return driveClient;
  }
  const email = CONFIG.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  // Env stores the PEM with literal "\n"; restore real newlines for the key.
  const key = CONFIG.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, '\n');
  if (!email || !key || !CONFIG.GOOGLE_DRIVE_FOLDER_ID) {
    throw new Error('Google Drive is not configured (service account / folder id missing).');
  }
  const auth = new google.auth.JWT({
    email,
    key,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
};

// Direct-view URL form that serves the raw image bytes (usable as image_link),
// unlike the "/file/d/ID/view" share page.
const directImageUrl = (fileId: string): string =>
  `https://drive.google.com/uc?export=view&id=${fileId}`;

export interface DriveUpload {
  fileId: string;
  url: string;
}

/**
 * Upload an image buffer to the configured Drive folder, make it readable by
 * anyone with the link, and return a direct image URL. The file name should be
 * caller-namespaced (e.g. by tenant + sku) to avoid collisions.
 */
export const uploadImageToDrive = async (
  buffer: Buffer,
  fileName: string,
  mimeType: string,
): Promise<DriveUpload> => {
  const drive = getDrive();

  const created = await drive.files.create({
    requestBody: { name: fileName, parents: [CONFIG.GOOGLE_DRIVE_FOLDER_ID] },
    media: { mimeType, body: Readable.from(buffer) },
    fields: 'id',
  });

  const fileId = created.data.id;
  if (!fileId) {
    throw new Error('Drive upload returned no file id.');
  }

  // Public read so Meta and WhatsApp can fetch the image.
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  logger.info(`${TAG} uploaded ${fileName} -> ${fileId}`);
  return { fileId, url: directImageUrl(fileId) };
};
