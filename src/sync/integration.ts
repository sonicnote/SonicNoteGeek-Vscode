import * as vscode from 'vscode';
import * as path from 'path';
import { SonicNoteApiClient } from './api';
import { SyncService } from './sync';
import { SonicNoteSettings, DEFAULT_SETTINGS, CustomFrontmatterField } from './types';
import { SyncSidebarProvider } from './sidebar';
import { SyncSettingsPanel } from './settings-panel';

const STATE_KEYS = {
  token: 'sonicnote.token',
  apiKey: 'sonicnote.apiKey',
  lastSyncTime: 'sonicnote.lastSyncTime',
  frontmatterFields: 'sonicnote.frontmatterFields',
  customFrontmatter: 'sonicnote.customFrontmatter',
};

export function getSyncSettings(context: vscode.ExtensionContext): SonicNoteSettings {
  const config = vscode.workspace.getConfiguration('sonicnoteGeek.sync');
  return {
    serverUrl: config.get<string>('serverUrl', DEFAULT_SETTINGS.serverUrl),
    syncFolder: config.get<string>('syncFolder', '') || '',
    pageSize: config.get<number>('pageSize', DEFAULT_SETTINGS.pageSize),
    includeTranscript: config.get<boolean>('includeTranscript', DEFAULT_SETTINGS.includeTranscript),
    autoSyncOnOpen: config.get<boolean>('autoSyncOnOpen', DEFAULT_SETTINGS.autoSyncOnOpen),
    resyncIntervalMinutes: config.get<number>('resyncIntervalMinutes', DEFAULT_SETTINGS.resyncIntervalMinutes),
    frontmatterFields: context.globalState.get<Record<string, boolean>>(
      STATE_KEYS.frontmatterFields, DEFAULT_SETTINGS.frontmatterFields
    ),
    customFrontmatter: context.globalState.get<CustomFrontmatterField[]>(
      STATE_KEYS.customFrontmatter, DEFAULT_SETTINGS.customFrontmatter
    ),
    token: context.globalState.get<string>(STATE_KEYS.token, DEFAULT_SETTINGS.token),
    apiKey: context.globalState.get<string>(STATE_KEYS.apiKey, DEFAULT_SETTINGS.apiKey),
    lastSyncTime: context.globalState.get<string>(STATE_KEYS.lastSyncTime, DEFAULT_SETTINGS.lastSyncTime),
  };
}

export class SonicNoteSyncIntegration {
  public readonly sidebarProvider: SyncSidebarProvider;
  public onChanged?: () => void;
  private apiClient: SonicNoteApiClient;
  private syncService: SyncService;
  private syncing = false;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private getContext: () => vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.getContext = () => context;

    const getSettings = () => getSyncSettings(this.getContext());
    this.apiClient = new SonicNoteApiClient(getSettings);

    const setState = async (key: string, value: any) => {
      await context.globalState.update(key, value);
    };

    this.syncService = new SyncService(
      this.apiClient, getSettings,
      async (t: string) => { await setState(STATE_KEYS.lastSyncTime, t); },
    );

