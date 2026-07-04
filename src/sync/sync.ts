import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { SonicNoteApiClient } from './api';
import { SonicNoteSettings, LocalFileInfo, Recording, SyncResult, TranscriptSegment, SummaryData, StudyReportData } from './types';
import { formatFileName, sanitizeFileName, toMarkdown } from './formatter';

export class SyncService {
  constructor(
    private api: SonicNoteApiClient,
    private getSettings: () => SonicNoteSettings,
    private onSyncComplete?: (lastSyncTime: string) => Promise<void>
  ) {}

  async syncAll(onProgress?: (msg: string) => void): Promise<SyncResult> {
    const settings = this.getSettings();
    const result: SyncResult = { total: 0, synced: 0, skipped: 0, errors: 0, errorMessages: [] };

    // Get workspace folder
    const workspaceFolder = this.getWorkspaceFolder();
    if (!workspaceFolder) {
      vscode.window.showWarningMessage('请先打开一个工作区文件夹');
      return result;
    }

    // 1. Resolve sync folder path: absolute path, or relative to workspace
    const syncFolderPath = path.isAbsolute(settings.syncFolder)
      ? settings.syncFolder
      : settings.syncFolder
        ? path.join(workspaceFolder, settings.syncFolder)
        : path.join(workspaceFolder, 'SonicNoteSync');
    await this.ensureFolder(syncFolderPath);

    // 2. Build local index
    onProgress?.('正在读取本地索引...');
    const localIndex = await this.buildLocalIndex(syncFolderPath);

    // 3. Fetch all recordings from backend
    onProgress?.('正在从服务器拉取录音列表...');
    let page = 1;
    let allRecordings: Recording[] = [];

    while (true) {
      try {
        const res = await this.api.fetchRecordingList(page, settings.pageSize);
        allRecordings = allRecordings.concat(res.list);
        if (allRecordings.length >= res.total || res.list.length === 0) break;
        page++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : '获取录音列表失败';
        result.errorMessages.push(msg);
        console.error('[SonicNote] 获取录音列表失败:', e);
        vscode.window.showErrorMessage(`同步失败: ${msg}`);
        return result;
      }
    }

    // Filter out deleted
    allRecordings = allRecordings.filter(r => r.delFlag !== '2');
    result.total = allRecordings.length;

    // 4. Process each recording
    for (let i = 0; i < allRecordings.length; i++) {
      const recording = allRecordings[i];
      onProgress?.(`正在同步 ${i + 1}/${result.total}: ${recording.recordNickName || recording.recordName}`);

      try {
        await this.processRecording(recording, localIndex, settings, syncFolderPath);
        result.synced++;
      } catch (e) {
        result.errors++;
        const msg = e instanceof Error ? e.message : '未知错误';
        const name = recording.recordNickName || recording.recordName;
        result.errorMessages.push(`${name}: ${msg}`);
        console.error(`[SonicNote] 同步失败 — ${name} (${recording.audioId}):`, e);
      }
    }

    // 5. Update last sync time via callback
    const now = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
    if (this.onSyncComplete) {
      await this.onSyncComplete(now);
    }

    return result;
  }

  private getWorkspaceFolder(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return undefined;
    return folders[0].uri.fsPath;
  }

  private async ensureFolder(folderPath: string): Promise<void> {
    try {
      await fs.mkdir(folderPath, { recursive: true });
    } catch {
      // folder already exists
    }
  }

  async buildLocalIndex(syncFolderPath: string): Promise<Map<string, LocalFileInfo>> {
    const index = new Map<string, LocalFileInfo>();

    let entries: string[];
    try {
      entries = await fs.readdir(syncFolderPath);
    } catch {
      return index;
    }

    for (const name of entries) {
      if (!name.endsWith('.md')) continue;

      try {
        const filePath = path.join(syncFolderPath, name);
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) continue;
        const content = await fs.readFile(filePath, 'utf-8');
        const audioId = this.extractFrontmatterField(content, 'audio_id');
        const syncTime = this.extractFrontmatterField(content, 'sync_time');
        if (audioId) {
          index.set(audioId.replace(/"/g, ''), { path: filePath, syncTime: syncTime || '' });
        }
      } catch {
        // Skip files that can't be read
      }
    }

    return index;
  }

  private extractFrontmatterField(content: string, field: string): string | null {
    const match = content.match(new RegExp(`^${field}:\\s*"?([^"]*)"\\s*$`, 'm'));
    return match ? match[1] : null;
  }

  private async processRecording(
    recording: Recording,
    localIndex: Map<string, LocalFileInfo>,
    settings: SonicNoteSettings,
    syncFolderPath: string
  ): Promise<void> {
    const syncTime = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');

    const local = localIndex.get(recording.audioId);

    // Already synced — check if file was named with original name but server now has a summarized title
    if (local && local.path) {
      const hasNewTitle = recording.recordNickName && recording.recordNickName !== recording.recordName;
      const localBaseName = path.basename(local.path).replace(/\.md$/, '') || '';
      const originalName = sanitizeFileName(recording.recordName || '');

      if (hasNewTitle && localBaseName === originalName) {
        // Overwrite content and rename to new title
        const content = await this.buildRecordingContent(recording, syncTime);
        const newFileName = formatFileName(recording);
        const newFilePath = path.join(syncFolderPath, `${newFileName}.md`);
        try {
          await fs.writeFile(local.path, content, 'utf-8');
          await fs.rename(local.path, newFilePath);
          localIndex.set(recording.audioId, { path: newFilePath, syncTime });
        } catch (e) {
          console.error(`[SonicNote] 文件重命名失败: ${local.path} -> ${newFilePath}`, e);
        }
      }
      return;
    }

    // New recording — create file
    const content = await this.buildRecordingContent(recording, syncTime);
    const fileName = formatFileName(recording);
    const filePath = path.join(syncFolderPath, `${fileName}.md`);
    await fs.writeFile(filePath, content, 'utf-8');
    localIndex.set(recording.audioId, { path: filePath, syncTime });
  }

  private async buildRecordingContent(recording: Recording, syncTime: string): Promise<string> {
    const settings = this.getSettings();

    // Fetch transcript if enabled and available (status 2 = completed)
    let transcript: TranscriptSegment[] | null = null;
    let summary: SummaryData | null = null;
    let studyReport: StudyReportData | null = null;
    let note = '';

    // Execute all requests in parallel
    const results = await Promise.allSettled([
      settings.includeTranscript && recording.transcriptStatus === 2
        ? this.api.fetchTranscriptResult(recording.audioId) : Promise.resolve(null),
      recording.summaryStatus === 2
        ? this.api.fetchSummary(recording.audioId) : Promise.resolve(null),
      this.api.fetchStudyReport(recording.audioId),
      this.api.fetchNote(recording.audioId),
    ]);

    const [transcriptResult, summaryResult, studyReportResult, noteResult] = results;

    if (transcriptResult.status === 'fulfilled' && transcriptResult.value !== null) {
      transcript = transcriptResult.value;
    }
    if (summaryResult.status === 'fulfilled' && summaryResult.value !== null) {
      summary = summaryResult.value;
    }
    if (studyReportResult.status === 'fulfilled' && studyReportResult.value !== null) {
      studyReport = studyReportResult.value;
    }
    if (noteResult.status === 'fulfilled') {
      note = noteResult.value as string || '';
    }

    return toMarkdown(recording, transcript, summary, studyReport, note, syncTime, settings);
  }
}
