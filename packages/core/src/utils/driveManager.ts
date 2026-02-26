/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { drive_v3 } from 'googleapis';
import { google } from 'googleapis';
import { getOauthClient } from '../code_assist/oauth2.js';
import type { Config } from '../config/config.js';
import { AuthType } from '../core/contentGenerator.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { debugLogger } from './debugLogger.js';
import { Storage } from '../config/storage.js';

export class DriveManager {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  private async getDriveClient(): Promise<drive_v3.Drive> {
    const authType = AuthType.USE_GEMINI;
    const authClient = await getOauthClient(authType, this.config);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-unsafe-assignment
    return google.drive({ version: 'v3', auth: authClient as any });
  }

  /**
   * Finds the gemini-cli/md-files folder in Google Drive, creating it if it doesn't exist.
   */
  private async getOrCreateWorkspaceFolder(): Promise<string> {
    const driveClient = await this.getDriveClient();

    // First, look for the 'gemini-cli' folder
    let geminiCliFolderId = await this.findFolder(
      driveClient,
      'gemini-cli',
      'root',
    );

    if (!geminiCliFolderId) {
      geminiCliFolderId = await this.createFolder(
        driveClient,
        'gemini-cli',
        'root',
      );
    }

    // Then, look for the 'md-files' inside 'gemini-cli'
    let mdFilesFolderId = await this.findFolder(
      driveClient,
      'md-files',
      geminiCliFolderId,
    );

    if (!mdFilesFolderId) {
      mdFilesFolderId = await this.createFolder(
        driveClient,
        'md-files',
        geminiCliFolderId,
      );
    }

    return mdFilesFolderId;
  }

  private async findFolder(
    driveClient: drive_v3.Drive,
    folderName: string,
    parentId: string,
  ): Promise<string | null> {
    const res = await driveClient.files.list({
      q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`,
      fields: 'files(id, name)',
      spaces: 'drive',
    });

    if (res.data.files && res.data.files.length > 0) {
      return res.data.files[0].id!;
    }
    return null;
  }

  private async createFolder(
    driveClient: drive_v3.Drive,
    folderName: string,
    parentId: string,
  ): Promise<string> {
    const res = await driveClient.files.create({
      requestBody: {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      },
      fields: 'id',
    });

    return res.data.id!;
  }

  /**
   * Uploads a local markdown file to the Drive workspace folder.
   */
  async uploadFile(localFilePath: string): Promise<void> {
    try {
      const driveClient = await this.getDriveClient();
      const folderId = await this.getOrCreateWorkspaceFolder();
      const fileName = path.basename(localFilePath);

      // Check if the file already exists in the folder
      const res = await driveClient.files.list({
        q: `name='${fileName}' and '${folderId}' in parents and trashed=false`,
        fields: 'files(id)',
      });

      const fileContent = await fs.readFile(localFilePath, 'utf-8');

      if (res.data.files && res.data.files.length > 0) {
        // Update existing

        const fileId = res.data.files[0].id!;
        await driveClient.files.update({
          fileId,
          media: {
            mimeType: 'text/markdown',
            body: fileContent,
          },
        });
      } else {
        // Create new
        await driveClient.files.create({
          requestBody: {
            name: fileName,
            parents: [folderId],
          },
          media: {
            mimeType: 'text/markdown',
            body: fileContent,
          },
        });
      }
    } catch (e) {
      debugLogger.warn('Failed to upload file to Drive', e);
      throw e;
    }
  }

  /**
   * Lists all markdown files from the Drive workspace folder.
   */
  async listFiles(): Promise<Array<{ id: string; name: string }>> {
    const driveClient = await this.getDriveClient();
    try {
      const folderId = await this.getOrCreateWorkspaceFolder();
      const res = await driveClient.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'files(id, name)',
        spaces: 'drive',
      });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return (res.data.files || []) as Array<{ id: string; name: string }>;
    } catch (e) {
      debugLogger.warn('Failed to list files from Drive', e);
      return [];
    }
  }

  /**
   * Downloads a file from the Drive workspace folder to the local machine.
   */
  async downloadFile(fileId: string, fileName: string): Promise<string> {
    try {
      const driveClient = await this.getDriveClient();
      const res = await driveClient.files.get(
        { fileId, alt: 'media' },
        { responseType: 'text' },
      );

      // Choose destination based on type
      const destDir = fileName.endsWith('.AGENTS')
        ? path.join(Storage.getGlobalGeminiDir(), 'skills')
        : process.cwd();

      await fs.mkdir(destDir, { recursive: true });
      const localFilePath = path.join(destDir, fileName);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      await fs.writeFile(localFilePath, res.data as string, 'utf-8');
      return localFilePath;
    } catch (e) {
      debugLogger.warn('Failed to download file from Drive', e);
      throw e;
    }
  }
}