    this.sidebarProvider = new SyncSidebarProvider({
      getSyncFolder: () => getSyncSettings(this.getContext()).syncFolder,
      isAuthenticated: () => this.apiClient.isAuthenticated(),
    });
  }

  isAuthenticated(): boolean { return this.apiClient.isAuthenticated(); }
  getSyncFolder(): string { return getSyncSettings(this.getContext()).syncFolder; }

  registerCommands(context: vscode.ExtensionContext): void {
    // Sidebar webview
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider('sonicnote-geek.sidebar', this.sidebarProvider)
    );

    // Commands
    context.subscriptions.push(
      vscode.commands.registerCommand('sonicnote-geek.sync', () => this.triggerSync())
    );
    context.subscriptions.push(
      vscode.commands.registerCommand('sonicnote-geek.login', () => this.loginFlow())
    );
    context.subscriptions.push(
      vscode.commands.registerCommand('sonicnote-geek.logout', async () => {
        await context.globalState.update(STATE_KEYS.token, '');
        await context.globalState.update(STATE_KEYS.apiKey, '');
        vscode.window.showInformationMessage('已登出 SonicNote');
        this.sidebarProvider.refresh();
        if (this.onChanged) this.onChanged();
      })
    );
    context.subscriptions.push(
      vscode.commands.registerCommand('sonicnote-geek.openSyncSettings', () => this.openSettings())
    );

    // Watch config changes
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('sonicnoteGeek.sync')) {
          this.sidebarProvider.refresh();
          if (this.onChanged) this.onChanged();
          this.startAutoSync();
        }
      })
    );

    // Auto-sync on startup
    const settings = getSyncSettings(context);
    if (settings.autoSyncOnOpen && this.apiClient.isAuthenticated()) {
      setTimeout(() => this.triggerSync(), 5000);
    }
    this.startAutoSync();
  }

  dispose() {
    this.stopAutoSync();
  }

  private async loginFlow(): Promise<void> {
    const apiKey = await vscode.window.showInputBox({
      prompt: '请输入 SonicNote API Key',
      placeHolder: 'sk-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      password: true, ignoreFocusOut: true,
    });
    if (!apiKey) return;
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '正在登录 SonicNote...', cancellable: false },
        async () => this.apiClient.login(apiKey)
      );
      const ctx = this.getContext();
      await ctx.globalState.update(STATE_KEYS.token, result.token);
      await ctx.globalState.update(STATE_KEYS.apiKey, apiKey);
      vscode.window.showInformationMessage('登录成功');
      this.sidebarProvider.refresh();
      if (this.onChanged) this.onChanged();
      this.startAutoSync();
    } catch (e) {
      vscode.window.showErrorMessage(`登录失败: ${e instanceof Error ? e.message : '未知错误'}`);
    }
  }

  async triggerSync() {
    if (!this.apiClient.isAuthenticated()) {
      const action = await vscode.window.showWarningMessage('请先登录 SonicNote', '登录');
      if (action === '登录') { await this.loginFlow(); }
      return;
    }
    if (this.syncing) { vscode.window.showInformationMessage('同步已在进行中'); return; }
    this.syncing = true; this.stopAutoSync();

    try {
      const result = await this.syncService.syncAll((msg) => {
        // progress updates are logged but not displayed in status bar
        // (status bar is now handled by main extension via tree)
      });
      let message = `同步完成: ${result.synced} 条新/更新`;
      if (result.skipped > 0) message += `, ${result.skipped} 条跳过`;
      if (result.errors > 0) message += `, ${result.errors} 条失败`;
      vscode.window.showInformationMessage(message);
    } catch (e) {
      vscode.window.showErrorMessage(`同步失败: ${e instanceof Error ? e.message : '未知错误'}`);
    } finally {
      this.syncing = false;
      this.sidebarProvider.refresh();
      if (this.onChanged) this.onChanged();
      this.startAutoSync();
    }
  }

  private startAutoSync() {
    this.stopAutoSync();
    const s = getSyncSettings(this.getContext());
    if (s.resyncIntervalMinutes > 0 && this.apiClient.isAuthenticated()) {
      this.syncTimer = setInterval(() => this.triggerSync(), s.resyncIntervalMinutes * 60 * 1000);
    }
  }

  private stopAutoSync() {
    if (this.syncTimer !== null) { clearInterval(this.syncTimer); this.syncTimer = null; }
  }

  private openSettings() {
    const ctx = this.getContext();
    SyncSettingsPanel.createOrShow(
      () => getSyncSettings(ctx),
      async (key: string, value: any) => { await ctx.globalState.update(key, value); },
      () => {
        this.sidebarProvider.refresh();
        this.startAutoSync();
      },
      this.apiClient,
    );
  }
}
