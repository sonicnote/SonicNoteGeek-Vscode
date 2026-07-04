import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import type { TranscriptionTask, SonicNoteGeekSettings, TranscriptSegment, VoiceprintEntry } from "./types";
import { loadSettings, saveSettings, getActiveASRConfig, getActiveLLMConfig, getActiveASRModelName, getActiveLLMModelName } from "./settings";
import { AudioProcessor } from "./processor";
import { extractAudioLinks, findAudioAttachments } from "./utils/mp3-extractor";
import { getAllTemplateOptions, getTemplate } from "./templates";
import { generateOutput } from "./utils/output-generator";
import { SonicNoteSyncIntegration } from "./sync/integration";

let processor: AudioProcessor;
let transcribePanel: vscode.WebviewPanel | undefined;
let detectedMp3s: string[] = [];
let syncIntegration: SonicNoteSyncIntegration;

export function activate(context: vscode.ExtensionContext) {
  try {
    processor = new AudioProcessor();

    // Initialize SonicNote Sync integration (merged from SonicNoteSync-Vscode)
    syncIntegration = new SonicNoteSyncIntegration(context);
    syncIntegration.registerCommands(context);

    // Commands
    context.subscriptions.push(
      vscode.commands.registerCommand("sonicnote-geek.openPanel", () => {
        vscode.commands.executeCommand("workbench.view.extension.sonicnote-geek");
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("sonicnote-geek.newSession", async () => {
        await openTranscribePanel(context);
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("sonicnote-geek.openTranscribePanel", async () => {
        await openTranscribePanel(context);
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("sonicnote-geek.scanMp3", async () => {
        const editor = findMarkdownEditor();
        if (!editor || !editor.document.fileName.endsWith(".md")) {
          vscode.window.showWarningMessage("请先打开一个 Markdown 文件");
          return;
        }
        const text = editor.document.getText();
        const urls = extractAudioLinks(text);
        const files = await findAudioAttachments(editor.document.uri);
        const all = [...new Set([...urls, ...files])];

        if (all.length === 0) {
          vscode.window.showInformationMessage("当前 Markdown 文件中未找到 MP3 链接");
          return;
        }

        detectedMp3s = all;
        sendMp3Result(all);
        vscode.window.showInformationMessage(`找到 ${all.length} 个音频来源`);
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("sonicnote-geek.quickTranscribe", async () => {
        await quickTranscribe(context);
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("sonicnote-geek.openSettings", () => {
        vscode.commands.executeCommand("workbench.action.openSettings", "sonicnoteGeek");
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("sonicnote-geek.selectLocalDir", async () => {
        // Sync folder is configured via sync settings panel
        vscode.window.showInformationMessage("请在 妙记同步设置 中配置同步文件夹");
      }),
    );

    // Watch editor changes to auto-refresh
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document.fileName.endsWith(".md")) {
          syncIntegration.sidebarProvider.refresh();
          refreshAudioSources();
        }
      }),
    );

    // Clean up panel on dispose
    context.subscriptions.push({
      dispose: () => {
        if (transcribePanel) {
          transcribePanel.dispose();
          transcribePanel = undefined;
        }
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`SonicNoteGeek 激活失败: ${msg}`);
    console.error("SonicNoteGeek activation error:", err);
  }
}

async function quickTranscribe(context: vscode.ExtensionContext) {
  const editor = findMarkdownEditor();
  if (!editor || !editor.document.fileName.endsWith(".md")) {
    vscode.window.showWarningMessage("请先打开一个 Markdown 文件");
    return;
  }

  const text = editor.document.getText();
  const mp3Links = extractAudioLinks(text);
  if (mp3Links.length === 0) {
    vscode.window.showInformationMessage("当前 Markdown 文件中未找到 MP3 链接");
    return;
  }

  const s = loadSettings(context);
  const task: TranscriptionTask = {
    id: `quick-${Date.now()}`,
    mp3Urls: mp3Links,
    asrConfig: getActiveASRConfig(s),
    speakerConfig: s.speakerDiarization,
    llmConfig: getActiveLLMConfig(s),
    template: "business-meeting",
    hotWords: s.hotWords,
    voiceprintLibrary: s.voiceprintLibrary,
    createdAt: Date.now(),
  };

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "SonicNoteGeek 快速转写",
    cancellable: true,
  }, async (progress, token) => {
    token.onCancellationRequested(() => vscode.window.showWarningMessage("转写已取消"));
    const sourceTitle = path.basename(editor.document.fileName, ".md");

    try {
      processor.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
      const output = await processor.process(
        task, sourceTitle,
        (_, label) => progress.report({ message: label, increment: 25 }),
        getActiveASRModelName(s),
      );

      const notePath = editor.document.fileName.replace(/\.md$/, "-转写总结.md");
      await vscode.workspace.fs.writeFile(vscode.Uri.file(notePath), Buffer.from(output, "utf-8"));

      const openAction = await vscode.window.showInformationMessage(
        `转写完成！已保存至 ${path.basename(notePath)}`, "打开文件",
      );
      if (openAction === "打开文件") {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(notePath));
        await vscode.window.showTextDocument(doc);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`快速转写失败: ${msg}`);
    }
  });
}

export function deactivate() {
  processor = undefined as any;
  if (transcribePanel) {
    transcribePanel.dispose();
    transcribePanel = undefined;
  }
  if (syncIntegration) {
    syncIntegration.dispose();
  }
}

// ========== Panel Management ==========

function sendMp3Result(urls: string[], files?: string[], sourceFile?: string, downloadPaths?: string[], hasTranscript?: boolean, parsedTranscript?: TranscriptSegment[]) {
  transcribePanel?.webview.postMessage({
    type: "mp3Result",
    urls: urls || [],
    files: files || [],
    sourceFile: sourceFile || "",
    downloadPaths: downloadPaths || [],
    hasTranscript: !!hasTranscript,
    parsedTranscript: parsedTranscript || [],
  });
}

function findMarkdownEditor(): vscode.TextEditor | undefined {
  const active = vscode.window.activeTextEditor;
  if (active?.document.languageId === "markdown") return active;
  return vscode.window.visibleTextEditors.find(e => e.document.languageId === "markdown");
}

function refreshAudioSources() {
  const editor = findMarkdownEditor();
  if (!editor || !editor.document.fileName.endsWith(".md")) {
    const fname = editor ? path.basename(editor.document.fileName) : "";
    sendMp3Result([], [], fname);
    return;
  }
  const text = editor.document.getText();
  const urls = extractAudioLinks(text);
  const sourceFile = path.basename(editor.document.fileName);
  const sourceTitle = path.basename(editor.document.fileName, ".md");
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";

  // Check for already-downloaded local MP3 files
  const existingPaths: string[] = [];
  if (workspaceRoot) {
    const audioDir = path.join(workspaceRoot, sourceTitle + "_audio");
    try {
      if (fs.existsSync(audioDir)) {
        const files = fs.readdirSync(audioDir);
        for (const f of files) {
          if (f.endsWith(".mp3") || f.endsWith(".wav") || f.endsWith(".m4a")) {
            existingPaths.push(path.join(audioDir, f));
          }
        }
      }
    } catch {}
  }

  // Check if MD document has transcript text
  const hasTranscript = text.includes("## 转录原文") || text.includes("## 转录信息");
  const parsedTranscript = hasTranscript ? parseTranscriptFromMarkdown(text) : [];

  detectedMp3s = urls;
  // Send URLs immediately, then scan for attachments
  sendMp3Result(urls, [], sourceFile, existingPaths, hasTranscript, parsedTranscript);
  findAudioAttachments(editor.document.uri).then(files => {
    if (files.length > 0) {
      const all = [...new Set([...urls, ...files])];
      detectedMp3s = all;
      sendMp3Result(all, files, sourceFile, existingPaths, hasTranscript, parsedTranscript);
    }
  }).catch(() => {
    // Attachment scan failed — URLs already sent above
  });
}

function sendState(context: vscode.ExtensionContext) {
  if (!transcribePanel) return;
  const settings = loadSettings(context);
  const templateOptions = getAllTemplateOptions(settings.customTemplates);
  transcribePanel.webview.postMessage({
    type: "state",
    settings: {
      asr: settings.asr,
      speaker: settings.speakerDiarization,
      llm: settings.llm,
      asrModels: settings.asrModels,
      llmModels: settings.llmModels,
      activeAsrModelId: settings.activeAsrModelId,
      activeModelId: settings.activeModelId,
      hotWords: settings.hotWords,
      industry: settings.industry,
      voiceprintLibrary: settings.voiceprintLibrary,
      activeAsrModelName: getActiveASRModelName(settings),
      activeLLMModelName: getActiveLLMModelName(settings),
    },
    templates: templateOptions,
    customTemplates: settings.customTemplates || [],
  });
}

async function openTranscribePanel(context: vscode.ExtensionContext) {
  // Reuse existing panel if available
  if (transcribePanel) {
    transcribePanel.reveal(vscode.ViewColumn.Two);
    sendState(context);
    refreshAudioSources();
    return;
  }

  transcribePanel = vscode.window.createWebviewPanel(
    "sonicnote-geek.transcribePanel",
    "SonicNoteGeek 转写总结",
    { viewColumn: vscode.ViewColumn.Two, preserveFocus: false },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    },
  );

  transcribePanel.webview.html = getPanelHtml();

  transcribePanel.webview.onDidReceiveMessage(async (msg) => {
    try {
      await handlePanelMessage(msg, context);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      transcribePanel?.webview.postMessage({ type: "error", message: errorMsg });
    }
  });

  transcribePanel.onDidDispose(() => {
    transcribePanel = undefined;
  });

  sendState(context);
  refreshAudioSources();
}

async function handlePanelMessage(msg: any, context: vscode.ExtensionContext) {
  switch (msg.type) {
    case "refresh":
      sendState(context);
      refreshAudioSources();
      break;

    case "scanMp3":
      refreshAudioSources();
      break;

    case "startProcess":
      await runProcess(msg, context);
      break;

    case "saveOutput": {
      const editor = findMarkdownEditor();
      if (!editor) {
        vscode.window.showWarningMessage("请先打开一个 Markdown 文件");
        return;
      }
      const notePath = editor.document.fileName.replace(/\.md$/, "-转写总结.md");
      await vscode.workspace.fs.writeFile(vscode.Uri.file(notePath), Buffer.from(msg.content, "utf-8"));
      vscode.window.showInformationMessage(`已保存至 ${path.basename(notePath)}`);
      break;
    }

    case "saveSettings": {
      const currentSettings = loadSettings(context);
      if (msg.settings.asr) currentSettings.asr = { ...currentSettings.asr, ...msg.settings.asr };
      if (msg.settings.speaker) currentSettings.speakerDiarization = { ...currentSettings.speakerDiarization, ...msg.settings.speaker };
      if (msg.settings.llm) currentSettings.llm = { ...currentSettings.llm, ...msg.settings.llm };
      if (msg.settings.hotWords !== undefined) currentSettings.hotWords = msg.settings.hotWords;
      if (msg.settings.industry !== undefined) currentSettings.industry = msg.settings.industry;
      if (msg.settings.voiceprintLibrary !== undefined) currentSettings.voiceprintLibrary = msg.settings.voiceprintLibrary;
      await saveSettings(context, currentSettings);
      transcribePanel?.webview.postMessage({ type: "settingsSaved" });
      break;
    }

    case "addAsrModel": {
      const currentSettings = loadSettings(context);
      const model = msg.model;
      if (model && model.id) {
        if (!currentSettings.asrModels) currentSettings.asrModels = [];
        currentSettings.asrModels.push(model);
        if (!currentSettings.activeAsrModelId) currentSettings.activeAsrModelId = model.id;
        await saveSettings(context, currentSettings);
        sendState(context);
      }
      break;
    }

    case "updateAsrModel": {
      const currentSettings = loadSettings(context);
      const model = msg.model;
      if (model && model.id && currentSettings.asrModels) {
        const idx = currentSettings.asrModels.findIndex((m: any) => m.id === model.id);
        if (idx !== -1) {
          currentSettings.asrModels[idx] = { ...currentSettings.asrModels[idx], ...model };
        }
        await saveSettings(context, currentSettings);
        sendState(context);
      }
      break;
    }

    case "deleteAsrModel": {
      const currentSettings = loadSettings(context);
      const modelId = msg.modelId;
      if (modelId && currentSettings.asrModels) {
        currentSettings.asrModels = currentSettings.asrModels.filter((m: any) => m.id !== modelId);
        if (currentSettings.activeAsrModelId === modelId) {
          currentSettings.activeAsrModelId = currentSettings.asrModels[0]?.id || "";
        }
        await saveSettings(context, currentSettings);
        sendState(context);
      }
      break;
    }

    case "activateAsrModel": {
      const currentSettings = loadSettings(context);
      currentSettings.activeAsrModelId = msg.modelId || "";
      await saveSettings(context, currentSettings);
      break;
    }

    case "addLlmModel": {
      const currentSettings = loadSettings(context);
      const model = msg.model;
      if (model && model.id) {
        if (!currentSettings.llmModels) currentSettings.llmModels = [];
        currentSettings.llmModels.push(model);
        if (!currentSettings.activeModelId) currentSettings.activeModelId = model.id;
        await saveSettings(context, currentSettings);
        sendState(context);
      }
      break;
    }

    case "updateLlmModel": {
      const currentSettings = loadSettings(context);
      const model = msg.model;
      if (model && model.id && currentSettings.llmModels) {
        const idx = currentSettings.llmModels.findIndex((m: any) => m.id === model.id);
        if (idx !== -1) {
          currentSettings.llmModels[idx] = { ...currentSettings.llmModels[idx], ...model };
        }
        await saveSettings(context, currentSettings);
        sendState(context);
      }
      break;
    }

    case "deleteLlmModel": {
      const currentSettings = loadSettings(context);
      const modelId = msg.modelId;
      if (modelId && currentSettings.llmModels) {
        currentSettings.llmModels = currentSettings.llmModels.filter((m: any) => m.id !== modelId);
        if (currentSettings.activeModelId === modelId) {
          currentSettings.activeModelId = currentSettings.llmModels[0]?.id || "";
        }
        await saveSettings(context, currentSettings);
        sendState(context);
      }
      break;
    }

    case "activateLlmModel": {
      const currentSettings = loadSettings(context);
      currentSettings.activeModelId = msg.modelId || "";
      await saveSettings(context, currentSettings);
      break;
    }

    case "openHelp":
      vscode.env.openExternal(vscode.Uri.parse("https://sonicnote.com/docs"));
      break;

    case "cloudSync":
      vscode.window.showInformationMessage("云端同步功能即将上线，敬请期待！");
      break;

    case "retranscribe": {
      const currentSettings = loadSettings(context);
      const editor = findMarkdownEditor();
      const sourceTitle = editor ? path.basename(editor.document.fileName, ".md") : "未命名";
      processor.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
      transcribePanel?.webview.postMessage({ type: "processStarted" });
      try {
        const asrConfig = getActiveASRConfig(currentSettings);
        const speakerConfig = currentSettings.speakerDiarization;
        const mp3Urls = msg.mp3Urls || detectedMp3s;

        // Download MP3s for local/xunfei ASR
        transcribePanel?.webview.postMessage({ type: "processStatus", label: "音频下载中..." });
        const isCloudASR = !asrConfig.protocol.startsWith("local-") && asrConfig.protocol !== "xunfei";
        const downloadedPaths = await processor.downloadMp3s(mp3Urls, sourceTitle);

        // Run ASR + speaker diarization only (no LLM)
        transcribePanel?.webview.postMessage({ type: "processStatus", label: "语音转写中..." });
        const audioPaths = isCloudASR ? mp3Urls
          : (downloadedPaths.length > 0 ? downloadedPaths : mp3Urls);
        const transcript = await processor.transcribeOnly(
          audioPaths, asrConfig, speakerConfig,
          currentSettings.voiceprintLibrary, currentSettings.hotWords,
        );

        // Build transcript-only output
        const asrName = getActiveASRModelName(currentSettings);
        const date = new Date().toISOString().split("T")[0];
        const transcriptOutput = buildTranscriptSection(transcript, asrName, currentSettings.asr.language || "zh", date, msg.templateType || "general");

        // Replace transcript section in MD file
        if (editor && editor.document.languageId === "markdown") {
          await replaceTranscriptInMarkdown(editor, transcriptOutput);
        }

        transcribePanel?.webview.postMessage({
          type: "processComplete",
          output: transcriptOutput,
          transcript: transcript.map(s => ({ startTime: s.startTime, speaker: s.speaker || "未知", text: s.text })),
        });

        transcribePanel?.webview.postMessage({
          type: "downloadPaths",
          paths: downloadedPaths,
          errors: processor.lastDownloadErrors,
        });
      } catch (err) {
        transcribePanel?.webview.postMessage({ type: "processError", message: err instanceof Error ? err.message : String(err) });
      }
      break;
    }

    case "resummarize": {
      const currentSettings = loadSettings(context);
      const editor = findMarkdownEditor();
      const sourceTitle = editor ? path.basename(editor.document.fileName, ".md") : "未命名";
      transcribePanel?.webview.postMessage({ type: "processStarted" });
      try {
        let lastSegments = processor.lastTranscript;
        // Fallback: parse transcript from MD document
        if (lastSegments.length === 0 && editor) {
          lastSegments = parseTranscriptFromMarkdown(editor.document.getText());
        }
        if (lastSegments.length === 0) {
          transcribePanel?.webview.postMessage({ type: "processError", message: "没有可用的转录文本，请先进行转写" });
          break;
        }
        const templateType = msg.templateType || "general";
        const llmConfig = getActiveLLMConfig(currentSettings);
        const { summary, keywords, actionItems } = await processor.summarizeOnly(
          lastSegments, llmConfig, templateType, msg.customPrompt || "",
        );
        const template = getTemplate(templateType);
        if (!template) throw new Error("未找到指定的总结模板");
        const result = {
          taskId: "", transcript: lastSegments, summary, keywords, actionItems,
          duration: processor.calcDuration(lastSegments),
          language: currentSettings.asr.language || "zh",
          speakerCount: new Set(lastSegments.map(s => s.speaker)).size,
        };
        const asrName = getActiveASRModelName(currentSettings);
        const output = generateOutput(result, template, sourceTitle, asrName);

        // Extract summary text (everything before ## 转录信息)
        const transcriptHeaderIdx = output.indexOf("\n## 转录信息\n");
        const summaryText = transcriptHeaderIdx !== -1
          ? output.substring(0, transcriptHeaderIdx).trim()
          : output;

        // Append summary after YAML frontmatter in MD file
        if (editor && editor.document.languageId === "markdown") {
          await appendSummaryToMarkdown(editor, summaryText);
        }

        transcribePanel?.webview.postMessage({
          type: "processComplete",
          output,
          transcript: lastSegments.map(s => ({ startTime: s.startTime, speaker: s.speaker || "未知", text: s.text })),
        });
      } catch (err) {
        transcribePanel?.webview.postMessage({ type: "processError", message: err instanceof Error ? err.message : String(err) });
      }
      break;
    }

    case "voicefixMatch": {
      try {
        const currentSettings = loadSettings(context);
        const sd = currentSettings.speakerDiarization;
        if (!sd.customEndpoint) {
          transcribePanel?.webview.postMessage({ type: "voicefixError", message: "请先在声纹识别设置中配置服务地址" });
          break;
        }
        const voiceprintLibrary = currentSettings.voiceprintLibrary || [];
        if (voiceprintLibrary.length === 0 || !voiceprintLibrary.some(v => v.audioSamplePath)) {
          transcribePanel?.webview.postMessage({ type: "voicefixError", message: "声纹库中没有带音频样本的说话人，请先添加声纹样本" });
          break;
        }

        const editor = findMarkdownEditor();
        if (!editor) {
          transcribePanel?.webview.postMessage({ type: "voicefixError", message: "请先打开一个包含逐字稿的 Markdown 文件" });
          break;
        }

        const text = editor.document.getText();
        const segments = parseTranscriptFromMarkdown(text);
        if (segments.length === 0) {
          transcribePanel?.webview.postMessage({ type: "voicefixError", message: "未在文档中找到逐字稿内容（## 转录原文）" });
          break;
        }

        // Find audio file
        const sourceTitle = path.basename(editor.document.fileName, ".md");
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
        let audioFile = "";
        const yamlMatch = text.match(/audio_url[：:]\s*["']?([^"'\s]+)["']?/);
        if (yamlMatch) { const au = yamlMatch[1]; if (!au.startsWith("http") && fs.existsSync(au)) audioFile = au; }
        if (!audioFile && processor.lastDownloadedPaths.length > 0) {
          audioFile = processor.lastDownloadedPaths.find(p => fs.existsSync(p)) || "";
        }
        if (!audioFile && workspaceRoot) {
          const audioDir = path.join(workspaceRoot, sourceTitle + "_audio");
          try { if (fs.existsSync(audioDir)) { const files = fs.readdirSync(audioDir); const af = files.find(f => /\.(mp3|m4a|wav|flac|ogg)$/i.test(f)); if (af) audioFile = path.join(audioDir, af); } } catch {}
        }
        if (!audioFile) {
          try { const attachments = await findAudioAttachments(editor.document.uri); if (attachments.length > 0) audioFile = attachments[0]; } catch {}
        }
        if (!audioFile) {
          transcribePanel?.webview.postMessage({ type: "voicefixError", message: "未找到关联的音频文件" });
          break;
        }

        // Build speaker segments
        const speakerGroups = new Map<string, { starts: number[]; ends: number[] }>();
        for (const seg of segments) {
          const spk = seg.speaker || "unknown";
          if (!speakerGroups.has(spk)) speakerGroups.set(spk, { starts: [], ends: [] });
          const g = speakerGroups.get(spk)!;
          g.starts.push(processor.parseTimestamp(seg.startTime));
          const endSec = processor.parseTimestamp(seg.startTime) + Math.max(1, seg.text.length / 3);
          g.ends.push(endSec);
        }
        const speakerSegments = Array.from(speakerGroups.entries()).map(([id, g]) => ({
          speaker_id: id, starts: g.starts, ends: g.ends,
        }));

        // Call voiceprint matching
        const labels = await processor.matchVoiceprints(
          audioFile, speakerSegments, voiceprintLibrary, sd.customEndpoint, sd.apiKey,
        );

        // Count matched speakers
        const matched = Object.entries(labels).filter(([, name]) => name && name !== "未知说话人");
        if (matched.length === 0) {
          transcribePanel?.webview.postMessage({ type: "voicefixError", message: "未能匹配到任何说话人，请检查声纹样本质量和音频文件" });
          break;
        }

        // Replace speaker labels in the MD document
        let updatedText = text;
        for (const [oldName, newName] of Object.entries(labels)) {
          if (newName && newName !== "未知说话人" && newName !== oldName) {
            const regex = new RegExp(`(\\*\\*\\[[\\d:.]+\\]\\s*)${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([：:])`, 'g');
            updatedText = updatedText.replace(regex, `$1${newName}$2`);
          }
        }

        // Apply edit to editor
        const fullRange = new vscode.Range(
          editor.document.positionAt(0),
          editor.document.positionAt(text.length),
        );
        await editor.edit(editBuilder => {
          editBuilder.replace(fullRange, updatedText);
        });

        // Update lastTranscript
        const updatedTranscript = segments.map(s => ({
          ...s,
          speaker: labels[s.speaker] && labels[s.speaker] !== "未知说话人" ? labels[s.speaker] : s.speaker,
        }));
        processor.lastTranscript = updatedTranscript;

        const matchList = matched.map(([old, name]) => `${old} → ${name}`).join("、");
        transcribePanel?.webview.postMessage({ type: "voicefixResult", labels, matched, matchList, transcript: updatedTranscript });
        vscode.window.showInformationMessage(`人声勘正完成：${matchList}`);
      } catch (err) {
        transcribePanel?.webview.postMessage({ type: "voicefixError", message: err instanceof Error ? err.message : String(err) });
      }
      break;
    }

    case "extractVoiceprint":
      vscode.commands.executeCommand("sonicnote-geek.extractVoiceprint");
      break;

    case "chatAsk": {
      const currentSettings = loadSettings(context);
      const llmConfig = getActiveLLMConfig(currentSettings);
      const question = msg.question || "";
      const transcriptText = (msg.transcript || []).map((s: any) => `[${s.startTime}] ${s.speaker || "未知"}：${s.text}`).join("\n\n");
      const outputContext = msg.output || "";
      const history = msg.history || [];

      // Also read the active MD file content for additional context
      const mdEditor = findMarkdownEditor();
      let mdContent = "";
      if (mdEditor) {
        mdContent = mdEditor.document.getText();
      }

      try {
        const systemPrompt = `你是 AI 小录，一个智能助手，帮助用户分析会议/访谈转录内容。请根据提供的转录文本、总结内容和 Markdown 文档内容回答用户的问题。回答要简洁、准确、有条理。如果提供的内容中没有相关信息，请如实告知。`;
        let historyText = "";
        if (history.length > 0) {
          historyText = "\n\n---对话历史---\n" + history.map((h: any) => `${h.role === 'user' ? '用户' : 'AI 小录'}：${h.content}`).join("\n");
        }
        let mdSection = "";
        if (mdContent) {
          mdSection = `\n\n---当前 Markdown 文档内容---\n${mdContent}`;
        }
        const userPrompt = `以下是转录内容和总结：\n\n---转录原文---\n${transcriptText || "暂无"}\n\n---总结内容---\n${outputContext || "暂无"}${mdSection}${historyText}\n\n用户问题：${question}`;
        const answer = await processor.callLLM(llmConfig, systemPrompt, userPrompt);
        transcribePanel?.webview.postMessage({ type: "chatReply", answer });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        transcribePanel?.webview.postMessage({ type: "chatReply", answer: `抱歉，AI 小录暂时无法回答。

错误信息：${errMsg}`, error: true });
      }
      break;
    }

    case "saveVoiceprint": {
      const currentSettings = loadSettings(context);
      if (!currentSettings.voiceprintLibrary) currentSettings.voiceprintLibrary = [];
      const entry: VoiceprintEntry = {
        id: `vp_${Date.now()}`,
        name: msg.name || msg.speaker || "未命名",
        audioSamplePath: msg.audioSamplePath || "",
        description: msg.description || msg.sampleText || "",
      };
      currentSettings.voiceprintLibrary.push(entry);
      await saveSettings(context, currentSettings);
      vscode.window.showInformationMessage(`声纹样本 "${entry.name}" 已保存到声纹库`);
      transcribePanel?.webview.postMessage({ type: "vpSaved", entry });
      break;
    }

    case "voiceprintExtract": {
      try {
        const editor = findMarkdownEditor();
        if (!editor) {
          transcribePanel?.webview.postMessage({ type: "voiceprintExtractError", message: "请先打开一个包含逐字稿的 Markdown 文件" });
          break;
        }
        const text = editor.document.getText();
        const segments = parseTranscriptFromMarkdown(text);
        if (segments.length === 0) {
          transcribePanel?.webview.postMessage({ type: "voiceprintExtractError", message: "未在文档中找到逐字稿内容（## 转录原文）" });
          break;
        }

        // Find audio file
        const sourceTitle = path.basename(editor.document.fileName, ".md");
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
        let audioFile = "";

        // 1. Check audio_url from YAML (local file)
        const yamlMatch = text.match(/audio_url[：:]\s*["']?([^"'\s]+)["']?/);
        if (yamlMatch) {
          const au = yamlMatch[1];
          if (!au.startsWith("http") && fs.existsSync(au)) audioFile = au;
        }

        // 2. Check downloaded paths
        if (!audioFile && processor.lastDownloadedPaths.length > 0) {
          audioFile = processor.lastDownloadedPaths.find(p => fs.existsSync(p)) || "";
        }

        // 3. Check <sourceTitle>_audio/ directory
        if (!audioFile && workspaceRoot) {
          const audioDir = path.join(workspaceRoot, sourceTitle + "_audio");
          try {
            if (fs.existsSync(audioDir)) {
              const files = fs.readdirSync(audioDir);
              const audioFile_1 = files.find(f => /\.(mp3|m4a|wav|flac|ogg)$/i.test(f));
              if (audioFile_1) audioFile = path.join(audioDir, audioFile_1);
            }
          } catch {}
        }

        // 4. Check attachments in same directory
        if (!audioFile) {
          try {
            const attachments = await findAudioAttachments(editor.document.uri);
            if (attachments.length > 0) audioFile = attachments[0];
          } catch {}
        }

        if (!audioFile) {
          transcribePanel?.webview.postMessage({ type: "voiceprintExtractError", message: "未找到关联的音频文件。请确保 audio_url 指向有效路径，或先完成音频下载" });
          break;
        }

        // Group segments by speaker and calculate timestamps
        const speakerSegments = new Map<string, Array<{ startSec: number; text: string }>>();
        for (const seg of segments) {
          const startSec = processor.parseTimestamp(seg.startTime);
          if (!speakerSegments.has(seg.speaker)) speakerSegments.set(seg.speaker, []);
          speakerSegments.get(seg.speaker)!.push({ startSec, text: seg.text });
        }

        // Extract voiceprint samples
        const outputDir = workspaceRoot ? path.join(workspaceRoot, sourceTitle + "_audio", "voiceprints") : path.join(require("os").tmpdir(), "voiceprint_" + Date.now());
        const results = await processor.extractVoiceprintSamples(audioFile, speakerSegments, outputDir);
        transcribePanel?.webview.postMessage({ type: "voiceprintExtractResult", speakers: results });
      } catch (err) {
        transcribePanel?.webview.postMessage({ type: "voiceprintExtractError", message: err instanceof Error ? err.message : String(err) });
      }
      break;
    }

    case "voiceprintSaveSamples": {
      const currentSettings = loadSettings(context);
      if (!currentSettings.voiceprintLibrary) currentSettings.voiceprintLibrary = [];
      const samples: Array<{ displayName: string; audioSamplePath: string; description?: string }> = msg.samples || [];

      // Copy temp WAV files to persistent location
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
      const editor = findMarkdownEditor();
      const sourceTitle = editor ? path.basename(editor.document.fileName, ".md") : "unknown";
      const vpDir = workspaceRoot ? path.join(workspaceRoot, sourceTitle + "_audio", "voiceprints") : "";

      for (const sample of samples) {
        let persistedPath = sample.audioSamplePath;
        if (vpDir && sample.audioSamplePath) {
          try {
            if (!fs.existsSync(vpDir)) fs.mkdirSync(vpDir, { recursive: true });
            const destName = path.basename(sample.audioSamplePath);
            const destPath = path.join(vpDir, destName);
            if (sample.audioSamplePath !== destPath) {
              fs.copyFileSync(sample.audioSamplePath, destPath);
            }
            persistedPath = destPath;
          } catch (e) {
            console.warn("复制声纹文件失败:", e);
          }
        }
        currentSettings.voiceprintLibrary.push({
          id: `vp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name: sample.displayName || "未命名",
          audioSamplePath: persistedPath,
          description: sample.description || "",
        });
      }

      await saveSettings(context, currentSettings);

      // Optional: enroll with CAM++ service
      const sd = currentSettings.speakerDiarization;
      if (sd.customEndpoint) {
        let enrolled = 0;
        for (const vp of currentSettings.voiceprintLibrary.slice(-samples.length)) {
          if (vp.audioSamplePath) {
            const ok = await processor.enrollVoiceprint(sd.customEndpoint, vp.name, vp.audioSamplePath, sd.apiKey);
            if (ok) enrolled++;
          }
        }
        if (enrolled > 0) {
          transcribePanel?.webview.postMessage({ type: "voiceprintExtractResult", speakers: [] });
        }
      }

      transcribePanel?.webview.postMessage({ type: "vpSamplesSaved", count: samples.length });
      vscode.window.showInformationMessage(`${samples.length} 个声纹样本已保存到声纹库`);
      sendState(context);
      break;
    }

    case "getAudioData": {
      if (msg.path && fs.existsSync(msg.path)) {
        try {
          const data = fs.readFileSync(msg.path);
          const base64 = data.toString("base64");
          transcribePanel?.webview.postMessage({ type: "audioData", path: msg.path, data: base64, speakerIdx: msg.speakerIdx, source: msg.source });
        } catch {
          transcribePanel?.webview.postMessage({ type: "audioData", path: msg.path, data: "", error: "读取文件失败", speakerIdx: msg.speakerIdx, source: msg.source });
        }
      } else {
        transcribePanel?.webview.postMessage({ type: "audioData", path: msg.path, data: "", error: "文件不存在", speakerIdx: msg.speakerIdx, source: msg.source });
      }
      break;
    }

    case "updateCustomTemplate": {
      const currentSettings = loadSettings(context);
      if (currentSettings.customTemplates) {
        const idx = currentSettings.customTemplates.findIndex(
          (t: any) => t.name === msg.oldName
        );
        if (idx !== -1) {
          currentSettings.customTemplates[idx] = {
            type: "custom",
            name: msg.template.name || "自定义模板",
            description: msg.template.description || "",
            systemPrompt: msg.template.systemPrompt || "",
            outputFormat: "",
          };
        }
        await saveSettings(context, currentSettings);
        sendState(context);
      }
      break;
    }
    case "testVoiceprintService": {
      const { endpoint, apiKey } = msg;
      const httpGet = (url: string, timeout = 8000): Promise<{ status: number; data: string }> =>
        new Promise((resolve, reject) => {
          const u = new URL(url);
          const mod = u.protocol === "https:" ? require("https") : require("http");
          const opts = { hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search, method: "GET", timeout, headers: apiKey ? { "Authorization": `Bearer ${apiKey}` } : {} };
          const req = mod.request(opts, (res: any) => {
            let body = ""; res.on("data", (d: string) => body += d);
            res.on("end", () => resolve({ status: res.statusCode || 0, data: body }));
          });
          req.on("error", (e: Error) => reject(e));
          req.on("timeout", () => { req.destroy(); reject(new Error("请求超时")); });
          req.end();
        });
      let result = "";
      try {
        const baseUrl = endpoint.replace(/\/$/, "");
        const { status, data } = await httpGet(baseUrl + "/v1/speaker/list");
        if (status >= 200 && status < 300) {
          const json = JSON.parse(data);
          const names = json.speakers || [];
          result = `✅ 服务连接成功！已注册 ${names.length} 个说话人：${names.join("、") || "(无)"}`;
        } else {
          result = `⚠️ 服务返回错误 (HTTP ${status})`;
        }
      } catch (err) {
        result = `❌ 无法连接服务: ${err instanceof Error ? err.message : String(err)}`;
      }
      transcribePanel?.webview.postMessage({ type: "vpTestResult", result });
      break;
    }

    case "openUrl": {
      vscode.env.openExternal(vscode.Uri.parse(msg.url));
      break;
    }

    case "getVoiceprintGuide": {
      try {
        const guidePath = path.join(context.extensionPath, "voiceprint-api-guide.md");
        let content = "";
        if (fs.existsSync(guidePath)) {
          content = fs.readFileSync(guidePath, "utf-8");
        } else {
          content = fs.readFileSync("/Users/mac/Desktop/声纹识别接入标准.md", "utf-8");
        }
        transcribePanel?.webview.postMessage({ type: "voiceprintGuideContent", content });
      } catch (err) {
        transcribePanel?.webview.postMessage({ type: "voiceprintGuideContent", content: "", error: String(err) });
      }
      break;
    }

    case "saveVoiceprintGuide": {
      try {
        const destPath = "/Users/mac/Downloads/voiceprint-api-guide.md";
        const guidePath = path.join(context.extensionPath, "voiceprint-api-guide.md");
        let content = "";
        if (fs.existsSync(guidePath)) {
          content = fs.readFileSync(guidePath, "utf-8");
        } else {
          content = fs.readFileSync("/Users/mac/Desktop/声纹识别接入标准.md", "utf-8");
        }
        fs.writeFileSync(destPath, content, "utf-8");
        vscode.window.showInformationMessage(`文档已保存到 ${destPath}`);
        transcribePanel?.webview.postMessage({ type: "voiceprintGuideSaved", path: destPath });
      } catch (err) {
        vscode.window.showErrorMessage(`保存失败: ${err}`);
      }
      break;
    }

    case "getAsrGuide": {
      try {
        const guidePath = path.join(context.extensionPath, "openai-asr-guide.md");
        let content = "";
        if (fs.existsSync(guidePath)) {
          content = fs.readFileSync(guidePath, "utf-8");
        } else {
          content = fs.readFileSync("/Users/mac/Downloads/openai-whisper_asr_guide.md", "utf-8");
        }
        transcribePanel?.webview.postMessage({ type: "asrGuideContent", content });
      } catch (err) {
        transcribePanel?.webview.postMessage({ type: "asrGuideContent", content: "", error: String(err) });
      }
      break;
    }

    case "saveAsrGuide": {
      try {
        const destPath = "/Users/mac/Downloads/openai-whisper_asr_guide.md";
        const guidePath = path.join(context.extensionPath, "openai-asr-guide.md");
        let content = "";
        if (fs.existsSync(guidePath)) {
          content = fs.readFileSync(guidePath, "utf-8");
        } else {
          content = fs.readFileSync("/Users/mac/Downloads/openai-whisper_asr_guide.md", "utf-8");
        }
        fs.writeFileSync(destPath, content, "utf-8");
        vscode.window.showInformationMessage(`文档已保存到 ${destPath}`);
        transcribePanel?.webview.postMessage({ type: "asrGuideSaved", path: destPath });
      } catch (err) {
        vscode.window.showErrorMessage(`保存失败: ${err}`);
      }
      break;
    }

    case "playAudio": {
      if (msg.path) {
        try {
          const audioUri = vscode.Uri.file(msg.path);
          await vscode.commands.executeCommand("vscode.open", audioUri);
        } catch {
          // fallback: try opening in browser
          try { await vscode.env.openExternal(vscode.Uri.file(msg.path)); } catch {}
        }
      }
      break;
    }

    case "selectVoiceprintAudio": {
      const idx = msg.idx;
      try {
        const files = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { '音频文件': ['wav', 'mp3', 'm4a', 'flac'] },
          title: '选择声纹样本音频 (5-20秒)',
        });
        if (!files || files.length === 0) break;

        const selectedPath = files[0].fsPath;
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";

        // Validate duration with ffprobe (5-20 seconds)
        let durationSec = 0;
        try {
          const { execSync } = require("child_process");
          const out = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${selectedPath}"`, { stdio: "pipe", timeout: 10000 }).toString().trim();
          durationSec = parseFloat(out) || 0;
        } catch {
          transcribePanel?.webview.postMessage({ type: "voiceprintAudioError", idx, message: "无法读取音频时长，请确认文件格式正确" });
          break;
        }

        if (durationSec < 5) {
          transcribePanel?.webview.postMessage({ type: "voiceprintAudioError", idx, message: `音频时长 ${durationSec.toFixed(1)}s 不足5秒，请选择5-20秒的音频` });
          break;
        }
        if (durationSec > 20) {
          transcribePanel?.webview.postMessage({ type: "voiceprintAudioError", idx, message: `音频时长 ${durationSec.toFixed(1)}s 超过20秒，请选择5-20秒的音频` });
          break;
        }

        // Copy to voiceprints directory
        const vpDir = workspaceRoot ? path.join(workspaceRoot, "voiceprints") : path.join(require("os").homedir(), "voiceprints");
        if (!fs.existsSync(vpDir)) fs.mkdirSync(vpDir, { recursive: true });
        const ext = path.extname(selectedPath);
        const destName = `vp_${Date.now()}_${path.basename(selectedPath, ext).replace(/[^a-zA-Z0-9一-龥_-]/g, "_")}${ext}`;
        const destPath = path.join(vpDir, destName);
        fs.copyFileSync(selectedPath, destPath);

        transcribePanel?.webview.postMessage({ type: "voiceprintAudioSelected", idx, path: destPath, duration: durationSec });
      } catch (err) {
        transcribePanel?.webview.postMessage({ type: "voiceprintAudioError", idx, message: err instanceof Error ? err.message : String(err) });
      }
      break;
    }

    case "deleteCustomTemplate": {
      const currentSettings = loadSettings(context);
      if (currentSettings.customTemplates) {
        currentSettings.customTemplates = currentSettings.customTemplates.filter(
          (t: any) => t.name !== msg.templateName
        );
        await saveSettings(context, currentSettings);
        sendState(context);
      }
      break;
    }
    case "addCustomTemplate": {
      const currentSettings = loadSettings(context);
      if (!currentSettings.customTemplates) currentSettings.customTemplates = [];
      currentSettings.customTemplates.push({
        type: "custom",
        name: msg.template.name || "自定义模板",
        description: msg.template.description || "",
        systemPrompt: msg.template.systemPrompt || "",
        outputFormat: "",
      });
      await saveSettings(context, currentSettings);
      sendState(context);
      break;
    }
  }
}

async function runProcess(msg: any, context: vscode.ExtensionContext) {
  const settings = loadSettings(context);

  const task: TranscriptionTask = {
    id: `task-${Date.now()}`,
    mp3Urls: msg.mp3Urls || detectedMp3s,
    asrConfig: getActiveASRConfig(settings),
    speakerConfig: settings.speakerDiarization,
    llmConfig: getActiveLLMConfig(settings),
    template: msg.templateType || "general",
    customPrompt: msg.customPrompt || "",
    hotWords: settings.hotWords,
    voiceprintLibrary: settings.voiceprintLibrary,
    createdAt: Date.now(),
  };

  transcribePanel?.webview.postMessage({ type: "processStarted" });

  const editor = findMarkdownEditor();
  const sourceTitle = editor ? path.basename(editor.document.fileName, ".md") : "未命名";
  processor.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";

  try {
    const asrName = getActiveASRModelName(settings);
    const output = await processor.process(
      task, sourceTitle,
      (stageIndex, label) => {
        transcribePanel?.webview.postMessage({ type: "processProgress", stageIndex, label });
      },
      asrName,
    );

    const transcript = processor.lastTranscript.map(s => ({
      startTime: s.startTime,
      speaker: s.speaker || "未知",
      text: s.text,
    }));

    // Send download paths to webview for display under audio sources
    transcribePanel?.webview.postMessage({
      type: "downloadPaths",
      paths: processor.lastDownloadedPaths,
      errors: processor.lastDownloadErrors,
    });

    // Write summary after YAML frontmatter, transcript at end of active MD file
    if (editor && editor.document.languageId === "markdown") {
      await appendToMarkdown(editor, output, transcript, asrName, task.template);
    }

    transcribePanel?.webview.postMessage({ type: "processComplete", output, transcript });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    transcribePanel?.webview.postMessage({ type: "processError", message: errorMsg });
  }
}

async function appendToMarkdown(
  editor: vscode.TextEditor,
  fullOutput: string,
  transcript: Array<{ startTime: string; speaker: string; text: string }>,
  asrName: string,
  templateType: string,
): Promise<void> {
  const doc = editor.document;
  let content = doc.getText();

  // Extract summary text (everything before the transcript section)
  const transcriptHeaderIndex = fullOutput.indexOf("\n## 转录信息\n");
  let summaryText = "";
  let transcriptSection = "";
  if (transcriptHeaderIndex !== -1) {
    summaryText = fullOutput.substring(0, transcriptHeaderIndex).trim();
    transcriptSection = fullOutput.substring(transcriptHeaderIndex);
  } else {
    const altIndex = fullOutput.indexOf("\n## 转录原文\n");
    if (altIndex !== -1) {
      summaryText = fullOutput.substring(0, altIndex).trim();
      transcriptSection = fullOutput.substring(altIndex);
    } else {
      summaryText = fullOutput;
    }
  }

  // Remove existing transcript section(s) from the document
  const transcriptStartMarkers = ["\n## 转录信息\n", "\n## 转录原文\n", "\n## 转录总结\n"];
  for (const marker of transcriptStartMarkers) {
    const idx = content.indexOf(marker);
    if (idx !== -1) {
      let cutIdx = idx;
      const before = content.substring(Math.max(0, cutIdx - 5), cutIdx);
      if (before === "\n---\n") {
        cutIdx = cutIdx - 5;
      }
      content = content.substring(0, cutIdx).trimEnd();
      break;
    }
  }

  // Append summary after YAML frontmatter (after the closing ---)
  const frontmatterEnd = findYamlFrontmatterEnd(content);
  if (frontmatterEnd !== -1 && summaryText) {
    const before = content.substring(0, frontmatterEnd);
    const after = content.substring(frontmatterEnd).trimStart();
    content = before + "\n" + summaryText + "\n" + after;
  } else if (summaryText) {
    content = summaryText + "\n\n" + content;
  }

  // Append transcript section at the end
  if (transcriptSection) {
    content = content.trimEnd() + "\n\n" + transcriptSection.trimStart();
  }

  // Write via editor.edit (reliable for active editor)
  const finalContent = content;
  await editor.edit(editBuilder => {
    const fullRange = new vscode.Range(
      doc.positionAt(0),
      doc.positionAt(doc.getText().length),
    );
    editBuilder.replace(fullRange, finalContent);
  });
}

function findYamlFrontmatterEnd(content: string): number {
  if (!content.startsWith("---")) return -1;
  const idx = content.indexOf("\n---\n", 3);
  if (idx !== -1) return idx + 4;
  const idx2 = content.indexOf("\n---\r\n", 3);
  if (idx2 !== -1) return idx2 + 5;
  return -1;
}

// Build transcript section output (without summary)
function buildTranscriptSection(
  transcript: TranscriptSegment[],
  asrName: string, language: string, date: string, templateName: string,
): string {
  const speakerCount = new Set(transcript.map(s => s.speaker)).size;
  const duration = transcript.length > 0
    ? processor.calcDuration(transcript)
    : 0;
  let out = "";
  out += "---\n\n";
  out += "## 转录信息\n\n";
  out += `- **时长**：${formatDurationStr(duration)}\n`;
  out += `- **语言**：${language}\n`;
  out += `- **ASR 引擎**：${asrName}\n`;
  out += `- **说话人数**：${speakerCount}\n`;
  out += `- **生成模板**：${templateName}\n`;
  out += `- **生成时间**：${date}\n`;
  out += "\n---\n\n";
  out += "## 转录原文\n\n";
  for (const seg of transcript) {
    const startFull = seg.startTime.length <= 5 ? `00:${seg.startTime}` : seg.startTime;
    out += `**[${startFull}] ${seg.speaker || "未知"}：** ${seg.text}\n\n`;
  }
  return out;
}

function formatDurationStr(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}时${m}分${s}秒`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

// Replace only the transcript section in the MD file
async function replaceTranscriptInMarkdown(
  editor: vscode.TextEditor,
  newTranscriptSection: string,
): Promise<void> {
  const doc = editor.document;
  let content = doc.getText();

  // Remove existing transcript section(s)
  const transcriptStartMarkers = ["\n## 转录信息\n", "\n## 转录原文\n"];
  for (const marker of transcriptStartMarkers) {
    const idx = content.indexOf(marker);
    if (idx !== -1) {
      content = content.substring(0, idx).trimEnd();
      break;
    }
  }

  // Append new transcript section at the end
  content = content.trimEnd() + "\n\n" + newTranscriptSection.trimStart();

  await editor.edit(editBuilder => {
    const fullRange = new vscode.Range(
      doc.positionAt(0),
      doc.positionAt(doc.getText().length),
    );
    editBuilder.replace(fullRange, content);
  });
}

// Append new summary after YAML frontmatter, keeping existing content
async function appendSummaryToMarkdown(
  editor: vscode.TextEditor,
  summaryText: string,
): Promise<void> {
  const doc = editor.document;
  let content = doc.getText();

  const frontmatterEnd = findYamlFrontmatterEnd(content);

  if (frontmatterEnd !== -1) {
    const before = content.substring(0, frontmatterEnd);
    const after = content.substring(frontmatterEnd);
    content = before + "\n" + summaryText + "\n" + after;
  } else {
    content = summaryText + "\n\n" + content;
  }

  await editor.edit(editBuilder => {
    const fullRange = new vscode.Range(
      doc.positionAt(0),
      doc.positionAt(doc.getText().length),
    );
    editBuilder.replace(fullRange, content);
  });
}

// Extract transcript segments from MD document content
function parseTranscriptFromMarkdown(content: string): TranscriptSegment[] {
  const marker = "\n## 转录原文\n";
  const idx = content.indexOf(marker);
  if (idx === -1) return [];

  let section = content.substring(idx + marker.length);
  const nextHeading = section.indexOf("\n## ");
  if (nextHeading !== -1) section = section.substring(0, nextHeading);

  const segments: TranscriptSegment[] = [];
  const parts = section.split(/\*\*\[/);
  for (let i = 1; i < parts.length; i++) {
    const bracketEnd = parts[i].indexOf("]");
    if (bracketEnd === -1) continue;
    const rawTime = parts[i].substring(0, bracketEnd);
    const startTime = rawTime.length <= 5 ? "00:" + rawTime : rawTime;
    const afterTime = parts[i].substring(bracketEnd + 1);
    const sepIdx = afterTime.indexOf("：**");
    const sepIdx2 = afterTime.indexOf(":**");
    const sep = sepIdx !== -1 ? sepIdx : sepIdx2;
    if (sep === -1) continue;
    const speaker = afterTime.substring(0, sep).trim();
    const text = afterTime.substring(sep + 3).trim();
    if (text) {
      segments.push({ startTime, endTime: "", speaker: speaker || "未知", text });
    }
  }
  return segments;
}

// ========== Helpers ==========

function addToMap(map: Map<string, vscode.Uri[]>, filePath: string): void {
  const dir = path.dirname(filePath);
  if (!map.has(dir)) map.set(dir, []);
  const uri = vscode.Uri.file(filePath);
  if (!map.get(dir)!.some(f => f.fsPath === filePath)) {
    map.get(dir)!.push(uri);
  }
}

function scanDirForMd(rootDir: string, map: Map<string, vscode.Uri[]>): void {
  try {
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(rootDir, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        scanDirForMd(fullPath, map);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        addToMap(map, fullPath);
      }
    }
  } catch {
    // skip unreadable directories
  }
}

// ========== Left Sidebar: MD File Directory TreeView ==========


function extractDateFromFilename(filename: string): number {
  // Try YYYYMMDDHHMMSS (14 digits)
  let m = filename.match(/(\d{14})/);
  if (m) return parseInt(m[1]);
  // Try YYYYMMDD (8 digits)
  m = filename.match(/(\d{8})/);
  if (m) return parseInt(m[1]);
  // Try YYYY-MM-DD
  m = filename.match(/(\d{4}-\d{2}-\d{2})/);
  if (m) return parseInt(m[1].replace(/-/g, ''));
  // Try unix timestamp (13 digits, starts with 1)
  m = filename.match(/(1\d{12})/);
  if (m) return Math.floor(parseInt(m[1]) / 1000);
  return 0;
}

function sortFilesByDate(files: vscode.Uri[]): vscode.Uri[] {
  return [...files].sort((a, b) => {
    const da = extractDateFromFilename(path.basename(a.fsPath));
    const db = extractDateFromFilename(path.basename(b.fsPath));
    return db - da; // newest first
  });
}
// ========== Panel Webview HTML ==========

function getPanelHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SonicNoteGeek</title>
<style>
:root {
  --bg: var(--vscode-editor-background, #1e1e1e);
  --fg: var(--vscode-editor-foreground, #cccccc);
  --border: var(--vscode-panel-border, #3c3c3c);
  --input-bg: var(--vscode-input-background, #3c3c3c);
  --input-fg: var(--vscode-input-foreground, #cccccc);
  --input-border: var(--vscode-input-border, #555);
  --btn-bg: var(--vscode-button-background, #0078d4);
  --btn-fg: var(--vscode-button-foreground, #ffffff);
  --btn-hover: var(--vscode-button-hoverBackground, #026fc1);
  --btn-secondary-bg: var(--vscode-button-secondaryBackground, #3a3d41);
  --btn-secondary-fg: var(--vscode-button-secondaryForeground, #cccccc);
  --badge: var(--vscode-badge-background, #4d4d4d);
  --card-bg: var(--vscode-input-background, #2d2d2d);
  --error: #f14c4c;
  --success: #4ec94e;
  --warning: #e5a500;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--vscode-font-family);
  font-size: 13px; color: var(--fg); background: var(--bg);
  line-height: 1.5; padding: 16px 20px;
  max-width: 800px; margin: 0 auto;
}

/* Title row */
.header { margin-bottom: 10px; text-align: center; }
.header h1 { font-size: 18px; font-weight: 600; margin: 0 0 10px 0; letter-spacing: 0.5px; }
.header-toolbar { display: flex; align-items: center; justify-content: flex-start; gap: 14px; }
.toolbar-btn {
  background: transparent; color: var(--fg); border: none;
  padding: 5px 7px; cursor: pointer; font-size: 19px;
  opacity: 0.7; transition: all 0.2s; line-height: 1;
  border-radius: 6px; outline: none;
}
.toolbar-btn:hover { opacity: 1; background: var(--badge); }
.toolbar-btn-settings { font-size: 22px; }

/* Dropdown */
.dropdown { position: relative; display: inline-block; }
.dropdown-menu {
  display: none; position: absolute; top: 100%; left: 0;
  background: var(--vscode-dropdown-background, #252526);
  border: 1px solid var(--border); border-radius: 6px;
  min-width: 170px; z-index: 999; padding: 4px 0;
  box-shadow: 0 4px 20px rgba(0,0,0,0.4);
}
.dropdown-menu.show { display: block; }
.dropdown-item {
  padding: 6px 14px; cursor: pointer; font-size: 12px;
  display: flex; align-items: center; gap: 7px;
}
.dropdown-item:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }

/* Source file */
.source-info { font-size: 11px; opacity: 0.65; margin: 10px 0 6px; }

/* Section titles */
.sec-title { font-size: 13px; font-weight: 600; margin: 16px 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--border); }

/* Audio list */
.audio-list { margin: 4px 0; }
.audio-row {
  display: flex; flex-wrap: wrap; align-items: flex-start; gap: 6px; padding: 5px 8px;
  background: var(--card-bg); border: 1px solid var(--border);
  border-radius: 5px; margin-bottom: 4px; font-size: 12px; cursor: pointer;
}
.audio-row .name { flex: 1; word-break: break-all; font-family: var(--vscode-editor-font-family); font-size: 11px; line-height: 1.4; }
.audio-row .name.selected { color: var(--btn-bg); }
.audio-row .dl-path { font-size: 10px; opacity: 0.7; color: var(--success); flex-basis: 100%; word-break: break-all; }
.audio-row .dl-error { font-size: 10px; color: var(--error); flex-basis: 100%; }
.audio-row .check {
  width: 16px; height: 16px; border: 2px solid var(--input-border);
  border-radius: 3px; cursor: pointer; display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; margin-top: 2px;
}
.audio-row .check.checked { background: var(--btn-bg); border-color: var(--btn-bg); }
.audio-row .check.checked::after { content: "✓"; color: #fff; font-size: 10px; }
.no-audio { font-size: 11px; opacity: 0.5; padding: 4px 0; }

/* Progress steps */
.progress-bar { display: flex; align-items: center; gap: 0; margin: 10px 0; }
.progress-step {
  flex: 1; text-align: center; position: relative;
  padding: 8px 4px; font-size: 11px; font-weight: 500;
}
.progress-step .dot {
  width: 28px; height: 28px; border-radius: 50%;
  background: var(--badge); margin: 0 auto 4px;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.3s;
}
.progress-step .dot .icon { font-size: 13px; opacity: 0.4; }
.progress-step .label { font-size: 10px; }
.progress-step.active .dot { background: var(--btn-bg); }
.progress-step.active .dot .icon { opacity: 1; }
.progress-step.done .dot { background: var(--success); }
.progress-step.done .dot .icon { opacity: 1; }
.progress-line {
  height: 2px; flex: 0 0 20px; background: var(--border);
  margin-top: -20px; transition: background 0.3s;
}
.progress-line.done { background: var(--success); }

/* Template cards */
.template-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 6px 0; }
.template-card {
  background: var(--card-bg); border: 2px solid var(--border);
  border-radius: 8px; padding: 10px 12px; cursor: pointer;
  transition: all 0.2s; user-select: none;
}
.template-card:hover { border-color: var(--btn-bg); transform: translateY(-1px); }
.template-card.selected { border-color: var(--btn-bg); background: var(--vscode-list-hoverBackground, #2a2d2e); }
.template-card .card-name { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
.template-card .card-desc { font-size: 10px; opacity: 0.65; margin-top: 4px; line-height: 1.3; }
.more-templates-btn {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  width: 100%; margin-top: 8px; padding: 7px;
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px;
  color: var(--fg); cursor: pointer; font-size: 12px; font-weight: 500;
  transition: all 0.15s;
}
.more-templates-btn:hover { border-color: var(--btn-bg); background: var(--vscode-list-hoverBackground, #2a2d2e); }

/* Template modal */
.modal-overlay {
  display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.6); z-index: 1000;
  align-items: center; justify-content: center;
}
.modal-overlay.show { display: flex; }
.modal {
  position: relative;
  background: var(--vscode-editor-background, #1e1e1e);
  border: 1px solid var(--border); border-radius: 10px;
  max-width: 650px; width: 90%; max-height: 70vh; overflow-y: auto;
  padding: 20px; box-shadow: 0 8px 40px rgba(0,0,0,0.5);
}
.modal h3 { font-size: 15px; margin-bottom: 12px; }
.modal .category-tabs {
  display: flex; gap: 4px; margin-bottom: 14px; flex-wrap: wrap;
}
.modal .cat-tab {
  padding: 4px 10px; font-size: 11px; border: 1px solid var(--border);
  border-radius: 14px; cursor: pointer; background: transparent; color: var(--fg);
  transition: all 0.15s; white-space: nowrap;
}
.modal .cat-tab:hover { border-color: var(--btn-bg); }
.modal .cat-tab.active {
  background: var(--btn-bg); color: var(--btn-fg); border-color: var(--btn-bg);
}
.modal .template-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.modal .tpl-chip {
  position: relative;
  padding: 12px 10px; background: var(--card-bg); border: 2px solid var(--border);
  border-radius: 8px; cursor: pointer; font-size: 11px;
  transition: all 0.15s;
}
.modal .tpl-chip:hover { border-color: var(--btn-bg); }
.modal .tpl-chip.selected { border-color: var(--btn-bg); background: rgba(0,120,212,0.15); }
.modal .tpl-chip .chip-name { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
.modal .tpl-chip .chip-desc { font-size: 10px; opacity: 0.65; margin-top: 4px; line-height: 1.3; }
.modal .tpl-chip .tpl-actions { position: absolute; bottom: 4px; right: 6px; display: flex; gap: 2px; }
.modal .tpl-chip .tpl-config { cursor: pointer; opacity: 0.4; font-size: 12px; padding: 1px 3px; }
.modal .tpl-chip .tpl-config:hover { opacity: 1; color: var(--btn-bg); }
.modal .tpl-chip .tpl-delete { cursor: pointer; opacity: 0.4; font-size: 12px; padding: 1px 3px; }
.modal .tpl-chip .tpl-delete:hover { opacity: 1; color: var(--error); }
.modal .custom-tpl-form {
  display: none; padding: 10px; background: var(--card-bg); border: 1px solid var(--border);
  border-radius: 8px; margin-top: 8px;
}
.modal .custom-tpl-form.show { display: block; }
.modal .custom-tpl-form input, .modal .custom-tpl-form textarea {
  width: 100%; padding: 6px 8px; margin-bottom: 6px; font-size: 11px; font-family: inherit;
  background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border);
  border-radius: 4px; box-sizing: border-box;
}
.modal .custom-tpl-form textarea { height: 80px; resize: vertical; }
.modal-close {
  display: block; margin: 14px auto 0; padding: 6px 24px;
  background: var(--btn-bg); color: var(--btn-fg); border: none;
  border-radius: 4px; cursor: pointer; font-size: 12px;
}
/* ASR tabs */
.asr-tabs { display: flex; gap: 0; margin-bottom: 14px; border-radius: 6px; overflow: hidden; border: 1px solid var(--border); }
.asr-tab {
  flex: 1; padding: 7px 12px; font-size: 12px; font-family: inherit; cursor: pointer;
  background: var(--card-bg); color: var(--fg); border: none; outline: none;
  transition: all 0.15s;
}
.asr-tab:first-child { border-right: 1px solid var(--border); }
.asr-tab.active { background: var(--btn-bg); color: var(--btn-fg); font-weight: 500; }
.asr-tab:hover:not(.active) { background: var(--input-bg); }
.asr-panel { }
.form-field { margin-bottom: 8px; }
.form-field label { display: block; font-size: 11px; margin-bottom: 3px; opacity: 0.85; font-weight: 500; }
.form-field select, .form-field input[type="text"], .form-field input[type="password"] {
  width: 100%; padding: 6px 8px; font-size: 12px; font-family: inherit;
  background: var(--input-bg); color: var(--input-fg);
  border: 1px solid var(--input-border); border-radius: 4px; box-sizing: border-box;
}
.asr-advanced-section { margin-top: 4px; border-top: 1px solid var(--border); padding-top: 8px; }
.asr-advanced-toggle {
  display: flex; align-items: center; gap: 4px; font-size: 11px; opacity: 0.7;
  cursor: pointer; padding: 4px 0;
}
.asr-advanced-toggle:hover { opacity: 1; }
.asr-advanced-toggle .asr-adv-arrow { font-size: 10px; transition: transform 0.2s; }
.asr-advanced-toggle.open .asr-adv-arrow { transform: rotate(90deg); }
.asr-advanced-panel { padding: 8px 0 0 0; }

/* Settings modal */
.settings-modal-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 14px; padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
}
.settings-modal-header span { font-size: 15px; font-weight: 600; }
.settings-modal-header .settings-modal-close-btn:hover { opacity: 1; }

/* Primary action button */
.btn-primary {
  width: 100%; padding: 10px; margin: 12px 0 8px;
  background: var(--btn-bg); color: var(--btn-fg); border: none;
  border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 600;
  font-family: inherit;
}
.btn-primary:hover { background: var(--btn-hover); }
.btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }

/* Secondary action buttons */
.btn-row { display: flex; gap: 6px; margin: 6px 0 14px; }
.btn-row button {
  flex: 1; padding: 6px 4px; font-size: 11px; font-family: inherit;
  background: var(--btn-secondary-bg); color: var(--btn-secondary-fg);
  border: 1px solid var(--border); border-radius: 5px; cursor: pointer;
  display: flex; align-items: center; justify-content: center; gap: 4px;
}
.btn-row button:hover { background: var(--badge); }
.btn-row button:disabled { opacity: 0.4; cursor: not-allowed; }

/* Status & errors */
.status-bar { font-size: 11px; opacity: 0.7; text-align: center; }
.error-msg { color: var(--error); font-size: 12px; margin: 4px 0; }
.success-msg { color: var(--success); font-size: 12px; margin: 4px 0; }
.vp-entry { display: flex; align-items: center; gap: 8px; padding: 6px 8px; margin: 4px 0; background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px; font-size: 12px; flex-wrap: wrap; }
.vp-entry .vp-name { font-weight: 600; min-width: 60px; cursor: pointer; color: var(--link-color); }
.vp-entry .vp-name:hover { text-decoration: underline; }
.vp-entry .vp-path { flex: 1; min-width: 140px; font-size: 10px; opacity: 0.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vp-entry .vp-btn { padding: 3px 8px; font-size: 11px; border: none; border-radius: 4px; cursor: pointer; background: var(--btn-bg); color: var(--btn-fg); font-family:inherit; }
.vp-entry .vp-btn.del { color: var(--error); }
.section-title { font-size: 13px; font-weight: 600; margin: 12px 0 6px; }

/* Settings forms */
.content-section { display: none; }
.content-section.active { display: block; }
h2 { font-size: 15px; margin: 0 0 12px; }
.section { margin-bottom: 12px; }
label { display: block; font-size: 11px; margin-bottom: 2px; opacity: 0.85; font-weight: 500; }
select, input[type="text"], input[type="password"], input[type="number"] {
  width: 100%; padding: 5px 8px; background: var(--input-bg); color: var(--input-fg);
  border: 1px solid var(--input-border); border-radius: 3px;
  font-family: inherit; font-size: 12px;
}
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.tag-container { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0; }
.tag {
  display: inline-flex; align-items: center; gap: 3px;
  background: var(--badge); padding: 2px 7px; border-radius: 4px; font-size: 11px;
}
.tag .remove { cursor: pointer; opacity: 0.5; margin-left: 4px; }
.tag .remove:hover { opacity: 1; color: var(--error); }
.inline-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.inline-row > input { flex: 1; }
.inline-row > button { flex: 0 0 auto; }

/* ---- Model list ---- */
.model-list { display: flex; flex-direction: column; gap: 4px; margin: 4px 0; }
.model-item {
  display: flex; align-items: center; gap: 6px; padding: 6px 10px;
  background: var(--card-bg); border: 2px solid var(--border);
  border-radius: 6px; font-size: 12px;
  transition: all 0.15s;
}
.model-item:hover { border-color: var(--btn-bg); }
.model-item.active { border-color: var(--success); background: rgba(78,201,78,0.08); }
.model-item .model-checkbox { cursor: pointer; font-size: 15px; flex-shrink: 0; user-select: none; }
.model-item .model-checkbox:hover { color: var(--success); }
.model-item .model-name { flex: 1; font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-item .model-info { font-size: 10px; opacity: 0.6; flex-shrink: 0; }
.model-item .active-badge { font-size: 10px; color: var(--success); font-weight: 600; flex-shrink: 0; }
.model-item .model-config { cursor: pointer; opacity: 0.4; font-size: 14px; padding: 2px 4px; flex-shrink: 0; }
.model-item .model-config:hover { opacity: 1; color: var(--btn-bg); }
.model-item .model-delete { cursor: pointer; opacity: 0.4; font-size: 14px; padding: 2px 4px; flex-shrink: 0; }
.model-item .model-delete:hover { opacity: 1; color: var(--error); }

/* ---- AI Chat ---- */
.chat-container {
  border: 1px solid var(--border); border-radius: 8px;
  overflow: hidden; margin-top: 6px;
}
.chat-messages {
  max-height: 250px; overflow-y: auto; padding: 12px;
  display: flex; flex-direction: column; gap: 8px;
  background: var(--vscode-sideBar-background, #252526);
  border-radius: 8px 8px 0 0;
}
.chat-msg { display: flex; max-width: 88%; }
.chat-msg.user { align-self: flex-end; }
.chat-msg.assistant { align-self: flex-start; }
.chat-bubble {
  padding: 8px 12px; border-radius: 12px; font-size: 12px;
  line-height: 1.5; word-break: break-word;
}
.chat-msg.user .chat-bubble {
  background: var(--vscode-button-background, #0078d4);
  color: var(--vscode-button-foreground, #fff);
  border-bottom-right-radius: 4px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.15);
}
.chat-msg.assistant .chat-bubble {
  background: var(--vscode-input-background, #3c3c3c);
  color: var(--vscode-input-foreground, #ccc);
  border: 1px solid var(--vscode-panel-border, #3e3e42);
  border-bottom-left-radius: 4px;
}
.chat-input-row {
  display: flex; align-items: flex-end;
  padding: 8px 10px;
  background: var(--vscode-editor-background, #1e1e1e);
  border: 1px solid var(--vscode-panel-border, #3e3e42);
  border-top: none;
  border-radius: 0 0 8px 8px;
}
.chat-input {
  flex: 1; padding: 7px 10px; box-sizing: border-box;
  background: var(--vscode-input-background, #3c3c3c);
  color: var(--vscode-input-foreground, #ccc);
  border: 1px solid var(--vscode-panel-border, #3e3e42);
  border-radius: 8px; font-family: inherit; font-size: 12px;
  outline: none; resize: vertical; min-height: 56px;
  transition: border-color 0.15s;
}
.chat-input:focus {
  border-color: var(--vscode-focusBorder, #0078d4);
  box-shadow: 0 0 0 1px var(--vscode-focusBorder, #0078d4);
}
.chat-input::placeholder { color: var(--vscode-input-placeholderForeground, #888); opacity: 1; }
.chat-typing { font-size: 11px; opacity: 0.6; padding: 4px 12px; }
</style>
</head>
<body>

<!-- ===== HEADER ===== -->
<div class="header">
  <h1>SonicNoteGeek</h1>
  <div class="header-toolbar">
    <div class="dropdown">
      <button id="btn-settings-dropdown" title="设置" class="toolbar-btn toolbar-btn-settings">⚙</button>
      <div class="dropdown-menu" id="settings-dropdown-menu">
        <div class="dropdown-item" data-action="asr-config">🔊 ASR配置</div>
        <div class="dropdown-item" data-action="llm-config">🤖 LLM配置</div>
        <div class="dropdown-item" data-action="hotwords">🏷️ 热词管理</div>
        <div class="dropdown-item" data-action="voiceprint">👤 声纹识别</div>
        <div class="dropdown-item" data-action="help">📖 帮助文档</div>
      </div>
    </div>
    <button id="btn-refresh" title="刷新" class="toolbar-btn">↻</button>
  </div>
</div>

<!-- ===== MAIN CONTENT ===== -->
<div id="section-main" class="content-section active">
  <!-- Source file info -->
  <div class="source-info" id="source-file">打开含 audio_url 的 Markdown 文件，点击 🔄 刷新 提取音频来源</div>

  <!-- Audio sources -->
  <div class="sec-title">🎧 音频来源</div>
  <div class="audio-list" id="mp3-list">
    <div class="no-audio">打开含 audio_url 的 Markdown 文件，点击 🔄 刷新 自动提取音频来源</div>
  </div>

  <!-- Progress -->
  <div class="sec-title">处理进度</div>
  <div class="progress-bar" id="progress-steps">
    <div class="progress-step" id="step-0">
      <div class="dot"><span class="icon">⬇</span></div>
      <div class="label">音频下载</div>
    </div>
    <div class="progress-line" id="line-0"></div>
    <div class="progress-step" id="step-1">
      <div class="dot"><span class="icon">🎤</span></div>
      <div class="label">录音转写</div>
    </div>
    <div class="progress-line" id="line-1"></div>
    <div class="progress-step" id="step-2">
      <div class="dot"><span class="icon">🧠</span></div>
      <div class="label">分析总结</div>
    </div>
    <div class="progress-line" id="line-2"></div>
    <div class="progress-step" id="step-3">
      <div class="dot"><span class="icon">📄</span></div>
      <div class="label">生成文档</div>
    </div>
  </div>
  <div class="status-bar" id="process-status"></div>
  <div class="error-msg" id="error-msg" style="margin:6px 0 10px;padding:8px 12px;border-radius:6px;background:var(--vscode-inputValidation-errorBackground,#5a1d1d);color:var(--vscode-inputValidation-errorForeground,#f44747);border:1px solid var(--vscode-inputValidation-errorBorder,#be1100);font-size:12px;line-height:1.5;display:none;white-space:pre-wrap;word-break:break-all"></div>

  <!-- Template -->
  <div class="sec-title">📝 总结模板</div>
  <div class="template-cards" id="template-cards"></div>
  <button class="more-templates-btn" id="btn-more-templates"><span style="font-size:16px">📋</span> 更多模板...</button>

  <!-- Active models -->
  <div class="active-models" id="active-models" style="display:flex;gap:12px;font-size:11px;opacity:0.7;margin:8px 0;justify-content:center">
    <span>🔊 ASR: <b id="lbl-asr-model">默认配置</b></span>
    <span>🤖 LLM: <b id="lbl-llm-model">默认配置</b></span>
  </div>

  <!-- Primary action -->
  <button class="btn-primary" id="btn-start" disabled>▶ 开始转写总结</button>

  <!-- Secondary actions -->
  <div class="btn-row">
    <button id="btn-retranscribe" disabled>🔄 重新转写</button>
    <button id="btn-resummarize" disabled>📝 重新总结</button>
    <button id="btn-voicefix" disabled>👤 人声勘正</button>
    <button id="btn-voiceprint" disabled>🎙 声纹采样</button>
  </div>

  <!-- AI 小录 Chat -->
  <div class="sec-title" style="margin-top:16px">🤖 AI 小录</div>
  <div class="chat-container">
    <div class="chat-messages" id="chat-messages">
      <div class="chat-msg assistant">
        <div class="chat-bubble">你好！我是 AI 小录，可以帮你分析转录内容、提取关键信息、回答相关问题。请先完成音频转写，然后向我提问。</div>
      </div>
    </div>
    <div class="chat-input-row">
      <textarea id="chat-input" class="chat-input" placeholder="输入问题，按 Enter 发送（Shift+Enter 换行）..." rows="3"></textarea>
    </div>
  </div>
</div>

<!-- Template Modal -->
<div class="modal-overlay" id="template-modal-overlay">
  <div class="modal" id="template-modal">
    <button id="template-modal-close" style="position:absolute;top:10px;right:10px;font-size:18px;padding:0 6px;cursor:pointer;border:none;background:none;color:var(--vscode-foreground,#ccc);opacity:0.5;line-height:1" title="关闭">✕</button>
  </div>
</div>

<!-- Voicefix Modal -->
<div class="modal-overlay" id="voicefix-modal-overlay">
  <div class="modal" id="voicefix-modal">
    <button id="voicefix-modal-close" style="position:absolute;top:10px;right:10px;font-size:18px;padding:0 6px;cursor:pointer;border:none;background:none;color:var(--vscode-foreground,#ccc);opacity:0.5;line-height:1" title="关闭">✕</button>
    <h3>👤 人声勘正</h3>
    <p id="voicefix-subtitle" style="font-size:11px;opacity:0.7;margin-bottom:10px">通过声纹比对自动识别说话人身份</p>
    <div id="voicefix-segments"></div>
    <div id="voicefix-actions" style="display:flex;gap:8px;margin-top:12px">
      <button id="voicefix-close-btn" style="flex:1;background:var(--btn-secondary-bg);color:var(--btn-secondary-fg);border:1px solid var(--input-border);border-radius:4px;padding:6px 12px;cursor:pointer">关闭</button>
    </div>
  </div>
</div>

<!-- Voiceprint Guide Modal -->
<div class="modal-overlay" id="voiceprint-guide-modal-overlay" style="z-index:1100">
  <div class="modal" id="voiceprint-guide-modal" style="max-width:750px;max-height:80vh;overflow-y:auto">
    <button id="voiceprint-guide-close" style="position:sticky;top:0;float:right;z-index:1;font-size:18px;padding:0 6px;cursor:pointer;border:none;background:var(--vscode-editor-background,var(--bg));color:var(--vscode-foreground,#ccc);opacity:0.5;line-height:1" title="关闭">✕</button>
    <h3 style="margin-top:0">📄 声纹识别接口标准</h3>
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <button id="voiceprint-guide-download" style="padding:5px 12px;font-size:11px;font-family:inherit;background:var(--btn-bg);color:var(--btn-fg);border:none;border-radius:4px;cursor:pointer">⬇ 下载文档 (.md)</button>
    </div>
    <div id="voiceprint-guide-content" style="font-size:12px;line-height:1.7"></div>
  </div>
</div>

<!-- ASR Custom Guide Modal -->
<div class="modal-overlay" id="asr-guide-modal-overlay" style="z-index:1100">
  <div class="modal" id="asr-guide-modal" style="max-width:750px;max-height:80vh;overflow-y:auto">
    <button id="asr-guide-close" style="position:sticky;top:0;float:right;z-index:1;font-size:18px;padding:0 6px;cursor:pointer;border:none;background:var(--vscode-editor-background,var(--bg));color:var(--vscode-foreground,#ccc);opacity:0.5;line-height:1" title="关闭">✕</button>
    <h3 style="margin-top:0">📄 OpenAI 音频转写接口标准</h3>
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <button id="asr-guide-download" style="padding:5px 12px;font-size:11px;font-family:inherit;background:var(--btn-bg);color:var(--btn-fg);border:none;border-radius:4px;cursor:pointer">⬇ 下载文档 (.md)</button>
    </div>
    <div id="asr-guide-content" style="font-size:12px;line-height:1.7"></div>
  </div>
</div>

<!-- Voiceprint Sample Modal -->
<div class="modal-overlay" id="voiceprint-modal-overlay">
  <div class="modal" id="voiceprint-modal" style="max-width:700px">
    <button id="voiceprint-modal-close" style="position:absolute;top:10px;right:10px;font-size:18px;padding:0 6px;cursor:pointer;border:none;background:none;color:var(--vscode-foreground,#ccc);opacity:0.5;line-height:1" title="关闭">✕</button>
    <h3>🎙 声纹采样</h3>
    <p style="font-size:11px;opacity:0.7;margin-bottom:10px">从转录中提取说话人音频片段，保存为声纹样本用于后续自动识别</p>
    <div id="voiceprint-speakers"></div>
    <div id="voiceprint-candidate" style="display:none;margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
      <label style="font-size:11px;font-weight:600;margin-bottom:4px">候选音频片段</label>
      <div id="voiceprint-segments-list"></div>
    </div>
    <div style="text-align:center;margin-top:12px">
      <button id="voiceprint-resample" style="padding:6px 16px;font-size:12px;background:var(--btn-secondary-bg);color:var(--btn-secondary-fg);border:none;border-radius:4px;cursor:pointer">🔄 重新采样</button>
    </div>
  </div>
</div>

<!-- ===== SETTINGS: ASR Config ===== -->
<div id="section-asr-config" class="content-section">
  <!-- Page 1: Model List -->
  <div id="asr-page-list">
    <div class="model-list-section">
      <label style="margin-bottom:6px;font-weight:600">已保存的模型 <span style="opacity:0.5;font-weight:400">(点击激活)</span></label>
      <div class="model-list" id="asr-model-list"></div>
    </div>
    <button id="btn-open-asr-add" style="width:100%;margin-top:12px;padding:8px;font-size:13px;font-family:inherit;background:var(--btn-bg);color:var(--btn-fg);border:none;border-radius:6px;cursor:pointer">➕ 添加新模型</button>
  </div>
  <!-- Page 2: Add Model -->
  <div id="asr-page-add" style="display:none">
    <!-- Tab buttons -->
    <div class="asr-tabs">
      <button id="asr-tab-provider" class="asr-tab active">模型服务商</button>
      <button id="asr-tab-custom" class="asr-tab">自定义模型</button>
    </div>
    <!-- Provider panel -->
    <div id="asr-panel-provider" class="asr-panel">
      <div class="form-field"><label>选择服务商</label><select id="setting-asr-provider">
        <option value="openai-whisper">OpenAI Whisper</option>
        <option value="volcengine">火山引擎 (豆包)</option>
        <option value="aliyun-dashscope">阿里云 DashScope</option>
        <option value="xunfei">讯飞</option>
        <option value="tencent">腾讯云</option>
        <option value="baidu">百度</option>
        <option value="huawei">华为云</option>
        <option value="azure">Microsoft Azure</option>
        <option value="google">Google Cloud</option>
        <option value="aws">Amazon Transcribe</option>
      </select></div>
      <div class="form-field asr-dyn-field" id="asr-field-apikey"><label id="asr-label-apikey">API Key</label><input type="password" id="setting-asr-apikey" placeholder="sk-..."></div>
      <div class="form-field asr-dyn-field" id="asr-field-appid" style="display:none"><label id="asr-label-appid">APP ID</label><input type="text" id="setting-asr-appid" placeholder="APP ID"></div>
      <div class="form-field asr-dyn-field" id="asr-field-apisecret" style="display:none"><label id="asr-label-apisecret">API Secret</label><input type="password" id="setting-asr-apisecret" placeholder="API Secret"></div>
      <div class="form-field asr-dyn-field" id="asr-field-resourceid" style="display:none"><label id="asr-label-resourceid">Resource ID</label><input type="text" id="setting-asr-resourceid" placeholder="volc.seedasr.auc"></div>
      <div class="form-field asr-dyn-field" id="asr-field-region" style="display:none"><label id="asr-label-region">Region</label><input type="text" id="setting-asr-region" placeholder="例如: cn-north-4"></div>
      <div class="form-field"><label>API URL</label><input type="text" id="setting-asr-apiurl" placeholder="https://api.example.com/v1/audio/transcriptions"></div>
      <div class="form-field"><label>转写语言</label><select id="setting-asr-language">
        <option value="zh">中文</option><option value="en">English</option>
        <option value="ja">日本語</option><option value="ko">한국어</option>
        <option value="yue">粤语</option><option value="auto">自动检测</option>
      </select></div>
      <div class="asr-advanced-section">
        <div class="asr-advanced-toggle" id="asr-adv-toggle-provider"><span>⚙</span> 高级配置 <span class="asr-adv-arrow">▸</span></div>
        <div class="asr-advanced-panel" id="asr-adv-panel-provider" style="display:none">
          <div class="form-field"><label>展示名称</label><input type="text" id="setting-asr-displayname" placeholder="例如: 公司Whisper"></div>
          <div class="form-field"><label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="setting-asr-diarization" style="width:auto;margin:0"> 启动说话人分离</label></div>
        </div>
      </div>
    </div>
    <!-- Custom panel -->
    <div id="asr-panel-custom" class="asr-panel" style="display:none">
      <div class="form-field"><div style="display:flex;align-items:center;gap:6px"><label style="margin:0">通信协议</label><select id="setting-asr-protocol" style="flex:1">
        <option value="local-openai">本地 OpenAI 兼容</option>
      </select><button id="btn-asr-custom-guide" style="padding:4px 8px;font-size:11px;font-family:inherit;background:var(--btn-secondary-bg);color:var(--btn-secondary-fg);border:1px solid var(--input-border);border-radius:4px;cursor:pointer;white-space:nowrap">📄 接口文档</button></div></div>
      <div class="form-field"><label>展示名称</label><input type="text" id="setting-asr-custom-displayname" placeholder="例如: 自建Whisper服务"></div>
      <div class="form-field"><label>服务地址</label><input type="text" id="setting-asr-custom-apiurl" placeholder="http://localhost:8080/v1/audio"></div>
      <div class="form-field"><label>模型名称</label><input type="text" id="setting-asr-custom-model" placeholder="whisper-1"></div>
      <div class="form-field"><label>转写语言</label><select id="setting-asr-custom-language">
        <option value="zh">中文</option><option value="en">English</option>
        <option value="ja">日本語</option><option value="ko">한국어</option>
        <option value="yue">粤语</option><option value="auto">自动检测</option>
      </select></div>
      <div class="asr-advanced-section">
        <div class="asr-advanced-toggle" id="asr-adv-toggle-custom"><span>⚙</span> 高级配置 <span class="asr-adv-arrow">▸</span></div>
        <div class="asr-advanced-panel" id="asr-adv-panel-custom" style="display:none">
          <div class="form-field"><label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="setting-asr-custom-diarization" style="width:auto;margin:0"> 启动说话人分离</label></div>
        </div>
      </div>
    </div>
    <div class="btn-row" style="margin-top:12px">
      <button id="btn-cancel-asr" style="flex:1">取消</button>
      <button id="btn-save-asr" class="btn-primary" style="flex:2;margin:0">💾 保存模型</button>
    </div>
    <div class="success-msg" id="asr-saved-msg"></div>
  </div>
</div>

<!-- ===== SETTINGS: LLM Config ===== -->
<div id="section-llm-config" class="content-section">
  <!-- Page 1: Model List -->
  <div id="llm-page-list">
    <div class="model-list-section">
      <label style="margin-bottom:6px;font-weight:600">已保存的模型 <span style="opacity:0.5;font-weight:400">(点击激活)</span></label>
      <div class="model-list" id="llm-model-list"></div>
    </div>
    <button id="btn-open-llm-add" style="width:100%;margin-top:12px;padding:8px;font-size:13px;font-family:inherit;background:var(--btn-bg);color:var(--btn-fg);border:none;border-radius:6px;cursor:pointer">➕ 添加新模型</button>
  </div>
  <!-- Page 2: Add Model -->
  <div id="llm-page-add" style="display:none">
    <!-- Tab buttons -->
    <div class="asr-tabs">
      <button id="llm-tab-provider" class="asr-tab active">模型服务商</button>
      <button id="llm-tab-custom" class="asr-tab">自定义配置</button>
    </div>
    <!-- Provider panel -->
    <div id="llm-panel-provider" class="asr-panel">
      <div class="form-field"><label>服务商</label><select id="setting-llm-provider">
        <option value="anthropic">Anthropic Claude</option>
        <option value="openai">OpenAI (GPT-4o)</option>
        <option value="zhipu">智谱 (GLM)</option>
        <option value="deepseek">DeepSeek</option>
        <option value="minimax">MiniMax</option>
        <option value="google">Google Gemini</option>
        <option value="aliyun">阿里云 (通义千问)</option>
        <option value="baidu">百度 (文心一言)</option>
        <option value="bytedance">字节跳动 (豆包)</option>
        <option value="tencent">腾讯 (混元)</option>
        <option value="huawei">华为 (盘古)</option>
        <option value="moonshot">月之暗面 (Kimi)</option>
        <option value="xunfei">讯飞 (星火)</option>
        <option value="mistral">Mistral AI</option>
        <option value="meta">Meta (Llama)</option>
      </select></div>
      <div class="form-field"><label>模型</label><select id="setting-llm-model">
        <option value="">-- 请先选择服务商 --</option>
      </select></div>
      <div class="form-field"><label>API Key</label><input type="password" id="setting-llm-apikey" placeholder="sk-..."></div>
      <div class="form-field"><label>API URL</label><input type="text" id="setting-llm-apiurl" placeholder="端点地址"></div>
      <div class="asr-advanced-section">
        <div class="asr-advanced-toggle" id="llm-adv-toggle-provider"><span>⚙</span> 高级配置 <span class="asr-adv-arrow">▸</span></div>
        <div class="asr-advanced-panel" id="llm-adv-panel-provider" style="display:none">
          <div class="form-field"><label>展示名称</label><input type="text" id="setting-llm-displayname" placeholder="例如: 公司Claude"></div>
          <div class="form-field"><label>上下文窗口</label><input type="number" id="setting-llm-contextwindow" value="200000" min="4096" max="2000000" step="1000"></div>
          <div class="form-field"><label>最大输出 Token</label><input type="number" id="setting-llm-maxtokens" value="4096" min="256" max="128000"></div>
          <div class="form-field"><label>温度 (Temperature)</label><input type="number" id="setting-llm-temp" value="0.7" min="0" max="2" step="0.1"></div>
        </div>
      </div>
    </div>
    <!-- Custom panel -->
    <div id="llm-panel-custom" class="asr-panel" style="display:none">
      <div class="form-field"><label>API 格式</label><select id="setting-llm-api-format">
        <option value="openai-chat">OpenAI Chat Completions</option>
        <option value="anthropic-messages">Anthropic Messages</option>
      </select></div>
      <div class="form-field"><label>请求地址</label><input type="text" id="setting-llm-custom-apiurl" placeholder="https://api.example.com/v1/chat/completions"></div>
      <div class="form-field"><label>模型 ID</label><input type="text" id="setting-llm-custom-model" placeholder="claude-sonnet-4-6"></div>
      <div class="form-field"><label>API 密钥</label><input type="password" id="setting-llm-custom-apikey" placeholder="sk-..."></div>
      <div class="asr-advanced-section">
        <div class="asr-advanced-toggle" id="llm-adv-toggle-custom"><span>⚙</span> 高级配置 <span class="asr-adv-arrow">▸</span></div>
        <div class="asr-advanced-panel" id="llm-adv-panel-custom" style="display:none">
          <div class="form-field"><label>展示名称</label><input type="text" id="setting-llm-custom-displayname" placeholder="例如: 自建服务"></div>
          <div class="form-field"><label>上下文窗口</label><input type="number" id="setting-llm-custom-contextwindow" value="200000" min="4096" max="2000000" step="1000"></div>
          <div class="form-field"><label>最大输出 Token</label><input type="number" id="setting-llm-custom-maxtokens" value="4096" min="256" max="128000"></div>
          <div class="form-field"><label>温度 (Temperature)</label><input type="number" id="setting-llm-custom-temp" value="0.7" min="0" max="2" step="0.1"></div>
        </div>
      </div>
    </div>
    <div class="btn-row" style="margin-top:12px">
      <button id="btn-cancel-llm" style="flex:1">取消</button>
      <button id="btn-save-llm" class="btn-primary" style="flex:2;margin:0">💾 保存模型</button>
    </div>
    <div class="success-msg" id="llm-saved-msg"></div>
  </div>
</div>

<!-- ===== SETTINGS: HotWords ===== -->
<div id="section-hotwords" class="content-section">
  <p style="font-size:11px;opacity:0.7;margin-bottom:8px">添加专业术语、人名、产品名，提高 ASR 转写准确率</p>
  <div class="inline-row">
    <input type="text" id="hotword-input" placeholder="输入热词，按 Enter 添加">
    <button id="btn-add-hotword" class="secondary">添加</button>
  </div>
  <div class="tag-container" id="hotword-list"></div>
  <label style="margin-top:12px;font-weight:600;display:block">行业偏好</label>
  <select id="setting-industry" style="width:100%;margin-top:4px;padding:6px;font-size:13px;font-family:inherit;background:var(--input-bg);color:var(--input-fg);border:1px solid var(--border-color);border-radius:6px">
    <option value="">不指定（默认）</option>
    <option value="信息技术与工程">信息技术与工程</option>
    <option value="能源与环境">能源与环境</option>
    <option value="金融与法律">金融与法律</option>
    <option value="教育与研究">教育与研究</option>
    <option value="公共服务">公共服务</option>
    <option value="医疗与健康">医疗与健康</option>
    <option value="创新与传媒">创新与传媒</option>
    <option value="建筑与房地产">建筑与房地产</option>
    <option value="人力资源与行政">人力资源与行政</option>
    <option value="零售与消费">零售与消费</option>
    <option value="旅游与物流">旅游与物流</option>
  </select>
  <button id="btn-save-hotwords" style="width:100%;margin-top:10px;padding:7px">💾 保存热词</button>
  <div class="success-msg" id="hw-saved-msg"></div>
</div>

<!-- ===== SETTINGS: Voiceprint ===== -->
<div id="section-voiceprint" class="content-section">
  <div style="display:flex;align-items:center;justify-content:space-between">
    <div class="section-title">🔧 声纹识别服务</div>
    <button id="btn-voiceprint-guide" style="padding:4px 10px;font-size:11px;font-family:inherit;background:var(--btn-secondary-bg);color:var(--btn-secondary-fg);border:1px solid var(--input-border);border-radius:4px;cursor:pointer">📄 接入文档</button>
  </div>
  <div style="display:flex;flex-direction:column;gap:6px">
    <div style="display:flex;gap:8px;align-items:center">
      <label style="min-width:56px;font-size:12px">服务地址</label>
      <input type="text" id="setting-speaker-endpoint" placeholder="http://localhost:8100" style="flex:1">
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      <label style="min-width:56px;font-size:12px">API Key</label>
      <input type="password" id="setting-speaker-apikey" placeholder="可选" style="flex:1">
    </div>
    <button id="btn-test-voiceprint" style="padding:6px 12px;align-self:flex-start;font-size:12px">🔍 检测服务</button>
  </div>
  <div id="vp-test-result" style="font-size:11px;margin-top:4px"></div>

  <div class="section-title" style="margin-top:16px">🗣️ 声纹库 <span style="opacity:0.5;font-weight:400;font-size:11px">(<span id="voiceprint-count">0</span> 个样本)</span></div>
  <div id="voiceprint-library-list" style="margin:8px 0"></div>
  <button id="btn-add-voiceprint" style="width:100%;padding:6px;font-size:12px;font-family:inherit;background:var(--btn-bg);color:var(--btn-fg);border:none;border-radius:6px;cursor:pointer">➕ 添加声纹样本</button>

  <button id="btn-save-voiceprint" style="width:100%;margin-top:12px;padding:7px">💾 保存并关闭</button>
  <div class="success-msg" id="vp-saved-msg"></div>
</div>

<!-- ===== SETTINGS MODAL ===== -->
<div class="modal-overlay" id="settings-modal-overlay">
  <div class="modal" id="settings-modal" style="max-width:520px">
    <div class="settings-modal-header">
      <span id="settings-modal-title">设置</span>
      <span id="settings-modal-close-btn" style="cursor:pointer;font-size:18px;opacity:0.6;padding:0 4px" title="关闭">✕</span>
    </div>
    <div id="settings-modal-body"></div>
  </div>
</div>

<script>
const vscode = acquireVsCodeApi();
let detectedUrls = [];
let selectedUrls = [];
let downloadPathsMap = {};
let downloadErrors = {};
let lastOutput = "";
let processing = false;
let hotWords = [];
let voiceprintLibrary = [];
let templateOptions = [];
let selectedTemplate = "business-meeting";

// ---- Navigation ----
function showSection(name) {
  document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));
  const target = document.getElementById('section-' + name);
  if (target) target.classList.add('active');
}

let _settingsModalSectionId = null;
let _settingsModalOriginalParent = null;

function openSettingsModal(sectionName) {
  const section = document.getElementById('section-' + sectionName);
  if (!section) return;
  const modalBody = document.getElementById('settings-modal-body');
  const overlay = document.getElementById('settings-modal-overlay');
  const title = document.getElementById('settings-modal-title');

  // Set title
  const titles = { 'asr-config': '🔊 ASR 语音转写配置', 'llm-config': '🤖 LLM 大模型配置', 'hotwords': '🏷️ 热词管理', 'voiceprint': '👤 声纹识别配置' };
  title.textContent = titles[sectionName] || '设置';

  // Store original location
  _settingsModalSectionId = sectionName;
  _settingsModalOriginalParent = section.parentNode;

  // Move section into modal body
  modalBody.appendChild(section);
  section.style.display = 'block';

  overlay.classList.add('show');
}

function closeSettingsModal() {
  // If on ASR add page, go back to ASR model list instead of closing
  const asrAddPage = document.getElementById('asr-page-add');
  if (asrAddPage && asrAddPage.style.display === 'block') {
    window._editingAsrModelId = null;
    document.getElementById('btn-save-asr').textContent = '💾 保存模型';
    showAsrList();
    return;
  }
  // If on LLM add page, go back to LLM model list instead of closing
  const llmAddPage = document.getElementById('llm-page-add');
  if (llmAddPage && llmAddPage.style.display === 'block') {
    window._editingLlmModelId = null;
    document.getElementById('btn-save-llm').textContent = '💾 保存模型';
    showLlmList();
    return;
  }

  stopVpLibAudio();
  const overlay = document.getElementById('settings-modal-overlay');
  const modalBody = document.getElementById('settings-modal-body');
  const sectionName = _settingsModalSectionId;
  if (!sectionName) { overlay.classList.remove('show'); return; }

  const section = document.getElementById('section-' + sectionName);
  overlay.classList.remove('show');

  if (section && _settingsModalOriginalParent) {
    modalBody.removeChild(section);
    _settingsModalOriginalParent.appendChild(section);
    section.style.display = '';
  }

  _settingsModalSectionId = null;
  _settingsModalOriginalParent = null;
}

// Close settings modal on overlay click
document.getElementById('settings-modal-overlay').addEventListener('click', function(e) {
  if (e.target === this) closeSettingsModal();
});
document.getElementById('settings-modal-close-btn').addEventListener('click', closeSettingsModal);
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && _settingsModalSectionId) closeSettingsModal();
});

// ---- Header actions ----
document.getElementById('btn-refresh').addEventListener('click', () => vscode.postMessage({ type: 'scanMp3' }));

// ---- Model management ----
let asrModels = [];
let llmModels = [];
let activeAsrModelId = "";
let activeModelId = "";

function renderAsrModelList() {
  const container = document.getElementById('asr-model-list');
  if (!container) return;
  if (asrModels.length === 0) {
    container.innerHTML = '<div style="font-size:11px;opacity:0.5;padding:4px">暂无已保存模型，使用下方表单添加</div>';
    document.getElementById('lbl-asr-model').textContent = '默认配置';
    return;
  }
  container.innerHTML = asrModels.map(m => {
    const active = m.id === activeAsrModelId;
    return '<div class="model-item' + (active ? ' active' : '') + '" data-id="' + m.id + '">' +
      '<span class="model-checkbox" data-id="' + m.id + '">' + (active ? '☑' : '☐') + '</span>' +
      '<span class="model-name">' + (m.displayName || m.preset || m.protocol) + '</span>' +
      '<span class="model-info">' + (m.preset || m.protocol) + ' · ' + (m.model || '') + '</span>' +
      (active ? '<span class="active-badge">已激活</span>' : '') +
      '<span class="model-config" data-id="' + m.id + '">⚙</span>' +
      '<span class="model-delete" data-id="' + m.id + '">×</span>' +
      '</div>';
  }).join('');
  // Checkbox click → activate
  container.querySelectorAll('.model-checkbox').forEach(cb => {
    cb.addEventListener('click', (e) => {
      e.stopPropagation();
      activeAsrModelId = cb.dataset.id;
      renderAsrModelList();
      updateActiveLabels();
      vscode.postMessage({ type: 'activateAsrModel', modelId: activeAsrModelId });
    });
  });
  // Config click → populate form for editing
  container.querySelectorAll('.model-config').forEach(cfg => {
    cfg.addEventListener('click', (e) => {
      e.stopPropagation();
      const model = asrModels.find(m => m.id === cfg.dataset.id);
      if (!model) return;
      // Navigate to add page
      document.getElementById('asr-page-list').style.display = 'none';
      document.getElementById('asr-page-add').style.display = 'block';
      // Switch to the appropriate tab and fill form fields
      if (model.preset && model.preset !== 'custom' && model.asrType !== 'custom') {
        switchAsrTab('provider');
        setVal('setting-asr-provider', model.protocol);
        updateAsrProviderFields();
        setVal('setting-asr-apikey', model.apiKey);
        setVal('setting-asr-apiurl', model.apiUrl || '');
        setVal('setting-asr-model', model.model || '');
        setVal('setting-asr-language', model.language || 'zh');
        setVal('setting-asr-displayname', model.displayName || '');
        setVal('setting-asr-appid', model.appId || '');
        setVal('setting-asr-apisecret', model.secretKey || '');
        setVal('setting-asr-region', model.region || '');
        if (model.enableSpeakerDiarization) {
          setCheck('setting-asr-diarization', true);
        }
        window._editingAsrModelId = model.id;
        document.getElementById('btn-save-asr').textContent = '💾 更新模型';
      } else {
        switchAsrTab('custom');
        setVal('setting-asr-protocol', model.protocol || '');
        setVal('setting-asr-custom-displayname', model.displayName || '');
        setVal('setting-asr-custom-apiurl', model.apiUrl || model.localEndpoint || '');
        setVal('setting-asr-custom-model', model.model || '');
        setVal('setting-asr-custom-language', model.language || 'zh');
        if (model.enableSpeakerDiarization) {
          setCheck('setting-asr-custom-diarization', true);
        }
        window._editingAsrModelId = model.id;
        document.getElementById('btn-save-asr').textContent = '💾 更新模型';
      }
    });
  });
  // Delete
  container.querySelectorAll('.model-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      vscode.postMessage({ type: 'deleteAsrModel', modelId: id });
    });
  });
  // Update label
  const activeModel = asrModels.find(m => m.id === activeAsrModelId);
  document.getElementById('lbl-asr-model').textContent = activeModel ? (activeModel.displayName || activeModel.preset || activeModel.protocol) : '默认配置';
}

function renderLlmModelList() {
  const container = document.getElementById('llm-model-list');
  if (!container) return;
  if (llmModels.length === 0) {
    container.innerHTML = '<div style="font-size:11px;opacity:0.5;padding:4px">暂无已保存模型，使用下方表单添加</div>';
    document.getElementById('lbl-llm-model').textContent = '默认配置';
    return;
  }
  container.innerHTML = llmModels.map(m => {
    const active = m.id === activeModelId;
    return '<div class="model-item' + (active ? ' active' : '') + '" data-id="' + m.id + '">' +
      '<span class="model-checkbox" data-id="' + m.id + '">' + (active ? '☑' : '☐') + '</span>' +
      '<span class="model-name">' + (m.displayName || m.provider || '') + '</span>' +
      '<span class="model-info">' + (m.provider || '') + ' · ' + (m.model || '') + '</span>' +
      (active ? '<span class="active-badge">已激活</span>' : '') +
      '<span class="model-config" data-id="' + m.id + '">⚙</span>' +
      '<span class="model-delete" data-id="' + m.id + '">×</span>' +
      '</div>';
  }).join('');
  // Checkbox click → activate
  container.querySelectorAll('.model-checkbox').forEach(cb => {
    cb.addEventListener('click', (e) => {
      e.stopPropagation();
      activeModelId = cb.dataset.id;
      renderLlmModelList();
      updateActiveLabels();
      vscode.postMessage({ type: 'activateLlmModel', modelId: activeModelId });
    });
  });
  // Config click → populate form for editing
  container.querySelectorAll('.model-config').forEach(cfg => {
    cfg.addEventListener('click', (e) => {
      e.stopPropagation();
      const model = llmModels.find(m => m.id === cfg.dataset.id);
      if (!model) return;
      // Navigate to add page
      document.getElementById('llm-page-list').style.display = 'none';
      document.getElementById('llm-page-add').style.display = 'block';
      // Determine if it's a provider model or custom
      const isCustom = model.llmType === 'custom' || (!model.provider || model.provider === 'custom');
      if (!isCustom) {
        switchLlmTab('provider');
        setVal('setting-llm-provider', model.provider);
        // trigger change to update models dropdown
        document.getElementById('setting-llm-provider').dispatchEvent(new Event('change'));
        setTimeout(() => { setVal('setting-llm-model', model.model || ''); }, 50);
        setVal('setting-llm-apikey', model.apiKey || '');
        setVal('setting-llm-apiurl', model.apiUrl || '');
        setVal('setting-llm-displayname', model.displayName || '');
        setVal('setting-llm-contextwindow', model.contextWindow || 200000);
        setVal('setting-llm-maxtokens', model.maxTokens || 4096);
        setVal('setting-llm-temp', model.temperature ?? 0.7);
        window._editingLlmModelId = model.id;
        document.getElementById('btn-save-llm').textContent = '💾 更新模型';
      } else {
        switchLlmTab('custom');
        setVal('setting-llm-api-format', model.apiFormat || 'openai-chat');
        setVal('setting-llm-custom-displayname', model.displayName || '');
        setVal('setting-llm-custom-model', model.model || '');
        setVal('setting-llm-custom-apikey', model.apiKey || '');
        setVal('setting-llm-custom-apiurl', model.apiUrl || '');
        setVal('setting-llm-custom-maxtokens', model.maxTokens || 4096);
        setVal('setting-llm-custom-temp', model.temperature ?? 0.7);
        setVal('setting-llm-custom-contextwindow', model.contextWindow || 200000);
        window._editingLlmModelId = model.id;
        document.getElementById('btn-save-llm').textContent = '💾 更新模型';
      }
    });
  });
  // Delete
  container.querySelectorAll('.model-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      vscode.postMessage({ type: 'deleteLlmModel', modelId: id });
    });
  });
  // Update label
  const activeModel = llmModels.find(m => m.id === activeModelId);
  document.getElementById('lbl-llm-model').textContent = activeModel ? (activeModel.displayName || activeModel.provider || '') : '默认配置';
}

function updateActiveLabels() {
  const asrName = document.getElementById('lbl-asr-model');
  const llmName = document.getElementById('lbl-llm-model');
  if (asrModels.length > 0) {
    const m = asrModels.find(x => x.id === activeAsrModelId);
    if (asrName) asrName.textContent = m ? (m.displayName || m.preset || m.protocol) : '默认配置';
  }
  if (llmModels.length > 0) {
    const m = llmModels.find(x => x.id === activeModelId);
    if (llmName) llmName.textContent = m ? (m.displayName || m.provider || '') : '默认配置';
  }
}

// ---- Settings dropdown ----
const dropdownBtn = document.getElementById('btn-settings-dropdown');
const dropdownMenu = document.getElementById('settings-dropdown-menu');
dropdownBtn.addEventListener('click', (e) => { e.stopPropagation(); dropdownMenu.classList.toggle('show'); });
document.addEventListener('click', () => dropdownMenu.classList.remove('show'));
dropdownMenu.querySelectorAll('.dropdown-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.stopPropagation(); dropdownMenu.classList.remove('show');
    const action = item.dataset.action;
    switch (action) {
      case 'asr-config': openSettingsModal('asr-config'); break;
      case 'llm-config': openSettingsModal('llm-config'); break;
      case 'hotwords': openSettingsModal('hotwords'); break;
      case 'voiceprint': openSettingsModal('voiceprint'); break;
      case 'help': vscode.postMessage({ type: 'openHelp' }); break;
    }
  });
});

// ---- Template cards ----

function initTemplateCards() {
  const container = document.getElementById('template-cards');
  if (!container) return;
  // Featured template order: 通用, 商务会议, 课堂总结, 访谈记录
  const featuredValues = ['general', 'business-meeting', 'class-summary', 'interview'];
  const featured = featuredValues
    .map(v => templateOptions.find(t => t.value === v))
    .filter(Boolean);
  if (featured.length === 0) {
    container.innerHTML = '<div style="font-size:11px;opacity:0.5;padding:4px">暂无模板</div>';
    return;
  }
  container.innerHTML = featured.map(t => {
    const sel = t.value === selectedTemplate ? ' selected' : '';
    return '<div class="template-card' + sel + '" data-value="' + t.value + '">' +
      '<div class="card-name">' + t.label + '</div>' +
      '<div class="card-desc">' + (t.description || '') + '</div>' +
      '</div>';
  }).join('');
  container.querySelectorAll('.template-card').forEach(card => {
    card.addEventListener('click', () => {
      selectedTemplate = card.dataset.value;
      window._selectedCustomTemplate = null;
      container.querySelectorAll('.template-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
    });
  });
}
// Call on load
initTemplateCards();

// ---- Template modal ----
const modalOverlay = document.getElementById('template-modal-overlay');
const modalContent = document.getElementById('template-modal');
let customTemplates = [];       // user-created custom templates
let modalActiveCat = '通用';    // active category in modal

const MODAL_CATEGORIES = [
  { key: '通用', label: '通用', types: ['通用', '商务会议'] },
  { key: '教育', label: '教育', types: ['课堂总结', '学术交流', '读书笔记', '论文研讨'] },
  { key: '采访', label: '采访', types: ['访谈记录', '新闻采访', '用户调研'] },
  { key: '销售', label: '销售', types: ['销售会议', '客户沟通', '商务谈判'] },
  { key: '政务', label: '政务', types: ['政务会议', '政策解读', '党建学习'] },
  { key: '产品开发', label: '产品开发', types: ['产品评审', '技术方案', '迭代回顾'] },
  { key: '自定义', label: '自定义', types: [] },
];

function getTemplatesByCategory(catLabel) {
  if (catLabel === '自定义') {
    return customTemplates.map((t, i) => ({
      value: 'custom', label: t.name, description: t.description, category: '自定义', _idx: i
    }));
  }
  return templateOptions.filter(t => t.category === catLabel);
}

function renderModal() {
  if (customTemplates.length === 0 && window._initialCustomTemplates) {
    customTemplates = window._initialCustomTemplates;
  }
  // Determine initial active category from currently selected template
  const selOpt = templateOptions.find(t => t.value === selectedTemplate);
  modalActiveCat = selOpt ? (selOpt.category || '通用') : '通用';

  let html = '<h3>📋 选择总结模板</h3>';

  // Category tabs
  html += '<div class="category-tabs" id="cat-tabs">';
  MODAL_CATEGORIES.forEach(cat => {
    html += '<button class="cat-tab' + (cat.label === modalActiveCat ? ' active' : '') + '" data-cat="' + cat.label + '">' + cat.label + '</button>';
  });
  html += '</div>';

  // Template grid area
  html += '<div id="tpl-grid-area"></div>';

  // Custom template form (hidden by default)
  html += '<div class="custom-tpl-form" id="custom-tpl-form">' +
    '<label style="font-size:11px;font-weight:600">模板名称</label>' +
    '<input type="text" id="custom-tpl-name" placeholder="输入自定义模板名称">' +
    '<label style="font-size:11px;font-weight:600">System Prompt</label>' +
    '<textarea id="custom-tpl-prompt" placeholder="输入自定义 Prompt，描述总结要求和输出格式..."></textarea>' +
    '<div style="display:flex;gap:6px">' +
    '<button id="custom-tpl-save" style="flex:1;padding:5px;font-size:11px;background:var(--btn-bg);color:var(--btn-fg);border:none;border-radius:4px;cursor:pointer">💾 保存自定义模板</button>' +
    '<button id="custom-tpl-cancel" style="flex:1;padding:5px;font-size:11px;background:var(--btn-secondary-bg);color:var(--btn-secondary-fg);border:none;border-radius:4px;cursor:pointer">取消</button>' +
    '</div></div>';

  // Confirm button
  html += '<button class="modal-close" id="modal-close">确认选择</button>';
  html += '<button id="template-modal-close" style="position:absolute;top:10px;right:10px;font-size:18px;padding:0 6px;cursor:pointer;border:none;background:none;color:var(--vscode-foreground,#ccc);opacity:0.5;line-height:1" title="关闭">✕</button>';
  modalContent.innerHTML = html;

  // Render grid for active category
  renderTplGrid();

  // Category tab clicks
  modalContent.querySelectorAll('.cat-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      modalActiveCat = tab.dataset.cat;
      modalContent.querySelectorAll('.cat-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('custom-tpl-form').classList.remove('show');
      renderTplGrid();
    });
  });

  // Close button (✕)
  const tplCloseBtn = modalContent.querySelector('#template-modal-close');
  if (tplCloseBtn) tplCloseBtn.addEventListener('click', () => modalOverlay.classList.remove('show'));

  // Confirm close
  modalContent.querySelector('#modal-close').addEventListener('click', () => {
    modalOverlay.classList.remove('show');
    initTemplateCards();
  });
}

function renderTplGrid() {
  const area = document.getElementById('tpl-grid-area');
  if (!area) return;
  const form = document.getElementById('custom-tpl-form');
  form.classList.remove('show');

  if (modalActiveCat === '自定义') {
    let gridHtml = '<div class="template-grid">';
    // Show saved custom templates
    customTemplates.forEach((t, i) => {
      const sel = selectedTemplate === 'custom' && t.name === (templateOptions.find(o => o.value === 'custom' && o.label === t.name) || {}).label ? ' selected' : '';
      gridHtml += '<div class="tpl-chip custom-tpl-chip' + sel + '" data-custom-idx="' + i + '">' +
        '<div class="chip-name">' + t.name + '</div>' +
        '<div class="chip-desc">' + (t.description || '') + '</div>' +
        '<div class="tpl-actions"><span class="tpl-config" data-idx="' + i + '">⚙</span><span class="tpl-delete" data-idx="' + i + '">×</span></div>' +
        '</div>';
    });
    // Add "+" card to create new
    gridHtml += '<div class="tpl-chip" id="btn-new-custom" style="border-style:dashed">➕ 新建自定义模板</div>';
    gridHtml += '</div>';
    area.innerHTML = gridHtml;

    // Click existing custom template to select
    area.querySelectorAll('.custom-tpl-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        area.querySelectorAll('.tpl-chip').forEach(c => c.classList.remove('selected'));
        chip.classList.add('selected');
        const idx = parseInt(chip.dataset.customIdx);
        const t = customTemplates[idx];
        selectedTemplate = 'custom';
        // Store reference to this specific custom template
        window._selectedCustomTemplate = t;
      });
    });

    // Config icon click → populate form for editing
    area.querySelectorAll('.tpl-config').forEach(cfg => {
      cfg.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(cfg.dataset.idx);
        const t = customTemplates[idx];
        document.getElementById('custom-tpl-name').value = t.name || '';
        document.getElementById('custom-tpl-prompt').value = t.systemPrompt || '';
        window._editingCustomTplIdx = idx;
        document.getElementById('custom-tpl-save').textContent = '💾 更新模板';
        form.classList.add('show');
      });
    });

    // Delete icon click → remove custom template
    area.querySelectorAll('.tpl-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx);
        const t = customTemplates[idx];
        customTemplates.splice(idx, 1);
        // Remove from templateOptions
        const optIdx = templateOptions.findIndex(o => o.value === 'custom' && o.label === t.name);
        if (optIdx !== -1) templateOptions.splice(optIdx, 1);
        if (selectedTemplate === 'custom' && window._selectedCustomTemplate && window._selectedCustomTemplate.name === t.name) {
          selectedTemplate = 'general';
          window._selectedCustomTemplate = null;
        }
        renderTplGrid();
        vscode.postMessage({ type: 'deleteCustomTemplate', templateName: t.name });
      });
    });

    // Click "+" to show form
    const btnNew = document.getElementById('btn-new-custom');
    if (btnNew) {
      btnNew.addEventListener('click', () => {
        document.getElementById('custom-tpl-name').value = '';
        document.getElementById('custom-tpl-prompt').value = '';
        window._editingCustomTplIdx = null;
        document.getElementById('custom-tpl-save').textContent = '💾 保存自定义模板';
        form.classList.add('show');
        document.getElementById('custom-tpl-name').focus();
      });
    }

    // Save custom template
    document.getElementById('custom-tpl-save').onclick = () => {
      const name = document.getElementById('custom-tpl-name').value.trim();
      const prompt = document.getElementById('custom-tpl-prompt').value.trim();
      if (!name || !prompt) return;
      const tpl = { name, description: prompt.slice(0, 50) + '...', systemPrompt: prompt, outputFormat: '' };
      const editIdx = window._editingCustomTplIdx;
      if (editIdx !== undefined && editIdx !== null && customTemplates[editIdx]) {
        // Update existing template
        const oldName = customTemplates[editIdx].name;
        customTemplates[editIdx] = tpl;
        // Update templateOptions
        const optIdx = templateOptions.findIndex(o => o.value === 'custom' && o.label === oldName);
        if (optIdx !== -1) templateOptions[optIdx] = { value: 'custom', label: name, description: tpl.description, category: '自定义' };
        window._editingCustomTplIdx = null;
        document.getElementById('custom-tpl-save').textContent = '💾 保存自定义模板';
        vscode.postMessage({ type: 'updateCustomTemplate', oldName, template: tpl });
      } else {
        customTemplates.push(tpl);
        templateOptions.push({ value: 'custom', label: name, description: tpl.description, category: '自定义' });
        vscode.postMessage({ type: 'addCustomTemplate', template: tpl });
      }
      document.getElementById('custom-tpl-name').value = '';
      document.getElementById('custom-tpl-prompt').value = '';
      form.classList.remove('show');
      selectedTemplate = 'custom';
      window._selectedCustomTemplate = tpl;
      renderTplGrid();
    };

    document.getElementById('custom-tpl-cancel').onclick = () => {
      form.classList.remove('show');
    };
  } else {
    // Built-in category
    const tmpls = getTemplatesByCategory(modalActiveCat);
    let gridHtml = '<div class="template-grid">';
    tmpls.forEach(t => {
      const sel = selectedTemplate === t.value ? ' selected' : '';
      gridHtml += '<div class="tpl-chip' + sel + '" data-value="' + t.value + '">' +
        '<div class="chip-name">' + t.label + '</div>' +
        '<div class="chip-desc">' + (t.description || '') + '</div>' +
        '</div>';
    });
    gridHtml += '</div>';
    area.innerHTML = gridHtml;

    // Click chip to select
    area.querySelectorAll('.tpl-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        area.querySelectorAll('.tpl-chip').forEach(c => c.classList.remove('selected'));
        chip.classList.add('selected');
        selectedTemplate = chip.dataset.value;
        window._selectedCustomTemplate = null;
      });
    });
  }
}

function showVoicefixModal() {
  const overlay = document.getElementById('voicefix-modal-overlay');
  const container = document.getElementById('voicefix-segments');
  const subtitle = document.getElementById('voicefix-subtitle');
  const actions = document.getElementById('voicefix-actions');

  overlay.classList.add('show');
  container.innerHTML = '<div style="text-align:center;padding:20px"><span class="spinner"></span> 正在进行声纹匹配…</div>';
  subtitle.textContent = '通过声纹比对自动识别说话人身份';
  actions.style.display = 'none';

  // Close button
  document.getElementById('voicefix-modal-close').onclick = () => overlay.classList.remove('show');
  document.getElementById('voicefix-close-btn').onclick = () => overlay.classList.remove('show');
  overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.remove('show'); };

  vscode.postMessage({ type: 'voicefixMatch' });
}

function showVoicefixResult(matched, matchList) {
  const container = document.getElementById('voicefix-segments');
  const subtitle = document.getElementById('voicefix-subtitle');
  const actions = document.getElementById('voicefix-actions');
  subtitle.textContent = '声纹匹配完成，已识别 ' + matched + ' 个说话人';
  container.innerHTML = '<div style="text-align:center;padding:12px;font-size:13px;line-height:1.8">✅ ' +
    matchList.replace(/、/g, '<br>✅ ') + '</div>';
  actions.style.display = 'flex';
}

function showVoicefixError(msg) {
  const container = document.getElementById('voicefix-segments');
  const subtitle = document.getElementById('voicefix-subtitle');
  const actions = document.getElementById('voicefix-actions');
  subtitle.textContent = '声纹匹配失败';
  container.innerHTML = '<div style="text-align:center;padding:12px;font-size:13px;color:var(--vscode-errorForeground,#f44747)">❌ ' +
    msg + '</div>';
  actions.style.display = 'flex';
}

function renderMarkdown(md) {
  var html = md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Code blocks
  html = html.replace(/\x60\x60\x60(\\w*)\\n([\\s\\S]*?)\x60\x60\x60/g, function(_, lang, code) {
    return '<pre style="background:var(--code-bg,#1e1e1e);color:var(--code-fg,#d4d4d4);padding:12px;border-radius:6px;overflow-x:auto;font-size:12px;line-height:1.5"><code>' + code.trim() + '</code></pre>';
  });
  // Inline code
  html = html.replace(/\x60([^\x60]+)\x60/g, '<code style="background:var(--code-bg,#333);padding:1px 4px;border-radius:3px;font-size:11px">$1</code>');
  // Headings
  html = html.replace(/^#### (.+)$/gm, '<h4 style="margin:12px 0 6px">$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3 style="margin:14px 0 6px">$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2 style="margin:16px 0 8px;border-bottom:1px solid var(--border,#444);padding-bottom:4px">$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1 style="margin:18px 0 10px">$1</h1>');
  // Bold
  html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  // Tables
  html = html.replace(/^\\|(.+)\\|$/gm, function(line) {
    if (/\\|[-:]+\\|/.test(line)) return '';
    var cells = line.split('|').filter(function(c) { return c.trim(); });
    return '<tr>' + cells.map(function(c) {
      return '<td style="border:1px solid var(--border,#555);padding:4px 8px;font-size:11px">' + c.trim() + '</td>';
    }).join('') + '</tr>';
  });
  html = html.replace(/((?:<tr>[\\s\\S]*?<\\/tr>\\s*)+)/g, '<table style="border-collapse:collapse;margin:8px 0;width:100%"><tbody>$1</tbody></table>');
  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr style="border:none;border-top:1px solid var(--border,#444);margin:12px 0">');
  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li style="margin:2px 0">$1</li>');
  html = html.replace(/((?:<li[^>]*>[\\s\\S]*?<\\/li>\\s*)+)/g, '<ul style="padding-left:20px;margin:4px 0">$1</ul>');
  // Paragraphs
  html = '<div>' + html + '</div>';
  html = html.replace(/\\n\\n+/g, '</div><div style="margin:8px 0">');
  html = html.replace(/\\n/g, '<br>');
  return html;
}

document.getElementById('btn-more-templates').addEventListener('click', () => {
  renderModal();
  modalOverlay.classList.add('show');
});
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) modalOverlay.classList.remove('show');
});
document.getElementById('template-modal-close').addEventListener('click', () => {
  modalOverlay.classList.remove('show');
});

// ---- Audio list ----
function renderAudioList() {
  const list = document.getElementById('mp3-list');
  const all = [...new Set(detectedUrls)];
  if (all.length === 0) {
    list.innerHTML = '<div class="no-audio">未检测到音频来源 — 请在 Markdown 文件 frontmatter 中添加 audio_url 后刷新</div>';
    document.getElementById('btn-start').disabled = true;
    return;
  }
  if (selectedUrls.length === 0) selectedUrls = [...all];
  list.innerHTML = all.map(u => {
    const checked = selectedUrls.includes(u) ? ' checked' : '';
    let localPath = '';
    for (const k of Object.keys(downloadPathsMap)) {
      if (k.includes(u.split('/').pop()?.split('?')[0] || '') || k === u) {
        localPath = downloadPathsMap[k];
        break;
      }
    }
    const dlError = downloadErrors[u] || '';
    return '<div class="audio-row" data-url="' + u.replace(/"/g, '&quot;') + '">' +
      '<div class="check' + checked + '"></div>' +
      '<span class="name' + (selectedUrls.includes(u) ? ' selected' : '') + '" title="' + u.replace(/"/g, '&quot;') + '">' + u + '</span>' +
      (localPath ? '<span class="dl-path" title="' + localPath.replace(/"/g, '&quot;') + '">📁 下载地址：' + localPath + '</span>' : '') +
      (dlError ? '<span class="dl-error">⚠️ ' + dlError + '</span>' : '') +
      '</div>';
  }).join('');
  list.querySelectorAll('.audio-row').forEach(row => {
    row.addEventListener('click', () => {
      const url = row.dataset.url;
      if (selectedUrls.includes(url)) {
        selectedUrls = selectedUrls.filter(u => u !== url);
      } else {
        selectedUrls.push(url);
      }
      renderAudioList();
      document.getElementById('btn-start').disabled = selectedUrls.length === 0;
    });
  });
  document.getElementById('btn-start').disabled = false;
}

// ---- Progress ----
function resetSteps() {
  for (let i = 0; i < 4; i++) {
    const s = document.getElementById('step-' + i);
    if (s) { s.classList.remove('active', 'done'); }
  }
  for (let i = 0; i < 3; i++) {
    const l = document.getElementById('line-' + i);
    if (l) { l.classList.remove('done'); }
  }
}
function setStep(index, done) {
  const s = document.getElementById('step-' + index);
  if (s) {
    s.classList.add(done ? 'done' : 'active');
    if (!done) s.classList.remove('done');
  }
  if (done && index < 3) {
    const l = document.getElementById('line-' + index);
    if (l) l.classList.add('done');
  }
}

// ---- Primary action ----
document.getElementById('btn-start').addEventListener('click', () => {
  if (selectedUrls.length === 0) {
    showProcessError('请先选择至少一个音频来源');
    return;
  }
  processing = true;
  clearProcessError();
  document.getElementById('btn-start').disabled = true;
  resetSteps();
  vscode.postMessage({
    type: 'startProcess',
    mp3Urls: selectedUrls,
    templateType: selectedTemplate,
    customPrompt: getCustomPrompt(),
  });
});

// ---- Secondary actions ----
let lastTranscript = [];
function disableSecondaryButtons() {
  document.getElementById('btn-retranscribe').disabled = true;
  document.getElementById('btn-resummarize').disabled = true;
  document.getElementById('btn-voicefix').disabled = true;
  document.getElementById('btn-voiceprint').disabled = true;
}
document.getElementById('btn-retranscribe').addEventListener('click', () => {
  disableSecondaryButtons();
  vscode.postMessage({
    type: 'retranscribe',
    mp3Urls: selectedUrls,
    templateType: selectedTemplate,
    customPrompt: getCustomPrompt(),
  });
});

document.getElementById('btn-resummarize').addEventListener('click', () => {
  // Show template selector modal, then resummarize
  renderModal();
  modalOverlay.classList.add('show');
  // Override modal close to trigger resummarize instead
  const origClose = document.getElementById('modal-close');
  if (origClose) {
    origClose.textContent = '选择模板并重新总结';
    origClose.onclick = () => {
      modalOverlay.classList.remove('show');
      initTemplateCards();
      disableSecondaryButtons();
      vscode.postMessage({
        type: 'resummarize',
        templateType: selectedTemplate,
        customPrompt: getCustomPrompt(),
      });
      // Restore original close behavior
      origClose.textContent = '确认选择';
      origClose.onclick = () => {
        modalOverlay.classList.remove('show');
        initTemplateCards();
      };
    };
  }
});

document.getElementById('btn-voicefix').addEventListener('click', () => {
  const editor = document.getElementById('source-file');
  if (!editor || editor.textContent.includes('⚠️') && !editor.textContent.includes('已有转录')) {
    showProcessError('请先打开包含逐字稿的 Markdown 文件');
    return;
  }
  document.getElementById('btn-voicefix').disabled = true;
  document.getElementById('btn-voiceprint').disabled = true;
  showVoicefixModal();
});

document.getElementById('btn-voiceprint').addEventListener('click', () => {
  if (lastTranscript.length === 0) {
    showProcessError('没有可用的转录文本，请先完成转写');
    return;
  }
  showVoiceprintModal();
});

// ---- Voiceprint Sampling Modal ----
let _voiceprintSamples = [];
let _vpCurrentAudio = null;
let _vpPlayingIdx = -1; // which speaker index is currently playing

function stopVpAudio() {
  if (_vpCurrentAudio) { _vpCurrentAudio.pause(); _vpCurrentAudio = null; }
  _vpPlayingIdx = -1;
  // Update all play buttons back to ▶
  document.querySelectorAll('.vp-act-btn[data-action="play"]').forEach(b => { b.textContent = '▶'; });
}

function showVoiceprintModal() {
  const overlay = document.getElementById('voiceprint-modal-overlay');
  const container = document.getElementById('voiceprint-speakers');
  const candidateDiv = document.getElementById('voiceprint-candidate');
  candidateDiv.style.display = 'none';
  container.innerHTML = '<div style="text-align:center;padding:20px;font-size:13px">⏳ 正在分析音频并截取样本...</div>';
  overlay.classList.add('show');

  _voiceprintSamples = [];
  stopVpAudio();
  vscode.postMessage({ type: 'voiceprintExtract' });

  // Close button
  document.getElementById('voiceprint-modal-close').onclick = () => {
    stopVpAudio();
    overlay.classList.remove('show');
  };
  overlay.onclick = (e) => {
    if (e.target === overlay) { stopVpAudio(); overlay.classList.remove('show'); }
  };
}

function renderVoiceprintResults(speakers) {
  _voiceprintSamples = speakers.map(s => ({ ...s, kept: true, activeIndex: 0 }));
  const container = document.getElementById('voiceprint-speakers');

  if (speakers.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:20px;font-size:13px;opacity:0.6">未提取到有效的声纹样本</div>';
    return;
  }

  renderVpSpeakerRows();
}

function renderVpSpeakerRows() {
  const container = document.getElementById('voiceprint-speakers');
  const kept = _voiceprintSamples.filter(s => s.kept);

  container.innerHTML = kept.map((s) => {
    const origIdx = _voiceprintSamples.indexOf(s);
    const cand = s.candidates[s.activeIndex];
    const dur = cand ? cand.duration.toFixed(1) : '0.0';
    const isPlaying = _vpPlayingIdx === origIdx;
    return '<div class="vp-speaker-row" data-idx="' + origIdx + '" style="display:flex;align-items:center;gap:6px;padding:6px 8px;margin:3px 0;background:var(--card-bg);border:1px solid var(--border);border-radius:5px;font-size:12px">' +
      '<span class="vp-spk-name" data-idx="' + origIdx + '" title="点击修改名称" style="font-weight:500;min-width:70px;cursor:pointer;user-select:none">👤 ' + s.displayName + '</span>' +
      '<span style="flex:1;font-size:11px;opacity:0.7">#' + (s.activeIndex + 1) + '/' + s.candidates.length + ' · ' + dur + 's</span>' +
      '<button class="vp-act-btn" data-action="play" data-idx="' + origIdx + '" title="试听/停止" style="font-size:14px;padding:2px 6px;cursor:pointer;border:none;border-radius:3px;background:var(--btn-bg);color:var(--btn-fg);font-family:inherit">' + (isPlaying ? '■' : '▶') + '</button>' +
      (s.candidates.length > 1 ? '<button class="vp-act-btn" data-action="cycle" data-idx="' + origIdx + '" title="切换候选" style="font-size:14px;padding:2px 6px;cursor:pointer;border:none;border-radius:3px;background:var(--btn-bg);color:var(--btn-fg);font-family:inherit">🔄</button>' : '') +
      '<button class="vp-act-btn" data-action="add" data-idx="' + origIdx + '" title="添加到声纹库" style="font-size:14px;padding:2px 6px;cursor:pointer;border:none;border-radius:3px;background:var(--btn-bg);color:var(--btn-fg);font-family:inherit">＋</button>' +
      '<button class="vp-act-btn" data-action="del" data-idx="' + origIdx + '" title="移除" style="font-size:14px;padding:2px 6px;cursor:pointer;border:none;border-radius:3px;background:var(--btn-bg);color:var(--btn-fg);font-family:inherit">🗑️</button>' +
      '</div>';
  }).join('');

  // Event delegation for action buttons
  container.querySelectorAll('.vp-act-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const idx = parseInt(btn.dataset.idx);
      const sample = _voiceprintSamples[idx];
      if (!sample) return;

      if (action === 'play') {
        const cand = sample.candidates[sample.activeIndex];
        if (!cand || !cand.audioPath) return;
        if (_vpPlayingIdx === idx) {
          // Already playing this one — stop
          stopVpAudio();
          renderVpSpeakerRows();
        } else {
          // Stop any previous audio, then play
          stopVpAudio();
          _vpPlayingIdx = idx;
          vscode.postMessage({ type: 'getAudioData', path: cand.audioPath, speakerIdx: idx });
        }
      } else if (action === 'cycle') {
        sample.activeIndex = (sample.activeIndex + 1) % sample.candidates.length;
        // If this speaker was playing, stop (candidate changed)
        if (_vpPlayingIdx === idx) stopVpAudio();
        renderVpSpeakerRows();
      } else if (action === 'add') {
        const cand = sample.candidates[sample.activeIndex];
        if (cand && cand.audioPath) {
          vscode.postMessage({ type: 'saveVoiceprint', name: sample.displayName, audioSamplePath: cand.audioPath, description: sample.speakerId + ' 声纹样本' });
          if (_vpPlayingIdx === idx) stopVpAudio();
          sample.kept = false;
          renderVpSpeakerRows();
          flash('process-status', '✅ ' + sample.displayName + ' 已添加到声纹库');
          clearProcessError();
        }
      } else if (action === 'del') {
        if (_vpPlayingIdx === idx) stopVpAudio();
        sample.kept = false;
        renderVpSpeakerRows();
      }
    });
  });

  // Click name to edit (single click)
  container.querySelectorAll('.vp-spk-name').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.idx);
      const sample = _voiceprintSamples[idx];
      if (!sample) return;
      const current = el;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = sample.displayName;
      input.style.cssText = 'font-weight:500;min-width:70px;font-size:12px;font-family:inherit;padding:2px 4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--btn-bg);border-radius:3px';
      current.replaceWith(input);
      input.focus();
      input.select();
      const commit = () => {
        const val = input.value.trim();
        if (val) sample.displayName = val;
        renderVpSpeakerRows();
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') renderVpSpeakerRows(); });
    });
  });
}

function showVoiceprintError(msg) {
  document.getElementById('voiceprint-speakers').innerHTML = '<div style="color:var(--vscode-errorForeground);text-align:center;padding:20px;font-size:13px">❌ ' + msg.replace(/</g, '&lt;') + '</div>';
}

// "重新采样" button
document.getElementById('voiceprint-resample').addEventListener('click', () => {
  stopVpAudio();
  showVoiceprintModal();
});

// ---- Save settings ----
function saveAllSettings() {
  vscode.postMessage({ type: 'saveSettings', settings: {
    asr: {
      protocol: getVal('setting-asr-protocol') || getVal('setting-asr-provider'),
      apiKey: getVal('setting-asr-apikey'),
      apiUrl: getVal('setting-asr-apiurl') || getVal('setting-asr-custom-apiurl'),
      model: getVal('setting-asr-custom-model'),
      language: getVal('setting-asr-language') || getVal('setting-asr-custom-language'),
      secretKey: getVal('setting-asr-apisecret'),
      appId: getVal('setting-asr-appid'),
      region: getVal('setting-asr-region'),
    },
    speaker: {
      modelType: getVal('setting-speaker-type'), customEndpoint: getVal('setting-speaker-endpoint'),
      apiKey: getVal('setting-speaker-apikey'),
    },
    llm: {
      provider: getVal('setting-llm-provider'), apiKey: getVal('setting-llm-apikey') || getVal('setting-llm-custom-apikey'),
      apiUrl: getVal('setting-llm-apiurl') || getVal('setting-llm-custom-apiurl'), model: getVal('setting-llm-model') || getVal('setting-llm-custom-model'),
      maxTokens: parseInt(getVal('setting-llm-maxtokens')) || parseInt(getVal('setting-llm-custom-maxtokens')) || 4096,
      temperature: parseFloat(getVal('setting-llm-temp')) || parseFloat(getVal('setting-llm-custom-temp')) || 0.7,
    },
    hotWords: hotWords,
    industry: getVal('setting-industry'),
    voiceprintLibrary: voiceprintLibrary,
  }});
}
function getVal(id) { const el = document.getElementById(id); return el ? el.value : ''; }
function setVal(id, v, fb) { const el = document.getElementById(id); if (el && v !== undefined && v !== null) el.value = v; else if (el && fb !== undefined) el.value = fb; }
function setCheck(id, v) { const el = document.getElementById(id); if (el) el.checked = !!v; }

function showProcessError(msg) {
  const el = document.getElementById('error-msg');
  el.textContent = msg;
  el.style.display = 'block';
}
function clearProcessError() {
  const el = document.getElementById('error-msg');
  el.textContent = '';
  el.style.display = 'none';
}
function flash(id, msg) { document.getElementById(id).textContent = msg; setTimeout(() => document.getElementById(id).textContent = '', 2000); }

// ASR page navigation
function showAsrList() {
  document.getElementById('asr-page-add').style.display = 'none';
  document.getElementById('asr-page-list').style.display = 'block';
}
document.getElementById('btn-open-asr-add').addEventListener('click', () => {
  document.getElementById('asr-page-list').style.display = 'none';
  document.getElementById('asr-page-add').style.display = 'block';
  // Reset to provider tab
  switchAsrTab('provider');
});
document.getElementById('btn-cancel-asr').addEventListener('click', () => {
  window._editingAsrModelId = null;
  document.getElementById('btn-save-asr').textContent = '💾 保存模型';
  showAsrList();
});

// ASR tab switching
let _asrActiveTab = 'provider';
function switchAsrTab(tab) {
  _asrActiveTab = tab;
  document.getElementById('asr-tab-provider').classList.toggle('active', tab === 'provider');
  document.getElementById('asr-tab-custom').classList.toggle('active', tab === 'custom');
  document.getElementById('asr-panel-provider').style.display = tab === 'provider' ? '' : 'none';
  document.getElementById('asr-panel-custom').style.display = tab === 'custom' ? '' : 'none';
  if (tab === 'provider') updateAsrProviderFields();
}
document.getElementById('asr-tab-provider').addEventListener('click', () => switchAsrTab('provider'));
document.getElementById('asr-tab-custom').addEventListener('click', () => switchAsrTab('custom'));

// Dynamic ASR provider fields
const ASR_PROVIDER_CONFIG = {
  'openai-whisper':   { appid:0, apikey:'API Key', apisecret:0, region:0 },
  'volcengine':       { appid:0, apikey:'Access Token (x-api-key)', apisecret:0, resourceid:'Resource ID', region:0 },
  'aliyun-dashscope': { appid:0, apikey:'API Key (DashScope)', apisecret:0, region:0 },
  'xunfei':           { appid:'APP ID', apikey:'API Key (accessKeyId)', apisecret:'API Secret', region:0 },
  'tencent':          { appid:'APP ID', apikey:'SecretId', apisecret:'SecretKey', region:0 },
  'baidu':            { appid:0, apikey:'API Key', apisecret:'Secret Key', region:0 },
  'huawei':           { appid:0, apikey:'Access Key (AK)', apisecret:'Secret Access Key (SK)', region:0 },
  'azure':            { appid:0, apikey:'API Key', apisecret:0, region:'Region' },
  'google':           { appid:0, apikey:'API Key', apisecret:0, region:0 },
  'aws':              { appid:0, apikey:'Access Key ID', apisecret:'Secret Access Key', region:'Region' },
};

function updateAsrProviderFields() {
  const provider = getVal('setting-asr-provider');
  const cfg = ASR_PROVIDER_CONFIG[provider] || ASR_PROVIDER_CONFIG['openai-whisper'];
  // Show/hide and update labels for each dynamic field
  ['apikey', 'appid', 'apisecret', 'resourceid', 'region'].forEach(field => {
    const fieldEl = document.getElementById('asr-field-' + field);
    const labelEl = document.getElementById('asr-label-' + field);
    const label = cfg[field];
    if (label) {
      fieldEl.style.display = '';
      labelEl.textContent = label;
    } else {
      fieldEl.style.display = 'none';
    }
  });
  // Update API URL placeholder based on provider
  const apiUrlEl = document.getElementById('setting-asr-apiurl');
  const apiUrlDefaults = {
    'openai-whisper': 'https://api.openai.com/v1/audio/transcriptions',
    'volcengine': 'https://openspeech.bytedance.com/api/v3/auc/bigmodel',
    'aliyun-dashscope': 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription',
    'xunfei': 'https://office-api-ist-dx.iflyaisol.com',
    'tencent': 'https://asr.tencentcloudapi.com',
    'baidu': 'https://vop.baidu.com/server_api',
    'huawei': 'https://sis-ext.cn-north-4.myhuaweicloud.com/v1/ocr/voice',
    'azure': 'https://<region>.api.cognitive.microsoft.com/speechtotext/v3.0',
    'google': 'https://speech.googleapis.com/v1/speech:recognize',
    'aws': 'https://transcribe.<region>.amazonaws.com',
  };
  apiUrlEl.placeholder = apiUrlDefaults[provider] || '端点地址';
}
document.getElementById('setting-asr-provider').addEventListener('change', updateAsrProviderFields);

// ASR advanced config toggles
['provider', 'custom'].forEach(type => {
  document.getElementById('asr-adv-toggle-' + type).addEventListener('click', function() {
    this.classList.toggle('open');
    const panel = document.getElementById('asr-adv-panel-' + type);
    panel.style.display = panel.style.display === 'none' ? '' : 'none';
  });
});

// Add ASR model (updated for provider/custom tabs)
document.getElementById('btn-save-asr').addEventListener('click', () => {
  const editingId = window._editingAsrModelId;
  const isEdit = !!editingId;
  if (_asrActiveTab === 'provider') {
    const provider = getVal('setting-asr-provider');
    const displayName = getVal('setting-asr-displayname') || getVal('setting-asr-provider');
    const providerSelect = document.getElementById('setting-asr-provider');
    const modelData = {
      id: isEdit ? editingId : 'asr-' + Date.now(),
      displayName: displayName,
      protocol: provider,
      apiKey: getVal('setting-asr-apikey'),
      secretKey: getVal('setting-asr-apisecret'),
      appId: getVal('setting-asr-appid'),
      resourceId: getVal('setting-asr-resourceid'),
      region: getVal('setting-asr-region'),
      apiUrl: getVal('setting-asr-apiurl'),
      model: provider === 'openai-whisper' ? 'whisper-1' : '',
      language: getVal('setting-asr-language'),
      preset: providerSelect ? providerSelect.selectedOptions[0].textContent : provider,
      speakerDiarization: document.getElementById('setting-asr-diarization').checked,
      asrType: 'provider',
    };
    vscode.postMessage({ type: isEdit ? 'updateAsrModel' : 'addAsrModel', model: modelData });
    flash('asr-saved-msg', isEdit ? '✅ 模型已更新' : '✅ 模型已添加');
  } else {
    const displayName = getVal('setting-asr-custom-displayname');
    const protocol = getVal('setting-asr-protocol');
    if (!displayName) { flash('asr-saved-msg', '请输入展示名称'); return; }
    const protocolSelect = document.getElementById('setting-asr-protocol');
    const modelData = {
      id: isEdit ? editingId : 'asr-' + Date.now(),
      displayName: displayName,
      protocol: protocol,
      apiKey: '',
      secretKey: '',
      apiUrl: getVal('setting-asr-custom-apiurl'),
      model: getVal('setting-asr-custom-model'),
      language: getVal('setting-asr-custom-language'),
      preset: protocolSelect ? protocolSelect.selectedOptions[0].textContent : protocol,
      speakerDiarization: document.getElementById('setting-asr-custom-diarization').checked,
      asrType: 'custom',
    };
    vscode.postMessage({ type: isEdit ? 'updateAsrModel' : 'addAsrModel', model: modelData });
    flash('asr-saved-msg', isEdit ? '✅ 模型已更新' : '✅ 模型已添加');
  }
  // Reset editing state and go back to list
  window._editingAsrModelId = null;
  document.getElementById('btn-save-asr').textContent = '💾 保存模型';
  setVal('setting-asr-apikey', ''); setVal('setting-asr-appid', '');
  setVal('setting-asr-apisecret', ''); setVal('setting-asr-resourceid', ''); setVal('setting-asr-region', '');
  setVal('setting-asr-apiurl', ''); setVal('setting-asr-displayname', '');
  document.getElementById('setting-asr-diarization').checked = false;
  showAsrList();
});

// LLM page navigation
function showLlmList() {
  document.getElementById('llm-page-add').style.display = 'none';
  document.getElementById('llm-page-list').style.display = 'block';
}
document.getElementById('btn-open-llm-add').addEventListener('click', () => {
  document.getElementById('llm-page-list').style.display = 'none';
  document.getElementById('llm-page-add').style.display = 'block';
  switchLlmTab('provider');
});
document.getElementById('btn-cancel-llm').addEventListener('click', () => {
  window._editingLlmModelId = null;
  document.getElementById('btn-save-llm').textContent = '💾 保存模型';
  showLlmList();
});

// LLM tab switching
let _llmActiveTab = 'provider';
function switchLlmTab(tab) {
  _llmActiveTab = tab;
  document.getElementById('llm-tab-provider').classList.toggle('active', tab === 'provider');
  document.getElementById('llm-tab-custom').classList.toggle('active', tab === 'custom');
  document.getElementById('llm-panel-provider').style.display = tab === 'provider' ? '' : 'none';
  document.getElementById('llm-panel-custom').style.display = tab === 'custom' ? '' : 'none';
}
document.getElementById('llm-tab-provider').addEventListener('click', () => switchLlmTab('provider'));
document.getElementById('llm-tab-custom').addEventListener('click', () => switchLlmTab('custom'));

// LLM advanced config toggles
['provider', 'custom'].forEach(type => {
  document.getElementById('llm-adv-toggle-' + type).addEventListener('click', function() {
    this.classList.toggle('open');
    const panel = document.getElementById('llm-adv-panel-' + type);
    panel.style.display = panel.style.display === 'none' ? '' : 'none';
  });
});

// LLM model dropdown - update models when provider changes
const LLM_PROVIDER_MODELS = {
  'anthropic': [
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { value: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
    { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  ],
  'openai': [
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
    { value: 'gpt-4.1', label: 'GPT-4.1' },
  ],
  'zhipu': [
    { value: 'glm-4-plus', label: 'GLM-4 Plus' },
    { value: 'glm-4.5', label: 'GLM-4.5' },
    { value: 'glm-4-flash', label: 'GLM-4 Flash' },
    { value: 'glm-4-air', label: 'GLM-4 Air' },
    { value: 'glm-4-airx', label: 'GLM-4 AirX' },
    { value: 'glm-4-long', label: 'GLM-4 Long' },
    { value: 'glm-4', label: 'GLM-4' },
    { value: 'glm-5.1', label: 'GLM-5.1' },
    { value: 'glm-5.2', label: 'GLM-5.2' },
  ],
  'deepseek': [
    { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
    { value: 'deepseek-v3', label: 'DeepSeek V3' },
    { value: 'deepseek-r1', label: 'DeepSeek R1' },
    { value: 'deepseek-chat', label: 'DeepSeek Chat' },
    { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
  ],
  'minimax': [
    { value: 'minimax-text-01', label: 'MiniMax Text 01' },
    { value: 'minimax-m1', label: 'MiniMax M1' },
  ],
  'google': [
    { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
    { value: 'gemini-3.1-flash', label: 'Gemini 3.1 Flash' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  ],
  'aliyun': [
    { value: 'qwen3.5-122b', label: 'Qwen3.5 122B' },
    { value: 'qwen3.5-32b', label: 'Qwen3.5 32B' },
    { value: 'qwen3.5-14b', label: 'Qwen3.5 14B' },
    { value: 'qwen3-plus', label: 'Qwen3 Plus' },
    { value: 'qwen3-turbo', label: 'Qwen3 Turbo' },
    { value: 'qwen-plus', label: 'Qwen Plus' },
    { value: 'qwen-turbo', label: 'Qwen Turbo' },
  ],
  'baidu': [
    { value: 'ernie-4.0', label: 'ERNIE 4.0' },
    { value: 'ernie-4.0-turbo', label: 'ERNIE 4.0 Turbo' },
    { value: 'ernie-3.5', label: 'ERNIE 3.5' },
    { value: 'ernie-speed', label: 'ERNIE Speed' },
    { value: 'ernie-lite', label: 'ERNIE Lite' },
  ],
  'bytedance': [
    { value: 'doubao-pro-32k', label: '豆包 Pro 32K' },
    { value: 'doubao-pro-128k', label: '豆包 Pro 128K' },
    { value: 'doubao-lite-32k', label: '豆包 Lite 32K' },
    { value: 'doubao-lite-128k', label: '豆包 Lite 128K' },
  ],
  'tencent': [
    { value: 'hunyuan-4.0', label: '混元 4.0' },
    { value: 'hunyuan-turbo', label: '混元 Turbo' },
    { value: 'hunyuan-lite', label: '混元 Lite' },
    { value: 'hunyuan-standard', label: '混元 Standard' },
  ],
  'huawei': [
    { value: 'pangu-4.0', label: '盘古 4.0' },
    { value: 'pangu-3.0', label: '盘古 3.0' },
  ],
  'moonshot': [
    { value: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' },
    { value: 'kimi-k2.7-code-highspeed', label: 'Kimi K2.7 Code Highspeed' },
    { value: 'kimi-k2.6', label: 'Kimi K2.6' },
    { value: 'kimi-k2.5', label: 'Kimi K2.5' },
    { value: 'moonshot-v1-8k', label: 'Moonshot v1 8K' },
    { value: 'moonshot-v1-32k', label: 'Moonshot v1 32K' },
    { value: 'moonshot-v1-128k', label: 'Moonshot v1 128K' },
  ],
  'xunfei': [
    { value: 'spark-4.0', label: '星火 4.0' },
    { value: 'spark-3.5', label: '星火 3.5' },
    { value: 'spark-lite', label: '星火 Lite' },
    { value: 'spark-pro', label: '星火 Pro' },
  ],
  'mistral': [
    { value: 'mistral-large-2', label: 'Mistral Large 2' },
    { value: 'mistral-medium', label: 'Mistral Medium' },
    { value: 'mistral-small', label: 'Mistral Small' },
    { value: 'mistral-nemo', label: 'Mistral Nemo' },
  ],
  'meta': [
    { value: 'meta-llama/llama-3.1-405b-instruct', label: 'Llama 3.1 405B' },
    { value: 'meta-llama/llama-3.1-70b-instruct', label: 'Llama 3.1 70B' },
    { value: 'meta-llama/llama-3.1-8b-instruct', label: 'Llama 3.1 8B' },
  ],
};
document.getElementById('setting-llm-provider').addEventListener('change', function() {
  const provider = this.value;
  const modelSelect = document.getElementById('setting-llm-model');
  const models = LLM_PROVIDER_MODELS[provider] || [];
  modelSelect.innerHTML = models.length > 0
    ? models.map(m => '<option value="' + m.value + '">' + m.label + '</option>').join('')
    : '<option value="">-- 自定义输入 --</option>';
  const apiUrlEl = document.getElementById('setting-llm-apiurl');
  const LLM_PROVIDER_API_URLS = {
    'anthropic': 'https://api.anthropic.com/v1/messages',
    'openai': 'https://api.openai.com/v1/chat/completions',
    'zhipu': 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    'deepseek': 'https://api.deepseek.com/chat/completions',
    'minimax': 'https://api.minimaxi.com/v1/text/chatcompletion_v2',
    'google': 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    'aliyun': 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    'baidu': 'https://qianfan.baidubce.com/v2/chat/completions',
    'bytedance': 'https://api.doubao.com/v1/chat/completions',
    'tencent': 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions',
    'huawei': 'https://pangu.huaweicloud.com/v1/chat/completions',
    'moonshot': 'https://api.moonshot.cn/v1/chat/completions',
    'xunfei': 'https://spark-api.xfyun.cn/v3.5/chat/completions',
    'mistral': 'https://api.mistral.ai/v1/chat/completions',
    'meta': 'https://api.openrouter.ai/v1/chat/completions',
  };
  apiUrlEl.placeholder = LLM_PROVIDER_API_URLS[provider] || 'API 端点地址';
});

// Add LLM model (updated for provider/custom tabs)
document.getElementById('btn-save-llm').addEventListener('click', () => {
  const editingId = window._editingLlmModelId;
  const isEdit = !!editingId;
  if (_llmActiveTab === 'provider') {
    const provider = getVal('setting-llm-provider');
    const apiKey = getVal('setting-llm-apikey');
    if (!apiKey) { flash('llm-saved-msg', '请输入 API Key'); return; }
    const model = getVal('setting-llm-model');
    const displayName = getVal('setting-llm-displayname') || (model ? model : provider);
    const modelData = {
      id: isEdit ? editingId : 'llm-' + Date.now(),
      displayName: displayName,
      provider: provider,
      apiKey: apiKey,
      apiUrl: getVal('setting-llm-apiurl'),
      model: model,
      maxTokens: parseInt(getVal('setting-llm-maxtokens')) || 4096,
      temperature: parseFloat(getVal('setting-llm-temp')) ?? 0.7,
      contextWindow: parseInt(getVal('setting-llm-contextwindow')) || 200000,
      llmType: 'provider',
    };
    vscode.postMessage({ type: isEdit ? 'updateLlmModel' : 'addLlmModel', model: modelData });
    flash('llm-saved-msg', isEdit ? '✅ 模型已更新' : '✅ 模型已添加');
  } else {
    const apiFormat = getVal('setting-llm-api-format');
    const displayName = getVal('setting-llm-custom-displayname');
    const modelId = getVal('setting-llm-custom-model');
    if (!displayName) { flash('llm-saved-msg', '请输入展示名称'); return; }
    const modelData = {
      id: isEdit ? editingId : 'llm-' + Date.now(),
      displayName: displayName,
      provider: apiFormat,
      apiKey: getVal('setting-llm-custom-apikey'),
      apiUrl: getVal('setting-llm-custom-apiurl'),
      model: modelId,
      maxTokens: parseInt(getVal('setting-llm-custom-maxtokens')) || 4096,
      temperature: parseFloat(getVal('setting-llm-custom-temp')) ?? 0.7,
      contextWindow: parseInt(getVal('setting-llm-custom-contextwindow')) || 200000,
      llmType: 'custom',
      apiFormat: apiFormat,
    };
    vscode.postMessage({ type: isEdit ? 'updateLlmModel' : 'addLlmModel', model: modelData });
    flash('llm-saved-msg', isEdit ? '✅ 模型已更新' : '✅ 模型已添加');
  }
  // Reset editing state and go back to list
  window._editingLlmModelId = null;
  document.getElementById('btn-save-llm').textContent = '💾 保存模型';
  showLlmList();
});

document.getElementById('btn-save-hotwords').addEventListener('click', () => { saveAllSettings(); flash('hw-saved-msg', '✅ 热词已保存'); });
document.getElementById('btn-save-voiceprint').addEventListener('click', () => { saveAllSettings(); closeSettingsModal(); });

// ---- Voiceprint library (inline editing) ----
let _vpLibAudio = null;
let _vpLibPlayingIdx = -1;

function stopVpLibAudio() {
  if (_vpLibAudio) { _vpLibAudio.pause(); _vpLibAudio = null; }
  _vpLibPlayingIdx = -1;
  // Reset all library play buttons to ▶
  document.querySelectorAll('#voiceprint-library-list .vp-btn-play').forEach(b => { b.textContent = '▶'; });
}

function renderVoiceprintLibrary() {
  const container = document.getElementById('voiceprint-library-list');
  document.getElementById('voiceprint-count').textContent = voiceprintLibrary.length;
  if (voiceprintLibrary.length === 0) {
    container.innerHTML = '<div style="font-size:11px;opacity:0.5;padding:8px;text-align:center">暂无样本，点击下方按钮添加</div>';
  } else {
    container.innerHTML = voiceprintLibrary.map((vp, idx) => {
      const isPlaying = _vpLibPlayingIdx === idx;
      const hasPath = !!(vp.audioSamplePath);
      return '<div class="vp-entry" id="vp-entry-' + idx + '" style="display:flex;align-items:center;gap:6px;padding:5px 8px;margin:2px 0;background:var(--card-bg);border:1px solid var(--border);border-radius:5px;font-size:12px">' +
        '<span class="vp-name" data-idx="' + idx + '" title="点击修改姓名" style="font-weight:500;min-width:60px;cursor:pointer;user-select:none">👤 ' + (vp.name || '未命名') + '</span>' +
        '<span class="vp-path" data-idx="' + idx + '" title="点击选择音频文件，双击手动输入路径" style="flex:1;font-size:11px;opacity:0.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer">📁 ' + (vp.audioSamplePath || '(点击选择音频)') + '</span>' +
        '<button class="vp-btn vp-btn-play" data-play="' + (hasPath ? vp.audioSamplePath.replace(/"/g, '&quot;') : '') + '" data-idx="' + idx + '" style="padding:2px 6px;font-size:12px;cursor:pointer;border:none;border-radius:3px;background:var(--btn-bg);color:var(--btn-fg);font-family:inherit" title="试听/停止" ' + (hasPath ? '' : 'disabled') + '>' + (isPlaying ? '■' : '▶') + '</button>' +
        '<button class="vp-btn del" data-del="' + idx + '" style="padding:2px 6px;font-size:12px;cursor:pointer;border:none;border-radius:3px;background:var(--btn-bg);color:var(--btn-fg);font-family:inherit" title="删除">🗑️</button>' +
      '</div>';
    }).join('');

    // Click name to edit inline
    container.querySelectorAll('.vp-name').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.idx);
        const vp = voiceprintLibrary[idx];
        if (!vp) return;
        const current = el;
        const input = document.createElement('input');
        input.type = 'text'; input.value = vp.name || '';
        input.style.cssText = 'font-weight:500;min-width:60px;font-size:12px;font-family:inherit;padding:2px 4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--btn-bg);border-radius:3px';
        current.replaceWith(input);
        input.focus(); input.select();
        const commit = () => { vp.name = input.value.trim() || '未命名'; renderVoiceprintLibrary(); };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') renderVoiceprintLibrary(); });
      });
    });

    // Click path to select audio file, double-click to edit manually
    container.querySelectorAll('.vp-path').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.idx);
        vscode.postMessage({ type: 'selectVoiceprintAudio', idx });
      });
      el.addEventListener('dblclick', () => {
        const idx = parseInt(el.dataset.idx);
        const vp = voiceprintLibrary[idx];
        if (!vp) return;
        const current = el;
        const input = document.createElement('input');
        input.type = 'text'; input.value = vp.audioSamplePath || '';
        input.style.cssText = 'flex:1;font-size:11px;font-family:inherit;padding:2px 4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--btn-bg);border-radius:3px';
        current.replaceWith(input);
        input.focus(); input.select();
        const commit = () => { vp.audioSamplePath = input.value.trim(); renderVoiceprintLibrary(); };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') renderVoiceprintLibrary(); });
      });
    });

    // Play button (▶/■ toggle with getAudioData)
    container.querySelectorAll('.vp-btn-play').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(el.dataset.idx);
        const path = el.dataset.play;
        if (_vpLibPlayingIdx === idx) {
          stopVpLibAudio();
          renderVoiceprintLibrary();
        } else {
          stopVpLibAudio();
          _vpLibPlayingIdx = idx;
          vscode.postMessage({ type: 'getAudioData', path: path, speakerIdx: idx, source: 'vplib' });
        }
      });
    });

    // Delete button (two-click confirm)
    container.querySelectorAll('[data-del]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(el.dataset.del);
        const entry = document.getElementById('vp-entry-' + idx);
        if (entry) {
          if (entry.classList.contains('vp-confirm')) {
            if (_vpLibPlayingIdx === idx) stopVpLibAudio();
            voiceprintLibrary.splice(idx, 1);
            renderVoiceprintLibrary();
          } else {
            entry.classList.add('vp-confirm');
            entry.style.borderColor = 'var(--vscode-errorForeground,#f14c4c)';
            const delBtn = entry.querySelector('[data-del]');
            if (delBtn) { delBtn.textContent = '✔️ 确认'; delBtn.style.background = 'var(--vscode-errorForeground,#f14c4c)'; }
            setTimeout(() => { entry.classList.remove('vp-confirm'); renderVoiceprintLibrary(); }, 3000);
          }
        }
      });
    });
  }
}

// "添加声纹样本" — immediately adds blank entry, user edits inline
document.getElementById('btn-add-voiceprint').addEventListener('click', () => {
  voiceprintLibrary.push({ id: 'vp-' + Date.now(), name: '未命名', audioSamplePath: '', description: '' });
  renderVoiceprintLibrary();
});
// Test voiceprint service
document.getElementById('btn-test-voiceprint').addEventListener('click', () => {
  const endpoint = getVal('setting-speaker-endpoint');
  if (!endpoint) { document.getElementById('vp-test-result').textContent = '⚠️ 请先输入服务地址'; return; }
  document.getElementById('vp-test-result').textContent = '⏳ 检测中...';
  vscode.postMessage({ type: 'testVoiceprintService', endpoint: endpoint, apiKey: getVal('setting-speaker-apikey') });
});

// Voiceprint guide modal
document.getElementById('btn-voiceprint-guide').addEventListener('click', () => {
  const overlay = document.getElementById('voiceprint-guide-modal-overlay');
  const content = document.getElementById('voiceprint-guide-content');
  overlay.classList.add('show');
  content.innerHTML = '<div style="text-align:center;padding:20px"><span class="spinner"></span> 加载中...</div>';
  vscode.postMessage({ type: 'getVoiceprintGuide' });
});
document.getElementById('voiceprint-guide-close').addEventListener('click', () => {
  document.getElementById('voiceprint-guide-modal-overlay').classList.remove('show');
});
document.getElementById('voiceprint-guide-modal-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.classList.remove('show');
});
document.getElementById('voiceprint-guide-download').addEventListener('click', () => {
  vscode.postMessage({ type: 'saveVoiceprintGuide' });
});

// ASR custom guide modal
try {
  document.getElementById('btn-asr-custom-guide').addEventListener('click', () => {
    const overlay = document.getElementById('asr-guide-modal-overlay');
    document.getElementById('asr-guide-content').innerHTML = '<div style="text-align:center;padding:20px"><span class="spinner"></span> 加载中...</div>';
    overlay.classList.add('show');
    vscode.postMessage({ type: 'getAsrGuide' });
  });
  document.getElementById('asr-guide-close').addEventListener('click', () => {
    document.getElementById('asr-guide-modal-overlay').classList.remove('show');
  });
  document.getElementById('asr-guide-modal-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.remove('show');
  });
  document.getElementById('asr-guide-download').addEventListener('click', () => {
    vscode.postMessage({ type: 'saveAsrGuide' });
  });
} catch(e) {}

// ---- Hot words ----
document.getElementById('hotword-input').addEventListener('keydown', e => { if (e.key === 'Enter') addHotWord(); });
document.getElementById('btn-add-hotword').addEventListener('click', addHotWord);

function getCustomPrompt() {
  const ct = window._selectedCustomTemplate;
  return ct ? ct.systemPrompt : '';
}

function addHotWord() {
  const input = document.getElementById('hotword-input');
  const word = input.value.trim();
  if (word && !hotWords.find(h => h.word === word)) { hotWords.push({ word: word, weight: 1 }); renderHotWords(); }
  input.value = ''; input.focus();
}
function removeHotWord(word) { hotWords = hotWords.filter(h => h.word !== word); renderHotWords(); }
function renderHotWords() {
  document.getElementById('hotword-list').innerHTML = hotWords.map(h =>
    '<span class="tag">' + h.word + '<span class="remove" data-word="' + h.word + '">×</span></span>'
  ).join('');
  document.querySelectorAll('#section-hotwords .remove').forEach(el => el.addEventListener('click', e => removeHotWord(e.target.dataset.word)));
}

// ---- AI Chat ----
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
let chatLoading = false;
let chatHistory = [];

function addChatMessage(role, text) {
  const div = document.createElement('div');
  div.className = 'chat-msg ' + role;
  div.innerHTML = '<div class="chat-bubble">' + text.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\n/g, '<br>') + '</div>';
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showChatTyping() {
  const div = document.createElement('div');
  div.className = 'chat-typing';
  div.id = 'chat-typing';
  div.textContent = 'AI 小录正在思考...';
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function hideChatTyping() {
  const el = document.getElementById('chat-typing');
  if (el) el.remove();
}

function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text || chatLoading) return;
  chatLoading = true;
  addChatMessage('user', text);
  chatHistory.push({ role: 'user', content: text });
  chatInput.value = '';
  showChatTyping();
  vscode.postMessage({ type: 'chatAsk', question: text, transcript: lastTranscript, output: lastOutput, history: chatHistory });
}

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

// ---- Message handler ----
window.addEventListener('message', event => {
  const msg = event.data;
  switch (msg.type) {
    case 'state':
      if (msg.settings) {
        const s = msg.settings;
        // Model lists
        if (s.asrModels !== undefined) { asrModels = s.asrModels; renderAsrModelList(); }
        if (s.llmModels !== undefined) { llmModels = s.llmModels; renderLlmModelList(); }
        if (s.activeAsrModelId !== undefined) { activeAsrModelId = s.activeAsrModelId; updateActiveLabels(); }
        if (s.activeModelId !== undefined) { activeModelId = s.activeModelId; updateActiveLabels(); }
        // Form defaults
        setVal('setting-asr-protocol', s.asr?.protocol, 'openai-whisper');
        setVal('setting-asr-apikey', s.asr?.apiKey); setVal('setting-asr-apiurl', s.asr?.apiUrl);
        setVal('setting-asr-model', s.asr?.model); setVal('setting-asr-language', s.asr?.language, 'zh');
        setVal('setting-asr-provider', s.asr?.protocol, 'openai-whisper');
        setVal('setting-asr-appid', s.asr?.appId);
        setVal('setting-asr-apisecret', s.asr?.secretKey);
        setVal('setting-asr-region', s.asr?.region);
        setVal('setting-asr-custom-displayname', s.asr?.displayName);
        setVal('setting-asr-custom-apiurl', s.asr?.apiUrl);
        setVal('setting-asr-custom-model', s.asr?.model);
        setVal('setting-asr-custom-language', s.asr?.language, 'zh');
        if (s.asr?.speakerDiarization !== undefined) {
          const diarEl = document.getElementById('setting-asr-diarization');
          if (diarEl) diarEl.checked = s.asr.speakerDiarization;
          const diarEl2 = document.getElementById('setting-asr-custom-diarization');
          if (diarEl2) diarEl2.checked = s.asr.speakerDiarization;
        }
        // Update dynamic provider fields after setting values
        if (typeof updateAsrProviderFields === 'function') updateAsrProviderFields();
        setVal('setting-llm-provider', s.llm?.provider, 'anthropic');
        setVal('setting-llm-apikey', s.llm?.apiKey); setVal('setting-llm-apiurl', s.llm?.apiUrl);
        setVal('setting-llm-model', s.llm?.model); setVal('setting-llm-maxtokens', s.llm?.maxTokens, 4096);
        setVal('setting-llm-temp', s.llm?.temperature, 0.7);
        setVal('setting-llm-contextwindow', s.llm?.contextWindow, 200000);
        setVal('setting-llm-custom-apikey', s.llm?.apiKey); setVal('setting-llm-custom-apiurl', s.llm?.apiUrl);
        setVal('setting-llm-custom-model', s.llm?.model);
        setVal('setting-llm-custom-displayname', s.llm?.displayName);
        setVal('setting-llm-custom-maxtokens', s.llm?.maxTokens, 4096);
        setVal('setting-llm-custom-temp', s.llm?.temperature, 0.7);
        setVal('setting-llm-custom-contextwindow', s.llm?.contextWindow, 200000);
        setVal('setting-llm-api-format', s.llm?.apiFormat, 'openai-chat');
        setVal('setting-speaker-type', s.speaker?.modelType, 'builtin');
        setVal('setting-speaker-endpoint', s.speaker?.customEndpoint);
        setVal('setting-speaker-apikey', s.speaker?.apiKey);
        voiceprintLibrary = s.voiceprintLibrary || [];
        document.getElementById('voiceprint-count').textContent = voiceprintLibrary.length;
        renderVoiceprintLibrary();
        hotWords = s.hotWords || []; renderHotWords();
        setVal('setting-industry', s.industry, '');
        // Active model names
        if (s.activeAsrModelName) document.getElementById('lbl-asr-model').textContent = s.activeAsrModelName;
        if (s.activeLLMModelName) document.getElementById('lbl-llm-model').textContent = s.activeLLMModelName;
      }
      if (msg.templates) {
        templateOptions = msg.templates;
        initTemplateCards();
      }
      if (msg.customTemplates) {
        customTemplates = msg.customTemplates;
        window._initialCustomTemplates = msg.customTemplates;
      }
      break;

    case 'mp3Result':
      detectedUrls = [...new Set([...(msg.urls || []), ...(msg.files || [])])];
      const fname = msg.sourceFile || '';
      // Store pre-existing download paths from refresh
      if (msg.downloadPaths && msg.downloadPaths.length > 0) {
        for (const p of msg.downloadPaths) {
          downloadPathsMap[p] = p;
        }
      }
      if (msg.hasTranscript) {
        document.getElementById('btn-retranscribe').disabled = false;
        document.getElementById('btn-resummarize').disabled = false;
        document.getElementById('btn-voicefix').disabled = false;
        document.getElementById('btn-voiceprint').disabled = false;
        if (msg.parsedTranscript && msg.parsedTranscript.length > 0) {
          lastTranscript = msg.parsedTranscript;
        }
      }
      if (detectedUrls.length > 0) {
        document.getElementById('source-file').innerHTML = '📄 <b>' + fname + '</b> — 检测到 <b>' + detectedUrls.length + '</b> 个音频来源'
          + (msg.hasTranscript ? ' ✅ 已有转录' : '');
        selectedUrls = [...detectedUrls];
      } else if (fname && fname.endsWith('.md')) {
        document.getElementById('source-file').innerHTML = '📄 <b>' + fname + '</b> — ⚠️ 未检测到 audio_url，请在 YAML frontmatter 中添加 audio_url: <音频地址>';
      } else {
        document.getElementById('source-file').textContent = '⚠️ 请打开 Markdown 文件后点击刷新';
      }
      renderAudioList();
      break;

    case 'vpTestResult':
      document.getElementById('vp-test-result').textContent = msg.result;
      break;

    case 'voiceprintGuideContent':
      document.getElementById('voiceprint-guide-content').innerHTML = msg.error
        ? '<div style="color:var(--vscode-errorForeground,#f44747)">❌ 加载失败: ' + msg.error + '</div>'
        : renderMarkdown(msg.content);
      break;

    case 'voiceprintGuideSaved':
      // Saved notification handled by vscode.showInformationMessage on backend
      break;

    case 'asrGuideContent':
      document.getElementById('asr-guide-content').innerHTML = msg.error
        ? '<div style="color:var(--vscode-errorForeground,#f44747)">❌ 加载失败: ' + msg.error + '</div>'
        : renderMarkdown(msg.content);
      break;

    case 'asrGuideSaved':
      break;

    case 'voiceprintExtractResult':
      renderVoiceprintResults(msg.speakers);
      break;

    case 'voiceprintExtractError':
      showVoiceprintError(msg.message);
      break;

    case 'voicefixResult':
      if (msg.transcript) lastTranscript = msg.transcript;
      document.getElementById('btn-voicefix').disabled = false;
      document.getElementById('btn-voiceprint').disabled = false;
      showVoicefixResult(msg.matched?.length || 0, msg.matchList || '');
      break;

    case 'voicefixError':
      document.getElementById('btn-voicefix').disabled = false;
      document.getElementById('btn-voiceprint').disabled = false;
      showVoicefixError(msg.message);
      break;

    case 'audioData':
      if (msg.data && !msg.error) {
        const dataUrl = 'data:audio/wav;base64,' + msg.data;
        if (msg.source === 'vplib') {
          // Library playback
          stopVpLibAudio();
          const audio = new Audio(dataUrl);
          _vpLibAudio = audio;
          _vpLibPlayingIdx = msg.speakerIdx !== undefined ? msg.speakerIdx : -1;
          if (_vpLibPlayingIdx >= 0) renderVoiceprintLibrary();
          audio.play().catch(() => {});
          audio.addEventListener('ended', () => { stopVpLibAudio(); renderVoiceprintLibrary(); });
        } else {
          // Sampling modal playback
          stopVpAudio();
          const audio = new Audio(dataUrl);
          _vpCurrentAudio = audio;
          _vpPlayingIdx = msg.speakerIdx !== undefined ? msg.speakerIdx : -1;
          if (_vpPlayingIdx >= 0) {
            const btn = document.querySelector('.vp-act-btn[data-action="play"][data-idx="' + _vpPlayingIdx + '"]');
            if (btn) btn.textContent = '■';
          }
          audio.play().catch(() => {});
          audio.addEventListener('ended', () => {
            stopVpAudio();
            if (_voiceprintSamples.length > 0) renderVpSpeakerRows();
          });
        }
      }
      break;

    case 'vpSaved':
      if (msg.entry) {
        voiceprintLibrary.push(msg.entry);
        renderVoiceprintLibrary();
      }
      break;

    case 'voiceprintAudioSelected':
      if (voiceprintLibrary[msg.idx]) {
        voiceprintLibrary[msg.idx].audioSamplePath = msg.path;
        renderVoiceprintLibrary();
        flash('vp-saved-msg', '✅ 音频已选择 (' + (msg.duration || 0).toFixed(1) + 's)');
        setTimeout(() => { const el = document.getElementById('vp-saved-msg'); if (el) el.textContent = ''; }, 3000);
      }
      break;

    case 'voiceprintAudioError':
      flash('vp-saved-msg', '❌ ' + (msg.message || '选择音频失败'));
      setTimeout(() => { const el = document.getElementById('vp-saved-msg'); if (el) el.textContent = ''; }, 4000);
      break;

    case 'vpSamplesSaved':
      if (msg.count > 0) {
        flash('process-status', '✅ ' + msg.count + ' 个声纹样本已保存到声纹库');
      }
      break;

    case 'processStarted':
      resetSteps(); document.getElementById('process-status').textContent = '处理中...';
      clearProcessError();
      document.getElementById('btn-start').disabled = true;
      document.getElementById('btn-retranscribe').disabled = true;
      document.getElementById('btn-resummarize').disabled = true;
      document.getElementById('btn-voicefix').disabled = true;
      document.getElementById('btn-voiceprint').disabled = true;
      processing = true;
      break;

    case 'processProgress':
      setStep(msg.stageIndex, false);
      for (let i = 0; i < msg.stageIndex; i++) setStep(i, true);
      document.getElementById('process-status').textContent = msg.label || '处理中...';
      break;

    case 'processStatus':
      document.getElementById('process-status').textContent = msg.label || '处理中...';
      break;

    case 'processComplete':
      for (let i = 0; i < 4; i++) setStep(i, true);
      document.getElementById('process-status').textContent = '✅ 处理完成';
      lastOutput = msg.output;
      if (msg.transcript) lastTranscript = msg.transcript;
      document.getElementById('btn-start').disabled = false;
      document.getElementById('btn-retranscribe').disabled = false;
      document.getElementById('btn-resummarize').disabled = false;
      document.getElementById('btn-voicefix').disabled = false;
      document.getElementById('btn-voiceprint').disabled = false;
      processing = false;
      break;

    case 'downloadPaths':
      downloadPathsMap = {};
      downloadErrors = {};
      for (const p of (msg.paths || [])) {
        downloadPathsMap[p] = p;
      }
      for (const e of (msg.errors || [])) {
        downloadErrors[e.url] = e.error;
      }
      renderAudioList();
      break;

    case 'processError':
      document.getElementById('process-status').textContent = '❌ 处理失败';
      showProcessError(msg.message);
      document.getElementById('btn-start').disabled = false;
      document.getElementById('btn-retranscribe').disabled = false;
      document.getElementById('btn-resummarize').disabled = false;
      document.getElementById('btn-voicefix').disabled = false;
      document.getElementById('btn-voiceprint').disabled = false;
      processing = false;
      break;

    case 'error':
      showProcessError(msg.message);
      break;

    case 'chatReply':
      hideChatTyping();
      chatLoading = false;
      addChatMessage('assistant', msg.answer || '（无响应）');
      chatHistory.push({ role: 'assistant', content: msg.answer || '（无响应）' });
      // Limit history to last 20 messages
      if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
      break;
  }
});

vscode.postMessage({ type: 'refresh' });
</script>
</body>
</html>`;
}