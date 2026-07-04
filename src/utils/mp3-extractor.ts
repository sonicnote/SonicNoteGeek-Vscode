import * as vscode from "vscode";

/**
 * 从 Markdown 文本中提取音频链接 (支持 mp3/m4a/wav/flac/ogg 等格式)
 */
export function extractAudioLinks(markdown: string): string[] {
  const links = new Set<string>();

  // YAML frontmatter audio_url (audio file URLs)
  const yamlAudioRegex = /^audio_url:\s*["']?([^\s"'\n]+\.(?:mp3|m4a|wav|flac|ogg|aac|wma|webm|opus|amr|aiff))["']?\s*$/gim;
  for (const m of markdown.matchAll(yamlAudioRegex)) {
    links.add(m[1]);
  }

  // YAML frontmatter audio_url (directory/base URLs, no file extension)
  const yamlAudioUrlRegex = /^audio_url:\s*["']?(https?:\/\/[^\s"'\n]+)["']?\s*$/gim;
  for (const m of markdown.matchAll(yamlAudioUrlRegex)) {
    links.add(m[1]);
  }

  // Inline audio_url
  const inlineAudioRegex = /audio_url:\s*["']?([^\s"'\n,]+\.(?:mp3|m4a|wav|flac|ogg|aac|wma|webm|opus|amr|aiff))["']?/gi;
  for (const m of markdown.matchAll(inlineAudioRegex)) {
    links.add(m[1]);
  }

  // Markdown embed: ![[xxx.mp3]]
  const embedRegex = /!\[\[([^\]]+\.(?:mp3|m4a|wav|flac|ogg|aac|wma|webm|opus|amr|aiff|au|ra|mid|mka|ac3|eac3|pcm))\]\]/gi;
  for (const m of markdown.matchAll(embedRegex)) {
    links.add(m[1]);
  }

  // Markdown link: [text](xxx.mp3)
  const mdLinkRegex = /\[([^\]]*)\]\(([^)]+\.(?:mp3|m4a|wav|flac|ogg|aac|wma|webm|opus|amr|aiff|au|ra|mid|mka|ac3|eac3|pcm))\)/gi;
  for (const m of markdown.matchAll(mdLinkRegex)) {
    links.add(m[2]);
  }

  // Bare HTTPS URL
  const bareUrlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+\.(?:mp3|m4a|wav|flac|ogg|aac|wma|webm|opus|amr|aiff)/gi;
  for (const m of markdown.matchAll(bareUrlRegex)) {
    links.add(m[0]);
  }

  // HTML audio embed
  const htmlAudioRegex = /<audio[^>]+src=["']([^"']+\.(?:mp3|m4a|wav|flac|ogg|aac|wma|webm|opus|amr|aiff))["']/gi;
  for (const m of markdown.matchAll(htmlAudioRegex)) {
    links.add(m[1]);
  }

  // Internal link: [[xxx.mp3]]
  const internalLinkRegex = /\[\[([^\]]+\.(?:mp3|m4a|wav|flac|ogg|aac|wma|webm|opus|amr|aiff|au|ra|mid|mka|ac3|eac3|pcm))\]\]/gi;
  for (const m of markdown.matchAll(internalLinkRegex)) {
    if (!m[0].startsWith("!")) {
      links.add(m[1]);
    }
  }

  return Array.from(links);
}

/**
 * 在 workspace 中查找 MP3 附件
 */
export async function findAudioAttachments(sourceUri: vscode.Uri): Promise<string[]> {
  const results: string[] = [];
  const parentDir = vscode.Uri.joinPath(sourceUri, "..");

  try {
    const files = await vscode.workspace.fs.readDirectory(parentDir);
    for (const [name, type] of files) {
      if (type === vscode.FileType.File && name.match(/\.(?:mp3|m4a|wav|flac|ogg|aac|wma|webm|opus|amr|aiff)$/i)) {
        results.push(vscode.Uri.joinPath(parentDir, name).fsPath);
      }
    }
  } catch {
    // Directory read failed
  }

  // Also check attachments/assets directories
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders) {
    for (const folder of workspaceFolders) {
      for (const subDir of ["attachments", "assets", "音频"]) {
        try {
          const dirUri = vscode.Uri.joinPath(folder.uri, subDir);
          const files = await vscode.workspace.fs.readDirectory(dirUri);
          for (const [name, type] of files) {
            if (type === vscode.FileType.File && name.match(/\.(?:mp3|m4a|wav|flac|ogg|aac|wma|webm|opus|amr|aiff)$/i)) {
              results.push(vscode.Uri.joinPath(dirUri, name).fsPath);
            }
          }
        } catch {
          // Directory doesn't exist
        }
      }
    }
  }

  return results;
}
