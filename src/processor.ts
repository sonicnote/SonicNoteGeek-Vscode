import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import * as crypto from "crypto";
import { execSync } from "child_process";
import { URL } from "url";
import type {
  TranscriptionTask, TranscriptionResult, TranscriptSegment,
  ASRConfig, LLMConfig, SpeakerDiarizationConfig, SummaryTemplate,
  VoiceprintEntry, TemplateType,
} from "./types";
import { getTemplate } from "./templates";
import { generateOutput } from "./utils/output-generator";

export class AudioProcessor {
  public lastTranscript: TranscriptSegment[] = [];
  public lastDownloadedPaths: string[] = [];
  public lastOriginalUrls: string[] = [];
  public workspaceRoot: string = "";
  public lastDownloadErrors: Array<{ url: string; error: string }> = [];

  async process(
    task: TranscriptionTask,
    sourceTitle: string,
    progressCallback?: (stageIndex: number, label: string) => void,
    asrModelName?: string,
  ): Promise<string> {
    this.lastOriginalUrls = task.mp3Urls;

    progressCallback?.(0, "音频下载");
    const isCloudASR = !task.asrConfig.protocol.startsWith("local-") && task.asrConfig.protocol !== "xunfei";
    this.lastDownloadedPaths = await this.downloadMp3s(task.mp3Urls, sourceTitle);

    progressCallback?.(1, "语音转写");
    const mp3sToProcess = isCloudASR ? task.mp3Urls
      : (this.lastDownloadedPaths.length > 0 ? this.lastDownloadedPaths : task.mp3Urls);
    const rawTranscript = await this.runASR(mp3sToProcess, task.asrConfig, task.hotWords);
    const transcript = await this.runSpeakerDiarization(
      rawTranscript, task.speakerConfig, task.voiceprintLibrary,
      this.lastDownloadedPaths.length > 0 ? this.lastDownloadedPaths : mp3sToProcess,
    );
    this.lastTranscript = transcript;

    progressCallback?.(2, "分析总结");
    let template = getTemplate(task.template);
    if (task.template === "custom" && task.customPrompt) {
      template = {
        type: "custom", name: "自定义模板", description: "用户自定义 Prompt",
        systemPrompt: task.customPrompt, outputFormat: "",
      };
    }
    if (!template) throw new Error("未找到指定的总结模板");

    let summary: string;
    let keywords: string[] = [];
    let actionItems: string[] = [];
    try {
      const llmResult = await this.runLLMSummarization(transcript, task.llmConfig, template);
      summary = llmResult.summary;
      keywords = llmResult.keywords;
      actionItems = llmResult.actionItems;
    } catch (llmErr) {
      const msg = llmErr instanceof Error ? llmErr.message : String(llmErr);
      console.warn("LLM 总结失败，仅输出逐字稿:", msg);
      summary = `> ⚠️ LLM 总结失败: ${msg}\n\n> 以下为语音转写逐字稿。`;
    }

    progressCallback?.(3, "文档写入");
    const result: TranscriptionResult = {
      taskId: task.id, transcript, summary, keywords, actionItems,
      duration: this.calcDuration(transcript),
      language: task.asrConfig.language,
      speakerCount: new Set(transcript.map(s => s.speaker)).size,
    };

    return generateOutput(result, template, sourceTitle, asrModelName);
  }

  async downloadMp3s(mp3Urls: string[], sourceTitle: string): Promise<string[]> {
    const localPaths: string[] = [];
    this.lastDownloadErrors = [];

    for (const url of mp3Urls) {
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        localPaths.push(url);
        continue;
      }

      try {
        const fileName = url.split("/").pop()?.split("?")[0] || `audio_${Date.now()}.mp3`;
        const dirPath = `${this.workspaceRoot}/${sourceTitle}_audio`;
        const savePath = `${dirPath}/${fileName}`;

        if (fs.existsSync(savePath)) {
          localPaths.push(savePath);
          continue;
        }

        fs.mkdirSync(dirPath, { recursive: true });
        const buffer = await this.httpDownload(url);
        fs.writeFileSync(savePath, buffer);
        localPaths.push(savePath);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.lastDownloadErrors.push({ url, error: errMsg });
        console.warn(`下载 MP3 失败: ${url}`, error);
        localPaths.push(url);
      }
    }

