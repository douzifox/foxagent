import * as vscode from "vscode";
import { runAgent, ChatMessage } from "./agent";
import { loadConfig } from "./config";
import { flushJournal, mergePending } from "./journal";
import { buildSystemPrompt } from "./prompt";
import { getChatHtml } from "./webviewContent";
import { Session, createSession, saveSession, loadLatestSession } from "./session";

class ChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private session: Session = createSession();
  private busy = false;
  private abort: AbortController | null = null;
  private queue: string[] = []; // 干活时用户继续发的消息，本轮结束后依次处理

  private get root(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    const nonce = Math.random().toString(36).slice(2);
    webviewView.webview.html = getChatHtml(nonce);

    webviewView.webview.onDidReceiveMessage(async (m) => {
      switch (m.type) {
        case "ready":
          this.restoreSession();
          break;
        case "send":
          await this.handleSend(m.text);
          break;
        case "stop":
          this.abort?.abort();
          break;
      }
    });
  }

  // 面板打开时接上上次会话，把历史消息回放到界面
  private restoreSession(): void {
    if (!this.root) return;
    if (this.busy) return; // 正在跑就别替换会话，否则当前轮的产出会丢
    const latest = loadLatestSession(this.root);
    if (!latest) return;
    this.session = latest;
    this.post({ type: "clear" });
    for (const msg of this.session.messages) {
      if (msg.role === "user") {
        this.post({ type: "user", text: msg.content });
      } else if (msg.role === "assistant") {
        if (msg.thinking) this.post({ type: "thinking", text: msg.thinking });
        for (const call of msg.tool_calls || []) {
          this.post({
            type: "tool",
            name: call.function?.name,
            args: JSON.stringify(call.function?.arguments, null, 2),
          });
        }
        if (msg.content) this.post({ type: "text", text: msg.content });
      } else if (msg.role === "tool") {
        this.post({ type: "tool_result", name: msg.tool_name, output: msg.content });
      }
    }
    this.post({ type: "status", text: `已恢复会话「${this.session.title}」` });
  }

  newSession(): void {
    if (this.busy) {
      this.post({ type: "status", text: "正在干活，请先停止当前轮再开新会话" });
      return;
    }
    // 会话切换 = 任务收尾：把累积的动作与坑写进 journal
    if (this.root) {
      flushJournal(this.root, this.session.pending);
      this.session.pending = undefined;
      saveSession(this.root, this.session);
    }
    this.session = createSession();
    this.post({ type: "clear" });
  }

  private post(msg: any): void {
    this.view?.webview.postMessage(msg);
  }

  private async handleSend(text: string): Promise<void> {
    if (this.busy) {
      this.queue.push(text);
      this.post({ type: "status", text: "已排队，本轮结束后发送" });
      return;
    }

    const root = this.root;
    if (!root) {
      this.post({ type: "error", text: "请先打开一个文件夹（工作区），我才知道在哪干活。" });
      this.post({ type: "done" });
      return;
    }

    let config;
    try {
      config = loadConfig();
    } catch (e: any) {
      this.post({
        type: "error",
        text:
          String(e.message || e) +
          "\n（提示：Mac 上双击启动的 VS Code 读不到 shell 环境变量，请从终端用 code 命令启动）",
      });
      this.post({ type: "done" });
      return;
    }

    // 锁定本轮的会话引用：即使跑的过程中 this.session 被 newSession/restoreSession
    // 换掉，这一轮的累积与保存也始终作用在正确的会话上，不丢数据
    const session = this.session;
    const messages = session.messages;
    if (messages.length === 0) {
      messages.push({ role: "system", content: buildSystemPrompt(root) });
    }
    messages.push({ role: "user", content: text });

    this.busy = true;
    this.abort = new AbortController();
    try {
      const round = await runAgent({
        ...config,
        root,
        signal: this.abort.signal,
        messages,
        onEvent: (e) => {
          switch (e.type) {
            case "delta":
              this.post({ type: "delta", kind: e.kind, text: e.text });
              break;
            case "delta_end":
              this.post({ type: "delta_end" });
              break;
            case "thinking":
              this.post({ type: "thinking", text: e.text });
              break;
            case "text":
              this.post({ type: "text", text: e.text });
              break;
            case "tool":
              this.post({
                type: "tool",
                name: e.name,
                args: JSON.stringify(e.args, null, 2),
              });
              break;
            case "tool_result":
              this.post({ type: "tool_result", name: e.name, output: e.output });
              break;
            case "status":
              this.post({ type: "status", text: e.text });
              break;
            case "error":
              this.post({ type: "error", text: e.text });
              break;
          }
        },
        // 只有危险命令（rm、git push 等）才会走到这里
        confirmCommand: async (cmd) => {
          const pick = await vscode.window.showWarningMessage(
            `FoxAgent 想执行危险命令：\n\n${cmd}`,
            { modal: true },
            "执行"
          );
          return pick === "执行";
        },
        // ask 工具：模型拿不准时弹输入框问真人。Esc 取消/空回答 → 当作不在线
        askUser: async (q) => {
          const a = await vscode.window.showInputBox({
            prompt: q,
            ignoreFocusOut: true,
            placeHolder: "回答 FoxAgent 的提问（Esc 跳过）",
          });
          return a === undefined || a.trim() === "" ? null : a.trim();
        },
        // 修改自动应用，diff 展示在聊天面板里
        showEdit: (file, diffText) => {
          this.post({ type: "editApplied", file, diff: diffText });
        },
      });
      session.pending = mergePending(session.pending, text, round);
      // 成功 commit = 任务完成的确定信号，当场落盘这条任务记录
      if (round.committed) {
        flushJournal(root, session.pending);
        session.pending = undefined;
      }
    } catch (e: any) {
      this.post({ type: "error", text: String(e.message || e) });
    } finally {
      this.busy = false;
      this.abort = null;
      saveSession(root, session);
      this.post({ type: "done" });
      // 处理干活期间排队的消息
      const next = this.queue.shift();
      if (next !== undefined) {
        await this.handleSend(next);
      }
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("foxagent.chat", provider),
    vscode.commands.registerCommand("foxagent.newSession", () => provider.newSession())
  );
}

export function deactivate(): void {}