    return localPaths;
  }

  private httpDownload(urlStr: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const u = new URL(urlStr);
      const mod = u.protocol === "https:" ? https : http;
      mod.get(urlStr, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this.httpDownload(res.headers.location).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      }).on("error", reject);
    });
  }

  // ---- ASR 转写 ----
  private async runASR(
    mp3Urls: string[], config: ASRConfig, hotWords: { word: string; weight?: number }[],
  ): Promise<TranscriptSegment[]> {
    if (!config.protocol.startsWith("local-") && config.protocol !== "xunfei") {
      for (const url of mp3Urls) {
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          throw new Error(`云端 ASR 需要公网可访问的 HTTP URL，但当前是本地路径: "${url}"`);
        }
      }
    }

    try {
      switch (config.protocol) {
        case "local-openai": return this.callLocalASR(mp3Urls, config);
        case "openai-whisper": return this.callOpenAIWhisper(mp3Urls, config, hotWords);
        case "volcengine": return this.callVolcengineASR(mp3Urls, config, hotWords);
        case "aliyun-dashscope": return this.callAliyunDashScopeASR(mp3Urls, config, hotWords);
        case "xunfei": return this.callXunfeiASR(mp3Urls, config, hotWords);
        case "tencent": return this.callTencentASR(mp3Urls, config, hotWords);
        case "baidu": return this.callBaiduASR(mp3Urls, config, hotWords);
        case "huawei": return this.callHuaweiASR(mp3Urls, config, hotWords);
        default: throw new Error(`不支持的 ASR 协议: ${config.protocol}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const urlInfo = mp3Urls.length === 1 ? mp3Urls[0] : `${mp3Urls.length} 个文件`;
      throw new Error(`ASR 转写失败 [${urlInfo}]: ${msg}`);
    }
  }

  private async callLocalASR(mp3Urls: string[], config: ASRConfig): Promise<TranscriptSegment[]> {
    const baseUrl = config.localEndpoint || config.apiUrl || "http://localhost:8000";
    const results: TranscriptSegment[] = [];

    for (const pathOrUrl of mp3Urls) {
      const endpoint = baseUrl.replace(/\/$/, "") + "/v1/audio/transcriptions";
      let audioBuffer: Buffer;
      let fileName = "audio.mp3";
      const resolvedPath = pathOrUrl.startsWith("/") ? pathOrUrl : `${this.workspaceRoot}/${pathOrUrl}`;
      try {
        audioBuffer = fs.readFileSync(resolvedPath);
        fileName = resolvedPath.split("/").pop() || "audio.mp3";
      } catch (e) {
        if (pathOrUrl.startsWith("http")) {
          audioBuffer = await this.httpDownload(pathOrUrl);
          fileName = pathOrUrl.split("/").pop()?.split("?")[0] || "audio.mp3";
        } else {
          throw new Error(`无法读取音频文件: ${resolvedPath}`);
        }
      }

      const boundary = `----LocalASRBoundary${Date.now()}`;
      const parts: Buffer[] = [];
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: audio/mpeg\r\n\r\n`));
      parts.push(audioBuffer);
      const addField = (name: string, value: string) => {
        parts.push(Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`));
      };
      addField("model", config.model || "");
      addField("language", config.language || "zh");
      addField("response_format", "verbose_json");
      parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
      const body = Buffer.concat(parts);

      const respData = await this.httpMultipartPost(endpoint, boundary, body);
      if (respData.status !== 200) {
        throw new Error(`本地 ASR 请求失败 [${endpoint}] HTTP ${respData.status}: ${respData.text.substring(0, 500)}`);
      }

      const data = JSON.parse(respData.text);
      let segments = data.segments || data.utterances || data.results || data.sentences || data.result || [];

      if (segments.length > 0) {
        for (let i = 0; i < segments.length; i++) {
          const seg = segments[i];
          let start = seg.start || seg.start_time || seg.begin || 0;
          let end = seg.end || seg.end_time || seg.finish || 0;
          if (i > 0) {
            const prevEndSec = this.timestampToSeconds(results[results.length - 1].endTime);
            const gap = 0.3 + Math.random() * 2.2;
            start = Math.max(start, prevEndSec + gap);
            end = Math.max(end, start + (seg.end - seg.start || seg.duration || 1));
          }
          results.push({
            startTime: this.secondsToTimestamp(start),
            endTime: this.secondsToTimestamp(end),
            speaker: seg.speaker || seg.spk || "",
            text: (seg.text || seg.txt || seg.transcript || "").trim(),
          });
        }
      } else if (data.text) {
        const fullText = data.text.trim().replace(/\s+/g, " ").trim();
        results.push(...this.splitTextToSegments(fullText, data.duration || 60));
      }
    }
    return results;
  }

  private splitTextToSegments(fullText: string, duration: number): TranscriptSegment[] {
    const segments: TranscriptSegment[] = [];
    const paragraphs = fullText.split(/\n+/).filter(p => p.trim().length > 0);

    for (const para of paragraphs) {
      const parts = para.split(/(?<=[。！？\.!\?；;，,、])/);
      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        if (trimmed.length > 40) {
          const subParts = trimmed.split(/(?<=[,，\s])/);
          for (const sp of subParts) {
            const s = sp.trim();
            if (s) segments.push({ startTime: "", endTime: "", speaker: "", text: s });
          }
        } else {
          segments.push({ startTime: "", endTime: "", speaker: "", text: trimmed });
        }
      }
    }

    if (segments.length > 0) {
      const totalGapTime = Math.min(duration * 0.1, segments.length * 1.5);
      const speechTime = duration - totalGapTime;
      const avgSpeechDur = speechTime / segments.length;
      const avgGap = segments.length > 1 ? totalGapTime / (segments.length - 1) : 0;

      let currentTime = 0.0;
      for (let i = 0; i < segments.length; i++) {
        const jitter = i > 0 ? (0.3 + Math.random() * 2.2) : 0;
        const gap = i > 0 ? Math.max(avgGap * 0.5, jitter) : 0;
        currentTime += gap;
        segments[i].startTime = this.secondsToTimestamp(currentTime);
        segments[i].endTime = this.secondsToTimestamp(currentTime + avgSpeechDur);
        currentTime += avgSpeechDur;
      }
    }
    return segments;
  }

  private async callOpenAIWhisper(
    mp3Urls: string[], config: ASRConfig, _hotWords: { word: string; weight?: number }[],
  ): Promise<TranscriptSegment[]> {
    const endpoint = config.apiUrl || "https://api.openai.com/v1/audio/transcriptions";
    const results: TranscriptSegment[] = [];

    for (const url of mp3Urls) {
      const { data } = await this.httpJsonPost(endpoint, {
        file: url,
        model: "whisper-1",
        language: config.language,
        response_format: "verbose_json",
        timestamp_granularities: ["segment"],
      }, { "Authorization": `Bearer ${config.apiKey}` });

      const segments = data.segments || [];
      for (const seg of segments) {
        results.push({
          startTime: this.secondsToTimestamp(seg.start),
          endTime: this.secondsToTimestamp(seg.end),
          speaker: "",
          text: seg.text?.trim() || "",
        });
      }
    }
    return results;
  }

  // ---- 火山引擎 ASR ----
  private async callVolcengineASR(
    mp3Urls: string[], config: ASRConfig, hotWords: { word: string; weight?: number }[],
  ): Promise<TranscriptSegment[]> {
    const apiKey = config.apiKey || "";
    if (!apiKey) throw new Error("请配置火山引擎 Access Token");

    const resourceId = config.resourceId || "volc.seedasr.auc";
    const baseUrl = config.apiUrl || "https://openspeech.bytedance.com/api/v3/auc/bigmodel";
    const submitUrl = `${baseUrl}/submit`;
    const queryUrl = `${baseUrl}/query`;
    const results: TranscriptSegment[] = [];

    for (const url of mp3Urls) {
      const format = this.detectAudioFormat(url);
      const enableSpeaker = config.enableSpeakerDiarization;
      const requestBody: Record<string, unknown> = {
        user: { uid: "sonicnote-geek" },
        audio: { url, format, codec: "raw", rate: 16000, bits: 16, channel: 1 },
        request: {
          model_name: "bigmodel", enable_itn: true, enable_punc: false, enable_ddc: false,
          enable_speaker_info: enableSpeaker, enable_channel_split: false,
          show_utterances: true, vad_segment: false, sensitive_words_filter: "",
        },
      };
      if (hotWords.length > 0) {
        (requestBody.request as Record<string, unknown>).hotwords = hotWords.map(h => h.word).join(",");
      }
      if (enableSpeaker) {
        (requestBody.request as Record<string, unknown>).ssd_version = "200";
      }

      const requestId = crypto.randomUUID();
      const { status, headers: resHeaders, text: respText } = await this.nodeRequest(
        submitUrl,
        requestBody,
        { "x-api-key": apiKey, "X-Api-Resource-Id": resourceId, "X-Api-Request-Id": requestId, "X-Api-Sequence": "-1", "Content-Type": "application/json" },
      );

      const submitStatusCode = resHeaders["x-api-status-code"] || "";
      if (status !== 200 || (submitStatusCode && submitStatusCode !== "20000000")) {
        throw new Error(`火山引擎 ASR 提交失败 (HTTP ${status}, x-api-status-code=${submitStatusCode}): ${respText.substring(0, 300)}`);
      }

      let utterances: Array<Record<string, unknown>> = [];
      let pollCount: number = 0;
      for (pollCount = 0; pollCount < 120; pollCount++) {
        await this.sleep(2000);
        const { status: qStatus, headers: qHeaders, data: qData } = await this.nodeRequest(
          queryUrl,
          {},
          { "x-api-key": apiKey, "X-Api-Resource-Id": resourceId, "X-Api-Request-Id": requestId, "Content-Type": "application/json" },
        );
        const qStatusCode = qHeaders["x-api-status-code"] || "";
        if (qStatus !== 200 || !qStatusCode) continue;

        if (qStatusCode === "20000000") {
          utterances = qData.result?.utterances || qData.utterances || [];
          if (utterances.length === 0) {
            const fullText = qData.result?.text || qData.text || "";
            if (fullText) utterances = [{ text: fullText, start_time: 0, end_time: qData.audio_info?.duration || 0 }];
          }
          break;
        }
        if (qStatusCode !== "20000001" && qStatusCode !== "20000002") {
          throw new Error(`火山引擎 ASR 转写失败 (x-api-status-code=${qStatusCode})`);
        }
      }

      if (utterances.length === 0 && pollCount >= 120) {
        throw new Error(`火山引擎 ASR 任务超时 (${pollCount} 次轮询后仍未完成)`);
      }

      const speakerIds = new Set<string>();
      for (const seg of utterances) {
        const sid = (seg.speaker ?? seg.speaker_id ?? "") as string;
        if (sid) speakerIds.add(sid);
      }
      const speakerMap = new Map<string, string>();
      Array.from(speakerIds).sort().forEach((sid, idx) => speakerMap.set(sid, String(idx + 1)));

      for (const seg of utterances) {
        const startMs = (seg.start_time ?? seg.start ?? 0) as number;
        const endMs = (seg.end_time ?? seg.end ?? 0) as number;
        const rawSpeaker = (seg.speaker ?? seg.speaker_id ?? "") as string;
        results.push({
          startTime: this.msToTimestamp(startMs),
          endTime: this.msToTimestamp(endMs),
          speaker: rawSpeaker ? `__ASR__${speakerMap.get(rawSpeaker) || rawSpeaker}` : "",
          text: (seg.text as string)?.trim() || "",
        });
      }
    }
    return results;
  }

  // ---- 阿里云 DashScope ----
  private async callAliyunDashScopeASR(
    mp3Urls: string[], config: ASRConfig, _hotWords: { word: string; weight?: number }[],
  ): Promise<TranscriptSegment[]> {
    const apiKey = config.apiKey || "";
    if (!apiKey) throw new Error("请配置阿里云 DashScope API Key");

    const submitUrl = config.apiUrl || "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription";
    const model = config.model || "fun-asr-flash-2026-06-15";
    const results: TranscriptSegment[] = [];

    for (const url of mp3Urls) {
      const { data: subData, text: respText } = await this.nodeRequest(submitUrl, {
        model, input: { file_urls: [url] },
        parameters: { channel_id: [0], language_hints: [config.language || "zh"] },
      }, { "Authorization": `Bearer ${apiKey}`, "X-DashScope-Async": "enable", "Content-Type": "application/json" });

      const taskId = subData.output?.task_id;
      if (!taskId) throw new Error(`提交任务失败: ${respText.substring(0, 500)}`);

      const queryUrl = `https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`;
      let transcriptionUrl = "";
      for (let pollCount = 0; pollCount < 180; pollCount++) {
        await this.sleep(2000);
        const { data: qData } = await this.nodeRequest(queryUrl, {}, {
          "Authorization": `Bearer ${apiKey}`, "X-DashScope-Async": "enable",
        }, "GET");
        const output = qData.output as Record<string, unknown> | undefined;
        const taskStatus = String(output?.task_status || "");
        if (taskStatus === "SUCCEEDED") {
          const resultList = (output?.results || []) as Array<Record<string, unknown>>;
          if (resultList.length > 0) transcriptionUrl = String(resultList[0].transcription_url || "");
          break;
        }
        if (taskStatus === "FAILED") throw new Error("阿里云 DashScope 转写失败");
      }

      if (!transcriptionUrl) {
        results.push({ startTime: "00:00:00", endTime: "00:00:00", speaker: "", text: "（未检测到语音内容）" });
        continue;
      }

      const { data: transcriptData } = await this.nodeRequest(transcriptionUrl, {}, {}, "GET");
      const transcriptList = (transcriptData.transcripts || []) as Array<Record<string, unknown>>;
      const speakerIds = new Set<string>();
      const allSentences: Array<Record<string, unknown>> = [];
      for (const ch of transcriptList) {
        const sentences = (ch.sentences || []) as Array<Record<string, unknown>>;
        for (const s of sentences) {
          const sid = String(s.speaker_id ?? "");
          if (sid) speakerIds.add(sid);
          allSentences.push(s);
        }
      }

      const speakerMap = new Map<string, string>();
      Array.from(speakerIds).sort().forEach((sid, idx) => speakerMap.set(sid, String(idx + 1)));

      for (const s of allSentences) {
        results.push({
          startTime: this.msToTimestamp((s.begin_time ?? 0) as number),
          endTime: this.msToTimestamp((s.end_time ?? 0) as number),
          speaker: String(s.speaker_id ?? "") ? `__ASR__${speakerMap.get(String(s.speaker_id)) || s.speaker_id}` : "",
          text: (s.text as string)?.trim() || "",
        });
      }
    }
    return results;
  }

  // ---- 讯飞 ASR ----
  private async callXunfeiASR(
    mp3Urls: string[], config: ASRConfig, hotWords: { word: string; weight?: number }[],
  ): Promise<TranscriptSegment[]> {
    const apiKey = config.apiKey || "";
    const secretKey = config.secretKey || "";
    const appId = config.appId || "";
    if (!apiKey || !secretKey || !appId) throw new Error("请配置讯飞 APPID、APIKey、APISecret");

    const baseUrl = config.apiUrl || "https://office-api-ist-dx.iflyaisol.com";
    const results: TranscriptSegment[] = [];

    for (const pathOrUrl of mp3Urls) {
      let audioBuffer: Buffer;
      const resolvedPath = pathOrUrl.startsWith("http") ? pathOrUrl
        : pathOrUrl.startsWith("/") ? pathOrUrl
        : `${this.workspaceRoot}/${pathOrUrl}`;
      try {
        audioBuffer = fs.readFileSync(resolvedPath);
      } catch {
        if (pathOrUrl.startsWith("http")) {
          audioBuffer = await this.httpDownload(pathOrUrl);
        } else {
          throw new Error(`无法读取音频文件: ${resolvedPath}`);
        }
      }

      const fileName = pathOrUrl.split("/").pop()?.split("?")[0] || "audio.mp3";
      const uploadParams = this.buildXunfeiParams(appId, apiKey);
      uploadParams.fileSize = String(audioBuffer.length);
      uploadParams.fileName = fileName;
      uploadParams.language = this.mapXunfeiLanguage(config.language);
      uploadParams.durationCheckDisable = "true";
      uploadParams.audioMode = "fileStream";
      if (hotWords.length > 0) uploadParams.hotWord = hotWords.map(h => h.word).join("|");

      const uploadSignature = this.xunfeiSign(secretKey, uploadParams);
      const uploadQs = Object.entries(uploadParams).map(([k, v]) => `${k}=${this.urlEncodeJava(String(v))}`).join("&");
      const uploadUrl = `${baseUrl}/v2/upload?${uploadQs}`;

      const { status: upStatus, data: upData, text: upText } = await this.nodePostBinary(
        uploadUrl, audioBuffer, { "Content-Type": "application/octet-stream", "signature": uploadSignature },
      );

      if (upStatus !== 200) throw new Error(`讯飞上传失败 HTTP ${upStatus}`);

      const content = upData.content || upData;
      const orderId = content.orderId;
      if (!orderId) throw new Error(`讯飞上传失败 (无 orderId): ${upText.substring(0, 500)}`);

      let orderResult = "";
      for (let pollCount = 0; pollCount < 300; pollCount++) {
        await this.sleep(2000);
        const queryParams = this.buildXunfeiParams(appId, apiKey);
        queryParams.orderId = orderId;
        queryParams.resultType = "transfer";
        const querySignature = this.xunfeiSign(secretKey, queryParams);
        const queryQs = Object.entries(queryParams).map(([k, v]) => `${k}=${this.urlEncodeJava(String(v))}`).join("&");
        const queryUrl = `${baseUrl}/v2/getResult?${queryQs}`;

        const { status: qStatus, data: qData } = await this.nodeRequest(queryUrl, {}, {
          "Content-Type": "application/json", "signature": querySignature,
        });
        if (qStatus !== 200) continue;

        const qContent = qData.content || qData;
        if (qContent.orderInfo?.status === 4) { orderResult = qContent.orderResult || ""; break; }
        if (qContent.orderInfo?.status === -1 || qContent.orderInfo?.failType > 0) {
          throw new Error("讯飞转写失败");
        }
      }

      if (!orderResult) { results.push({ startTime: "00:00:00", endTime: "00:00:00", speaker: "", text: "（未检测到语音内容）" }); continue; }

      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(orderResult); } catch {}

      const lattice = (parsed.lattice || []) as Array<Record<string, unknown>>;
      const allWords: Array<{ text: string; beginMs: number; endMs: number }> = [];
      for (const lat of lattice) {
        const json1best = (lat.json_1best || "") as string;
        if (!json1best) continue;
        let rtData: Record<string, unknown>;
        try { rtData = JSON.parse(json1best); } catch { continue; }
        const st = (rtData.st || {}) as Record<string, unknown>;
        const rt = (st.rt || []) as Array<Record<string, unknown>>;
        for (const r of rt) {
          const ws = (r.ws || []) as Array<Record<string, unknown>>;
          for (const w of ws) {
            const cw = (w.cw || []) as Array<Record<string, unknown>>;
            const wordText = cw.map(c => String(c.w || "")).join("");
            if (wordText) allWords.push({ text: wordText, beginMs: Number(w.wb || 0) * 10, endMs: Number(w.we || 0) * 10 });
          }
        }
      }

      const punctuation = new Set(["。", "！", "？", "，", "、", ".", "!", "?", ","]);
      let currentSentence = "", sentenceBegin = allWords[0]?.beginMs || 0, sentenceEnd = allWords[0]?.endMs || 0;
      for (let i = 0; i < allWords.length; i++) {
        const w = allWords[i];
        currentSentence += w.text;
        sentenceEnd = w.endMs;
        const isPause = i < allWords.length - 1 && (allWords[i + 1].beginMs - w.endMs) > 1000;
        if ((punctuation.has(w.text) || isPause || i === allWords.length - 1) && currentSentence.trim()) {
          results.push({ startTime: this.msToTimestamp(sentenceBegin), endTime: this.msToTimestamp(sentenceEnd), speaker: "", text: currentSentence.trim() });
          currentSentence = "";
          if (i < allWords.length - 1) sentenceBegin = allWords[i + 1].beginMs;
        }
      }
    }
    return results;
  }

  // ---- 腾讯云 ASR ----
  private async callTencentASR(
    mp3Urls: string[], config: ASRConfig, hotWords: { word: string; weight?: number }[],
  ): Promise<TranscriptSegment[]> {
    const secretId = config.apiKey || "";
    const secretKey = config.secretKey || "";
    if (!secretId || !secretKey) throw new Error("请配置腾讯云 SecretId 和 SecretKey");

    const endpoint = config.apiUrl || "https://asr.tencentcloudapi.com";
    const engineModel = config.model || "16k_zh";
    const results: TranscriptSegment[] = [];

    for (const url of mp3Urls) {
      const submitBody: Record<string, unknown> = {
        EngineModelType: engineModel, ChannelNum: 1, ResTextFormat: 3, SourceType: 0, Url: url,
        SpeakerDiarization: config.enableSpeakerDiarization ? 1 : 0,
      };
      if (hotWords.length > 0) submitBody.HotwordList = hotWords.map(h => `${h.word}|${h.weight || 5}`).join(",");

      const submitHeaders = this.tencentSign(secretId, secretKey, "CreateRecTask", JSON.stringify(submitBody), "ap-guangzhou");
      const { status: subStatus, data: subData } = await this.nodeRequest(endpoint, submitBody, submitHeaders);
      if (subStatus !== 200 || subData.Response?.Error) {
        throw new Error(`腾讯云 ASR 提交失败: ${subData.Response?.Error?.Message || ""}`);
      }

      const taskId: number = subData.Response?.Data?.TaskId;
      if (!taskId) throw new Error("腾讯云提交失败 (无 TaskId)");

      let resultDetail: any[] | null = null;
      for (let pollCount = 0; pollCount < 180; pollCount++) {
        await this.sleep(2000);
        const queryHeaders = this.tencentSign(secretId, secretKey, "DescribeTaskStatus", JSON.stringify({ TaskId: taskId }), "ap-guangzhou");
        const { data: qData } = await this.nodeRequest(endpoint, { TaskId: taskId }, queryHeaders);

        const taskStatus = qData.Response?.Data?.Status;
        if (taskStatus === 2) { resultDetail = qData.Response?.Data?.ResultDetail || null; break; }
        if (taskStatus === 3) throw new Error("腾讯云转写失败");
      }

      if (!resultDetail) { results.push({ startTime: "00:00:00", endTime: "00:00:00", speaker: "", text: "（未检测到语音内容）" }); continue; }

      const speakerIds = new Set<string>();
      for (const s of resultDetail) {
        if (s.SpeakerId !== undefined && s.SpeakerId !== -1) speakerIds.add(String(s.SpeakerId));
      }
      const speakerMap = new Map<string, string>();
      Array.from(speakerIds).sort().forEach((sid, idx) => speakerMap.set(sid, String(idx + 1)));

      for (const s of resultDetail) {
        const text = String(s.FinalSentence || s.WrittenText || s.Text || "").trim();
        if (!text) continue;
        const rawSpeaker = s.SpeakerId !== undefined && s.SpeakerId !== -1 ? String(s.SpeakerId) : "";
        results.push({
          startTime: this.msToTimestamp((s.StartMs || s.BeginTime || 0) as number),
          endTime: this.msToTimestamp((s.EndMs || s.EndTime || 0) as number),
          speaker: rawSpeaker ? `__ASR__${speakerMap.get(rawSpeaker) || rawSpeaker}` : "",
          text,
        });
      }
    }
    return results;
  }

  // ---- 百度云 ASR ----
  private async callBaiduASR(
    mp3Urls: string[], config: ASRConfig, _hotWords: { word: string; weight?: number }[],
  ): Promise<TranscriptSegment[]> {
    const apiKey = config.apiKey || "";
    const secretKey = config.secretKey || "";
    if (!apiKey || !secretKey) throw new Error("请配置百度云 API Key 和 Secret Key");

    const pid = config.model || "80001";
    const results: TranscriptSegment[] = [];

    const tokenUrl = `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${encodeURIComponent(apiKey)}&client_secret=${encodeURIComponent(secretKey)}`;
    const { data: tokenData } = await this.nodeRequest(tokenUrl, {}, { "Content-Type": "application/json" });
    const accessToken = tokenData.access_token;
    if (!accessToken) throw new Error("获取百度 access_token 失败");

    for (const url of mp3Urls) {
      const { data: subData } = await this.nodeRequest(
        `https://aip.baidubce.com/rpc/2.0/aasr/v1/create?access_token=${accessToken}`,
        { speech_url: url, format: this.detectAudioFormat(url), rate: 16000, pid: Number(pid) },
        { "Content-Type": "application/json" },
      );
      if (subData.error_code) throw new Error(`百度云 ASR 提交失败 [${subData.error_code}]: ${subData.error_msg}`);

      const taskId = subData.task_id;
      let taskResult: Record<string, unknown> | null = null;
      for (let pollCount = 0; pollCount < 300; pollCount++) {
        await this.sleep(2000);
        const { data: qData } = await this.nodeRequest(
          `https://aip.baidubce.com/rpc/2.0/aasr/v1/query?access_token=${accessToken}`,
          { task_ids: [taskId] }, { "Content-Type": "application/json" },
        );
        const tasksInfo = (qData.tasks_info || []) as Array<Record<string, unknown>>;
        if (tasksInfo.length === 0) continue;
        if (tasksInfo[0].task_status === "Success") { taskResult = tasksInfo[0].task_result as Record<string, unknown>; break; }
        if (tasksInfo[0].task_status === "Failed") throw new Error("百度云转写失败");
      }

      if (!taskResult) { results.push({ startTime: "00:00:00", endTime: "00:00:00", speaker: "", text: "（未检测到语音内容）" }); continue; }

      const detailedResult = (taskResult.detailed_result || []) as Array<Record<string, unknown>>;
      if (detailedResult.length === 0) {
        const resultArr = (taskResult.result || []) as string[];
        const fullText = resultArr.join("\n").trim();
        if (fullText) results.push({ startTime: "00:00:00", endTime: "00:00:00", speaker: "", text: fullText });
        continue;
      }

      for (const s of detailedResult) {
        const resArr = (s.res || []) as string[];
        const text = resArr.join("").trim();
        if (!text) continue;
        results.push({
          startTime: this.msToTimestamp((s.begin_time || 0) as number),
          endTime: this.msToTimestamp((s.end_time || 0) as number),
          speaker: "", text,
        });
      }
    }
    return results;
  }

  // ---- 华为云 SIS ----
  private async callHuaweiASR(
    mp3Urls: string[], config: ASRConfig, _hotWords: { word: string; weight?: number }[],
  ): Promise<TranscriptSegment[]> {
    const ak = config.apiKey || "";
    const sk = config.secretKey || "";
    const projectId = config.appId || "";
    if (!ak || !sk || !projectId) throw new Error("请配置华为云 Access Key、Secret Key 和 Project ID");

    const baseUrl = config.apiUrl || "https://sis-ext.cn-north-4.myhuaweicloud.com";
    const property = config.model || "chinese_16k_conversation";
    const results: TranscriptSegment[] = [];

    for (const url of mp3Urls) {
      const submitPath = `/v1/${projectId}/asr/transcriber/jobs`;
      const submitBody = JSON.stringify({ config: { audio_format: "auto", property, add_punc: "yes" }, data_url: url });
      const submitHeaders = this.huaweiSign(ak, sk, "POST", submitPath, "", submitBody, baseUrl);

      const { data: subData } = await this.nodeRequest(`${baseUrl}${submitPath}`, JSON.parse(submitBody), submitHeaders);
      if (subData.error_code) throw new Error(`华为云 SIS 错误 [${subData.error_code}]: ${subData.error_msg}`);

      const jobId = subData.job_id;
      if (!jobId) throw new Error("华为云提交失败 (无 job_id)");

      let segments: Array<Record<string, unknown>> = [];
      for (let pollCount = 0; pollCount < 300; pollCount++) {
        await this.sleep(2000);
        const queryPath = `/v1/${projectId}/asr/transcriber/jobs/${jobId}`;
        const queryHeaders = this.huaweiSign(ak, sk, "GET", queryPath, "", "", baseUrl);
        const { data: qData } = await this.nodeRequest(`${baseUrl}${queryPath}`, {}, queryHeaders, "GET");
        if (qData.status === "FINISHED") { segments = (qData.segments || []) as Array<Record<string, unknown>>; break; }
        if (qData.status === "ERROR") throw new Error("华为云转写失败");
      }

      for (const seg of segments) {
        const result = (seg.result || {}) as Record<string, unknown>;
        const text = String(result.text || "").trim();
        if (!text) continue;
        const analysisInfo = (result.analysis_info || {}) as Record<string, unknown>;
        const role = String(analysisInfo.role || "");
        const speakerLabel = role === "agent" ? "客服" : role === "user" ? "用户" : "";
        results.push({
          startTime: this.msToTimestamp((seg.start_time || 0) as number),
          endTime: this.msToTimestamp((seg.end_time || 0) as number),
          speaker: speakerLabel ? `__ASR__${speakerLabel}` : "",
          text,
        });
      }
    }
    return results;
  }

  // ---- 签名工具方法 ----
  private buildXunfeiParams(appId: string, apiKey: string): Record<string, string> {
    const now = new Date();
    const offset = -now.getTimezoneOffset();
    const sign = offset >= 0 ? "+" : "-";
    const tz = `${sign}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}${String(Math.abs(offset) % 60).padStart(2, "0")}`;
    const dateTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}${tz}`;
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let random = "";
    for (let i = 0; i < 16; i++) random += chars[Math.floor(Math.random() * chars.length)];
    return { appId, accessKeyId: apiKey, dateTime, signatureRandom: random };
  }

  private urlEncodeJava(val: string): string {
    return encodeURIComponent(val).replace(/%20/g, "+").replace(/[!'()]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  }

  private mapXunfeiLanguage(lang: string): string {
    if (!lang || lang === "auto") return "autodialect";
    if (lang.startsWith("zh")) return "autodialect";
    if (lang.startsWith("en")) return "autominor";
    return "autodialect";
  }

  private xunfeiSign(secret: string, params: Record<string, string>): string {
    const sorted = Object.keys(params).filter(k => k !== "signature").sort();
    const parts: string[] = [];
    for (const key of sorted) {
      const val = params[key];
      if (val) parts.push(`${key}=${this.urlEncodeJava(val)}`);
    }
    const hmac = crypto.createHmac("sha1", secret);
    hmac.update(parts.join("&"));
    return hmac.digest("base64");
  }

  private sha256Hex(data: string): string {
    return crypto.createHash("sha256").update(data, "utf8").digest("hex");
  }

  private hmacSha256Hex(key: Buffer | string, data: string): Buffer {
    return crypto.createHmac("sha256", key).update(data, "utf8").digest();
  }

  private tencentSign(secretId: string, secretKey: string, action: string, payload: string, region: string): Record<string, string> {
    const service = "asr";
    const host = "asr.tencentcloudapi.com";
    const version = "2019-06-14";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const algorithm = "TC3-HMAC-SHA256";

    const canonicalHeaders = `content-type:application/json\nhost:${host}\n`;
    const signedHeaders = "content-type;host";
    const hashedPayload = this.sha256Hex(payload);
    const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayload}`;

    const date = new Date(Number(timestamp) * 1000).toISOString().split("T")[0];
    const credentialScope = `${date}/${service}/tc3_request`;
    const hashedCanonicalRequest = this.sha256Hex(canonicalRequest);
    const stringToSign = `${algorithm}\n${timestamp}\n${credentialScope}\n${hashedCanonicalRequest}`;

    const kDate = this.hmacSha256Hex(`TC3${secretKey}`, date);
    const kService = this.hmacSha256Hex(kDate, service);
    const kSigning = this.hmacSha256Hex(kService, "tc3_request");
    const signature = this.hmacSha256Hex(kSigning, stringToSign).toString("hex");

    return {
      "Authorization": `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "Content-Type": "application/json",
      "X-TC-Action": action, "X-TC-Version": version, "X-TC-Timestamp": timestamp, "X-TC-Region": region,
    };
  }

  private huaweiSign(ak: string, sk: string, method: string, path: string, query: string, body: string, baseUrl: string): Record<string, string> {
    const algorithm = "SDK-HMAC-SHA256";
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const timestamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
    const host = new URL(baseUrl).hostname;

    let canonicalURI = path.split("/").map(seg => encodeURIComponent(seg)).join("/");
    if (!canonicalURI.endsWith("/")) canonicalURI += "/";

    const signedHeaders = "content-type;host;x-sdk-date";
    const emptyBodyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const hashedBody = body ? crypto.createHash("sha256").update(body, "utf8").digest("hex") : emptyBodyHash;

    const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-sdk-date:${timestamp}\n`;
    const canonicalRequest = [method, canonicalURI, query, canonicalHeaders, signedHeaders, hashedBody].join("\n");

    const hashedCanonicalRequest = crypto.createHash("sha256").update(canonicalRequest, "utf8").digest("hex");
    const stringToSign = [algorithm, timestamp, hashedCanonicalRequest].join("\n");
    const signature = crypto.createHmac("sha256", sk).update(stringToSign, "utf8").digest("hex");

    return {
      "Authorization": `${algorithm} Access=${ak}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "X-Sdk-Date": timestamp, "host": host, "Content-Type": "application/json",
    };
  }

  // ---- HTTP 工具方法 ----
  private nodeRequest(urlStr: string, body: unknown, headers: Record<string, string>, method: "GET" | "POST" = "POST"): Promise<{ status: number; headers: Record<string, string>; data: any; text: string }> {
    const u = new URL(urlStr);
    const isGet = method === "GET";
    const bodyStr = isGet ? "" : JSON.stringify(body);
    const isHttps = u.protocol === "https:";
    const mod = isHttps ? https : http;
    const opts: Record<string, unknown> = {
      hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search, method,
      headers: isGet ? { ...headers } : { ...headers, "Content-Length": Buffer.byteLength(bodyStr).toString() },
    };

    return new Promise((resolve, reject) => {
      const req = mod.request(opts, (res: any) => {
        const resHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) { resHeaders[String(k)] = String(v); }
        let chunks = "";
        res.on("data", (d: string) => { chunks += d; });
        res.on("end", () => {
          let data: any = {};
          try { data = JSON.parse(chunks); } catch {}
          resolve({ status: res.statusCode || 0, headers: resHeaders, data, text: chunks });
        });
      });
      req.on("error", (e: Error) => reject(e));
      if (!isGet) req.write(bodyStr);
      req.end();
    });
  }

  private nodePostBinary(urlStr: string, body: Buffer, headers: Record<string, string>): Promise<{ status: number; data: any; text: string }> {
    const u = new URL(urlStr);
    const isHttps = u.protocol === "https:";
    const mod = isHttps ? https : http;
    return new Promise((resolve, reject) => {
      const req = mod.request({
        hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search, method: "POST",
        headers: { ...headers, "Content-Length": String(body.length) },
      }, (res: any) => {
        let chunks = "";
        res.on("data", (d: string) => { chunks += d; });
        res.on("end", () => {
          let data: any = {};
          try { data = JSON.parse(chunks); } catch {}
          resolve({ status: res.statusCode || 0, data, text: chunks });
        });
      });
      req.on("error", (e: Error) => reject(e));
      req.write(body);
      req.end();
    });
  }

  private httpJsonPost(urlStr: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; data: any; text: string }> {
    const u = new URL(urlStr);
    const isHttps = u.protocol === "https:";
    const mod = isHttps ? https : http;
    const bodyStr = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = mod.request({
        hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr), ...extraHeaders },
      }, (res: any) => {
        let chunks = "";
        res.on("data", (d: string) => { chunks += d; });
        res.on("end", () => {
          let respData: any = {};
          try { respData = JSON.parse(chunks); } catch {}
          resolve({ status: res.statusCode || 0, data: respData, text: chunks });
        });
      });
      req.on("error", (e: Error) => reject(e));
      req.write(bodyStr);
      req.end();
    });
  }

  private httpMultipartPost(urlStr: string, boundary: string, body: Buffer, timeoutMs = 1800000): Promise<{ status: number; text: string }> {
    const u = new URL(urlStr);
    const isHttps = u.protocol === "https:";
    const mod = isHttps ? https : http;
    return new Promise((resolve, reject) => {
      const req = mod.request({
        hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search, method: "POST", timeout: timeoutMs,
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": String(body.length) },
      }, (res: any) => {
        let buf = "";
        res.on("data", (chunk: string) => { buf += chunk; });
        res.on("end", () => resolve({ status: res.statusCode || 0, text: buf }));
      });
      req.on("timeout", () => { req.destroy(); reject(new Error("请求超时")); });
      req.on("error", (e: Error) => reject(new Error(`连接失败: ${e.message}`)));
      req.write(body);
      req.end();
    });
  }

  // ---- 说话人分离 ----
  private async runSpeakerDiarization(
    segments: TranscriptSegment[], config: SpeakerDiarizationConfig,
    voiceprintLibrary: VoiceprintEntry[], audioFilePaths: string[],
  ): Promise<TranscriptSegment[]> {
    let labeled: TranscriptSegment[];
    const hasAsrSpeakers = segments.some(s => s.speaker.startsWith("__ASR__"));

    if (hasAsrSpeakers) {
      labeled = segments.map(s => {
        if (s.speaker.startsWith("__ASR__")) {
          const code = s.speaker.replace("__ASR__", "");
          return { ...s, speaker: `speaker_${code}` };
        }
        return { ...s, speaker: s.speaker || "" };
      });
    } else if (config.enabled) {
      labeled = this.builtinSpeakerDiarization(segments);
    } else {
      labeled = segments.map(s => ({ ...s, speaker: s.speaker || "" }));
    }

    const shouldRunVoiceprint = config.enabled && config.autoVoiceprint && config.customEndpoint;
    if (shouldRunVoiceprint) {
      let localPaths = this.resolveLocalAudioPaths(audioFilePaths);
      if (localPaths.length === 0 && this.lastDownloadedPaths.length > 0) {
        localPaths = this.resolveLocalAudioPaths(this.lastDownloadedPaths);
      }
      if (localPaths.length > 0 && voiceprintLibrary.some(v => v.audioSamplePath)) {
        try {
          labeled = await this.callVoiceprintService(labeled, config, voiceprintLibrary, localPaths);
        } catch (e) { console.warn("声纹识别服务调用失败:", e); }
      }
    }

    if (voiceprintLibrary.length > 0) {
      labeled = labeled.map(s => {
        const vp = voiceprintLibrary.find(v => v.id === s.speaker);
        return vp ? { ...s, speaker: vp.name } : s;
      });
    }

    labeled = labeled.map(s => {
      const m = s.speaker.match(/^speaker_(\d+)$/);
      if (m) return { ...s, speaker: `说话人${m[1]}` };
      return s;
    });

    return labeled;
  }

  private builtinSpeakerDiarization(segments: TranscriptSegment[]): TranscriptSegment[] {
    let currentSpeaker = 0;
    const speakerNames = ["1", "2", "3", "4"];
    let consecutiveCount = 0;
    return segments.map((s, i) => {
      if (i > 0) {
        const prevText = segments[i - 1].text || "";
        const currText = s.text || "";
        const prevEndsPunct = /[。？！?！\.]$/.test(prevText.trim());
        const prevEndSec = this.timestampToSeconds(segments[i - 1].endTime || "00:00:00");
        const currStartSec = this.timestampToSeconds(s.startTime || "00:00:00");
        const gap = currStartSec - prevEndSec;
        const lenRatio = Math.max(currText.length, 1) / Math.max(prevText.length, 1);
        const prevIsQuestion = /[？?]$/.test(prevText.trim());
        const currStartsConversational = /^(我|你|那|这|嗯|啊|哦|不|对|是|好|可|但|就|也|还|都)/.test(currText.trim());

        const shouldSwitch = prevEndsPunct || gap > 1.0 || lenRatio > 2.5 ||
          lenRatio < 0.4 || consecutiveCount > 2 || prevIsQuestion ||
          (currStartsConversational && gap > 0.3);

        if (shouldSwitch) {
          currentSpeaker = (currentSpeaker + 1) % speakerNames.length;
          consecutiveCount = 0;
        }
      }
      consecutiveCount++;
      return { ...s, speaker: `speaker_${speakerNames[currentSpeaker]}` };
    });
  }

  private resolveLocalAudioPaths(paths: string[]): string[] {
    return paths
      .filter(p => p && !p.startsWith("http://") && !p.startsWith("https://"))
      .map(p => p.startsWith("/") ? p : `${this.workspaceRoot}/${p}`);
  }

  private async callVoiceprintService(
    segments: TranscriptSegment[], config: SpeakerDiarizationConfig,
    voiceprintLibrary: VoiceprintEntry[], localAudioPaths: string[],
  ): Promise<TranscriptSegment[]> {
    const baseUrl = config.customEndpoint!.replace(/\/$/, "");
    const endpoint = `${baseUrl}/v1/speaker/identify`;

    const speakerGroups = new Map<string, { starts: number[]; ends: number[] }>();
    for (const seg of segments) {
      const spk = seg.speaker || "unknown";
      if (!speakerGroups.has(spk)) speakerGroups.set(spk, { starts: [], ends: [] });
      const group = speakerGroups.get(spk)!;
      group.starts.push(this.timestampToSeconds(seg.startTime));
      group.ends.push(this.timestampToSeconds(seg.endTime));
    }

    const speakerSegments = Array.from(speakerGroups.entries()).map(([speakerId, group]) => ({
      speaker_id: speakerId, starts: group.starts, ends: group.ends,
    }));

    const vpLibrary = voiceprintLibrary
      .filter(v => v.audioSamplePath)
      .map(v => ({
        name: v.name,
        audio_path: v.audioSamplePath!.startsWith("/") ? v.audioSamplePath! : `${this.workspaceRoot}/${v.audioSamplePath}`,
      }));

    if (vpLibrary.length === 0) return segments;

    const enrollUrl = `${baseUrl}/v1/speaker/enroll`;
    for (const vp of vpLibrary) {
      try {
        const params = `name=${encodeURIComponent(vp.name)}&audio_path=${encodeURIComponent(vp.audio_path)}`;
        await this.httpJsonPost(`${enrollUrl}?${params}`, {}, {});
      } catch {}
    }

    const { data } = await this.httpJsonPost(endpoint, {
      audio_file: localAudioPaths[0], speaker_segments: speakerSegments, voiceprint_library: vpLibrary,
    }, config.apiKey ? { "Authorization": `Bearer ${config.apiKey}` } : {});

    if (data.error) throw new Error(`声纹识别服务错误: ${data.error}`);

    const labels: Record<string, string> = data.labels || {};
    return segments.map(s => {
      const name = labels[s.speaker];
      return name && name !== "未知说话人" ? { ...s, speaker: name } : s;
    });
  }

  private async httpGet(urlStr: string): Promise<{ status: number; data: any }> {
    const u = new URL(urlStr);
    const isHttps = u.protocol === "https:";
    const mod = isHttps ? https : http;
    return new Promise((resolve, reject) => {
      mod.request({ hostname: u.hostname, port: u.port || (isHttps ? 443 : 80), path: u.pathname + u.search, method: "GET" }, (res: any) => {
        let chunks = "";
        res.on("data", (d: string) => { chunks += d; });
        res.on("end", () => {
          let respData: any = {};
          try { respData = JSON.parse(chunks); } catch {}
          resolve({ status: res.statusCode || 0, data: respData });
        });
      }).on("error", (e: Error) => reject(e)).end();
    });
  }

  async checkVoiceprintService(endpoint: string): Promise<boolean> {
    if (!endpoint) return false;
    try {
      const baseUrl = endpoint.replace(/\/$/, "");
      const { status, data } = await this.httpGet(`${baseUrl}/v1/speaker/list`);
      return status === 200 && Array.isArray(data.speakers);
    } catch { return false; }
  }

  async enrollVoiceprint(endpoint: string, name: string, audioSamplePath: string, apiKey?: string): Promise<boolean> {
    const baseUrl = endpoint.replace(/\/$/, "");
    const absPath = audioSamplePath.startsWith("/") ? audioSamplePath : `${this.workspaceRoot}/${audioSamplePath}`;
    try {
      await this.httpJsonPost(`${baseUrl}/v1/speaker/enroll?name=${encodeURIComponent(name)}&audio_path=${encodeURIComponent(absPath)}`, {}, apiKey ? { "Authorization": `Bearer ${apiKey}` } : {});
      return true;
    } catch (e) {
      console.warn("声纹注册失败:", e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  // ---- LLM 总结 ----
  private async runLLMSummarization(
    transcript: TranscriptSegment[], config: LLMConfig, template: SummaryTemplate,
  ): Promise<{ summary: string; keywords: string[]; actionItems: string[] }> {
    const transcriptText = transcript
      .map(s => `[${s.startTime}] ${s.speaker}: ${s.text}`)
      .join("\n\n");

    const userPrompt = `请根据以下转录内容生成总结:\n\n${transcriptText}`;
    let summaryText = "";

    if (config.provider === "anthropic" || config.apiFormat === "anthropic") {
      summaryText = await this.callAnthropic(config, template.systemPrompt, userPrompt);
    } else {
      summaryText = await this.callOpenAICompatible(config, template.systemPrompt, userPrompt);
    }

    const keywords = this.extractKeywords(summaryText);
    const actionItems = this.extractActionItems(summaryText);
    return { summary: summaryText, keywords, actionItems };
  }

  private async callAnthropic(config: LLMConfig, systemPrompt: string, userPrompt: string): Promise<string> {
    let url = config.apiUrl || "https://api.anthropic.com/v1/messages";
    if (!url.endsWith("/messages")) url = url.replace(/\/$/, "") + "/v1/messages";
    const isOfficialAnthropic = url.includes("api.anthropic.com");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (isOfficialAnthropic) {
      headers["x-api-key"] = config.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers["Authorization"] = `Bearer ${config.apiKey}`;
    }

    const { status, data, text } = await this.httpJsonPost(url, {
      model: config.model || "claude-sonnet-4-6",
      max_tokens: config.maxTokens || 4096,
      temperature: config.temperature ?? 0.7,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }, headers);

    if (status >= 400) {
      const errMsg = data.error?.message || data.error?.code || text?.slice(0, 200) || `HTTP ${status}`;
      throw new Error(`LLM API 错误 (${status}): ${errMsg}\n请求地址: ${url}\n模型: ${config.model || "未设置"}`);
    }

    return data.content?.[0]?.text || data.choices?.[0]?.message?.content || "";
  }

  private async callOpenAICompatible(config: LLMConfig, systemPrompt: string, userPrompt: string): Promise<string> {
    let url = config.apiUrl || "https://api.openai.com/v1/chat/completions";
    if (!url.endsWith("/chat/completions")) url = url.replace(/\/$/, "") + "/chat/completions";

    const { status, data } = await this.httpJsonPost(url, {
      model: config.model || "gpt-4o-mini",
      max_tokens: config.maxTokens || 4096,
      temperature: config.temperature ?? 0.7,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }, { "Authorization": `Bearer ${config.apiKey}`, "Content-Type": "application/json" });

    if (status >= 400) {
      const errMsg = data.error?.message || data.error?.code || `HTTP ${status}`;
      throw new Error(`LLM API 错误 (${status}): ${errMsg}\n请求地址: ${url}\n模型: ${config.model || "未设置"}`);
    }

    return data.choices?.[0]?.message?.content || "";
  }

  async callLLM(config: LLMConfig, systemPrompt: string, userPrompt: string): Promise<string> {
    if (config.provider === "anthropic" || config.apiFormat === "anthropic") {
      return this.callAnthropic(config, systemPrompt, userPrompt);
    }
    return this.callOpenAICompatible(config, systemPrompt, userPrompt);
  }

  async matchVoiceprints(
    audioFilePath: string,
    speakerSegments: Array<{ speaker_id: string; starts: number[]; ends: number[] }>,
    voiceprintLibrary: VoiceprintEntry[],
    endpoint: string,
    apiKey?: string,
  ): Promise<Record<string, string>> {
    const baseUrl = endpoint.replace(/\/$/, "");
    const vpLibrary = voiceprintLibrary
      .filter(v => v.audioSamplePath)
      .map(v => ({
        name: v.name,
        audio_path: v.audioSamplePath!.startsWith("/") ? v.audioSamplePath! : `${this.workspaceRoot}/${v.audioSamplePath}`,
      }));

    if (vpLibrary.length === 0) throw new Error("声纹库中没有带样本音频的说话人");

    const enrollUrl = `${baseUrl}/v1/speaker/enroll`;
    for (const vp of vpLibrary) {
      try {
        const params = `name=${encodeURIComponent(vp.name)}&audio_path=${encodeURIComponent(vp.audio_path)}`;
        await this.httpJsonPost(`${enrollUrl}?${params}`, {}, {});
      } catch {}
    }

    const absoluteAudio = audioFilePath.startsWith("/") ? audioFilePath : `${this.workspaceRoot}/${audioFilePath}`;
    const headers: Record<string, string> = apiKey ? { "Authorization": `Bearer ${apiKey}` } : {};

    const { data } = await this.httpJsonPost(`${baseUrl}/v1/speaker/identify`, {
      audio_file: absoluteAudio, speaker_segments: speakerSegments, voiceprint_library: vpLibrary,
    }, headers);

    if (data.error) throw new Error(`声纹识别服务错误: ${data.error}`);

    return data.labels || {};
  }

  async transcribeOnly(
    audioPaths: string[], asrConfig: ASRConfig, speakerConfig: SpeakerDiarizationConfig,
    voiceprintLibrary: VoiceprintEntry[], hotWords: Array<{ word: string; weight?: number }>,
  ): Promise<TranscriptSegment[]> {
    const rawTranscript = await this.runASR(audioPaths, asrConfig, hotWords);
    const transcript = await this.runSpeakerDiarization(rawTranscript, speakerConfig, voiceprintLibrary, audioPaths);
    this.lastTranscript = transcript;
    return transcript;
  }

  async summarizeOnly(
    transcript: TranscriptSegment[], llmConfig: LLMConfig, templateType: TemplateType, customPrompt?: string,
  ): Promise<{ summary: string; keywords: string[]; actionItems: string[] }> {
    let template = getTemplate(templateType);
    if (templateType === "custom" && customPrompt) {
      template = { type: "custom", name: "自定义模板", description: "用户自定义 Prompt", systemPrompt: customPrompt, outputFormat: "" };
    }
    if (!template) throw new Error("未找到指定的总结模板");
    this.lastTranscript = transcript;
    return this.runLLMSummarization(transcript, llmConfig, template);
  }

  cutAudioSegment(audioPath: string, startSec: number, durationSec: number, outputPath: string): void {
    const absPath = audioPath.startsWith("/") ? audioPath : `${this.workspaceRoot}/${audioPath}`;
    execSync(`ffmpeg -y -i "${absPath}" -ss ${startSec} -t ${durationSec} -ar 16000 -ac 1 -sample_fmt s16 "${outputPath}"`, { stdio: "pipe", timeout: 15000 });
  }

  parseTimestamp(ts: string): number {
    const parts = ts.split(":");
    if (parts.length === 3) return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
    return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
  }

  async extractVoiceprintSamples(
    audioPath: string,
    speakerSegments: Map<string, Array<{ startSec: number; text: string }>>,
    outputDir: string,
  ): Promise<Array<{ speakerId: string; displayName: string; candidates: Array<{ audioPath: string; duration: number }> }>> {
    const fs = require("fs");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const results: Array<{ speakerId: string; displayName: string; candidates: Array<{ audioPath: string; duration: number }> }> = [];

    for (const [speakerId, segs] of speakerSegments.entries()) {
      if (segs.length === 0) continue;

      // Diversity sampling: pick up to 3 segments spread across time zones
      const picked = this.pickDiverseSegments(segs, 3);
      const candidates: Array<{ audioPath: string; duration: number }> = [];
      const safeName = speakerId.replace(/[^a-zA-Z0-9一-龥_-]/g, "_");

      for (let i = 0; i < picked.length; i++) {
        const seg = picked[i];
        const clipDuration = Math.min(10, Math.max(1, seg.text.length / 3));
        const timestamp = Date.now();
        const fileName = `sample_${safeName}_${i}_${timestamp}.wav`;
        const outputPath = `${outputDir}/${fileName}`;
        try {
          this.cutAudioSegment(audioPath, seg.startSec, clipDuration, outputPath);
          candidates.push({ audioPath: outputPath, duration: clipDuration });
        } catch (e) {
          console.warn(`声纹采样裁剪失败 (${speakerId} #${i}):`, e instanceof Error ? e.message : String(e));
        }
      }

      if (candidates.length > 0) {
        results.push({ speakerId, displayName: speakerId, candidates });
      }
    }

    if (results.length === 0) throw new Error("所有说话人采样均失败，请检查 ffmpeg 是否安装及音频文件是否完整");
    return results;
  }

  private pickDiverseSegments(
    segs: Array<{ startSec: number; text: string }>,
    count: number,
  ): Array<{ startSec: number; text: string }> {
    if (segs.length <= count) return segs;

    const minTime = Math.min(...segs.map(s => s.startSec));
    const maxTime = Math.max(...segs.map(s => s.startSec + Math.max(1, s.text.length / 3)));
    const range = maxTime - minTime;
    if (range <= 0) return segs.slice(0, count);

    const zoneWidth = range / count;
    const picked: Array<{ startSec: number; text: string }> = [];
    const used = new Set<number>();

    for (let zone = 0; zone < count; zone++) {
      const zoneStart = minTime + zone * zoneWidth;
      const zoneEnd = minTime + (zone + 1) * zoneWidth;
      let bestIdx = -1, bestDur = -1;

      for (let i = 0; i < segs.length; i++) {
        if (used.has(i)) continue;
        const dur = Math.max(1, segs[i].text.length / 3);
        const mid = segs[i].startSec + dur / 2;
        if (mid >= zoneStart && mid < zoneEnd && dur > bestDur) {
          bestIdx = i; bestDur = dur;
        }
      }

      // Fallback: any unused segment
      if (bestIdx < 0) {
        for (let i = 0; i < segs.length; i++) {
          if (used.has(i)) continue;
          const dur = Math.max(1, segs[i].text.length / 3);
          if (dur > bestDur) { bestIdx = i; bestDur = dur; }
        }
      }

      if (bestIdx >= 0) {
        picked.push(segs[bestIdx]);
        used.add(bestIdx);
      }
    }

    return picked;
  }

  // ---- 关键词和行动项提取 ----
  private extractKeywords(text: string): string[] {
    const keywords = new Set<string>();
    const patterns = [/\*\*([^*]+)\*\*/g, /关键词[：:]\s*([^\n]+)/g, /`([^`]+)`/g];
    for (const pattern of patterns) {
      for (const m of text.matchAll(pattern)) {
        const parts = m[1].split(/[,，、;；]/);
        for (const p of parts) {
          const trimmed = p.trim();
          if (trimmed.length > 0 && trimmed.length < 50) keywords.add(trimmed);
        }
      }
    }
    return Array.from(keywords).slice(0, 20);
  }

  private extractActionItems(text: string): string[] {
    const items: string[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- [ ]") || trimmed.startsWith("- []")) {
        items.push(trimmed.replace(/^-\s*\[?\s*\]?\s*/, ""));
      }
      if (trimmed.startsWith("待办") || trimmed.startsWith("TODO") || trimmed.startsWith("任务")) {
        const content = trimmed.replace(/^(待办事项?|TODO|任务)[：:]\s*/, "");
        if (content) items.push(content);
      }
    }
    return items;
  }

  // ---- 工具方法 ----
  private msToTimestamp(totalMs: number): string {
    return this.secondsToTimestamp(totalMs / 1000);
  }

  secondsToTimestamp(totalSeconds: number): string {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = Math.floor(totalSeconds % 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  timestampToSeconds(ts: string): number {
    const parts = ts.split(":");
    return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
  }

  calcDuration(segments: TranscriptSegment[]): number {
    if (segments.length === 0) return 0;
    const last = segments[segments.length - 1];
    const match = last.endTime.match(/(\d+):(\d+):(\d+)/);
    if (match) return parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]);
    return segments.length * 5;
  }

  private detectAudioFormat(url: string): string {
    const lower = url.toLowerCase();
    if (lower.endsWith(".mp3")) return "mp3";
    if (lower.endsWith(".wav")) return "wav";
    if (lower.endsWith(".m4a")) return "m4a";
    if (lower.endsWith(".flac")) return "flac";
    if (lower.endsWith(".ogg")) return "ogg";
    if (lower.endsWith(".aac")) return "aac";
    if (lower.endsWith(".webm")) return "webm";
    return "mp3";
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
