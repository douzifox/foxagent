// 聊天面板的界面：单文件内联，跟随 VS Code 主题变量，无外部依赖
export function getChatHtml(nonce: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    display: flex; flex-direction: column;
  }
  #messages { flex: 1; overflow-y: auto; padding: 8px; }
  .msg { margin-bottom: 10px; line-height: 1.5; word-break: break-word; }
  .msg .who { font-size: 0.85em; opacity: 0.6; margin-bottom: 2px; }
  .msg.user .bubble {
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 6px; padding: 6px 8px; white-space: pre-wrap;
  }
  .msg.assistant .bubble { white-space: pre-wrap; }
  .msg.thinking { opacity: 0.55; font-style: italic; white-space: pre-wrap; font-size: 0.9em; }
  .msg.status { opacity: 0.6; font-size: 0.85em; text-align: center; }
  .msg.error { color: var(--vscode-errorForeground); white-space: pre-wrap; }
  details.tool {
    margin-bottom: 8px; font-size: 0.9em;
    border-left: 2px solid var(--vscode-focusBorder);
    padding-left: 8px;
  }
  details.tool summary { cursor: pointer; opacity: 0.8; user-select: none; }
  details.tool pre, .diffBox pre {
    margin-top: 4px; padding: 6px;
    background: var(--vscode-textCodeBlock-background);
    border-radius: 4px; overflow-x: auto;
    font-family: var(--vscode-editor-font-family); font-size: 0.95em;
    white-space: pre-wrap;
  }
  .diffBox {
    margin-bottom: 10px; font-size: 0.9em;
    border: 1px solid var(--vscode-focusBorder); border-radius: 6px; padding: 8px;
  }
  .diffBox .file { font-weight: bold; margin-bottom: 4px; }
  .diffBox .line-add { color: var(--vscode-gitDecoration-addedResourceForeground, #4caf50); }
  .diffBox .line-del { color: var(--vscode-gitDecoration-deletedResourceForeground, #f44336); }
  .diffBox .line-hunk { color: var(--vscode-textLink-foreground); opacity: 0.8; }
  .diffBox .btns { margin-top: 6px; display: flex; gap: 6px; }
  .diffBox .verdict { margin-top: 6px; font-size: 0.9em; opacity: 0.7; }
  #status { padding: 2px 10px; font-size: 0.85em; opacity: 0.6; height: 20px; }
  #inputRow { display: flex; padding: 8px; gap: 6px; border-top: 1px solid var(--vscode-panel-border); }
  textarea {
    flex: 1; resize: none; min-height: 52px; max-height: 160px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px; padding: 6px 8px;
    font-family: inherit; font-size: inherit; outline: none;
  }
  textarea:focus { border-color: var(--vscode-focusBorder); }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; border-radius: 4px; padding: 4px 14px; cursor: pointer;
  }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button:disabled { opacity: 0.5; cursor: default; }
  button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
  <div id="messages"></div>
  <div id="status"></div>
  <div id="inputRow">
    <textarea id="input" placeholder="想让我做什么？（Enter 发送，Shift+Enter 换行）"></textarea>
    <button id="send">发送</button>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const statusEl = document.getElementById('status');
  let busy = false;

  function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

  function addBubble(cls, who, text) {
    const div = document.createElement('div');
    div.className = 'msg ' + cls;
    if (who) {
      const whoEl = document.createElement('div');
      whoEl.className = 'who';
      whoEl.textContent = who;
      div.appendChild(whoEl);
    }
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    div.appendChild(bubble);
    messagesEl.appendChild(div);
    scrollBottom();
  }

  function addTool(name, argsText) {
    const details = document.createElement('details');
    details.className = 'tool';
    const summary = document.createElement('summary');
    summary.textContent = '🔧 ' + name;
    const pre = document.createElement('pre');
    pre.textContent = argsText;
    details.appendChild(summary);
    details.appendChild(pre);
    messagesEl.appendChild(details);
    scrollBottom();
    return details;
  }

  function renderDiff(pre, diffText) {
    for (const line of diffText.split('\\n')) {
      const span = document.createElement('span');
      if (line.startsWith('+')) span.className = 'line-add';
      else if (line.startsWith('-')) span.className = 'line-del';
      else if (line.startsWith('@@')) span.className = 'line-hunk';
      span.textContent = line + '\\n';
      pre.appendChild(span);
    }
  }

  // 修改展示块：红绿 diff，自动应用后的记录
  function addEditBlock(file, diffText) {
    const box = document.createElement('div');
    box.className = 'diffBox';
    const fileEl = document.createElement('div');
    fileEl.className = 'file';
    fileEl.textContent = '✏️ ' + file;
    const pre = document.createElement('pre');
    renderDiff(pre, diffText);
    const verdict = document.createElement('div');
    verdict.className = 'verdict';
    verdict.textContent = '✅ 已应用';
    box.appendChild(fileEl);
    box.appendChild(pre);
    box.appendChild(verdict);
    messagesEl.appendChild(box);
    scrollBottom();
  }

  function setBusy(b) {
    busy = b;
    sendBtn.textContent = b ? '停止' : '发送';
    statusEl.textContent = b ? '🦊 干活中…（继续输入会排队）' : '';
  }

  function send() {
    const text = inputEl.value.trim();
    if (!text) return;
    addBubble('user', '我', text);
    inputEl.value = '';
    if (!busy) setBusy(true);
    vscode.postMessage({ type: 'send', text });
  }

  sendBtn.addEventListener('click', () => {
    if (busy) vscode.postMessage({ type: 'stop' });
    else send();
  });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  const toolStack = []; // 工具块栈：回放历史时多个 tool 可能连续到达再依次配对 result
  let streamBubble = null; // 流式渲染中的气泡 {kind, el}
  window.addEventListener('message', (event) => {
    const m = event.data;
    if (m.type !== 'delta' && m.type !== 'delta_end') streamBubble = null;
    switch (m.type) {
      case 'delta': {
        if (!streamBubble || streamBubble.kind !== m.kind) {
          const cls = m.kind === 'thinking' ? 'thinking' : 'assistant';
          const who = m.kind === 'thinking' ? '💭 思考' : '🦊 FoxAgent';
          addBubble(cls, who, '');
          const el = messagesEl.lastChild.querySelector('.bubble');
          streamBubble = { kind: m.kind, el };
        }
        streamBubble.el.textContent += m.text;
        scrollBottom();
        break;
      }
      case 'delta_end': streamBubble = null; break;
      case 'user': addBubble('user', '我', m.text); break;
      case 'thinking': addBubble('thinking', '💭 思考', m.text); break;
      case 'text': addBubble('assistant', '🦊 FoxAgent', m.text); break;
      case 'tool':
        toolStack.push(addTool(m.name, m.args));
        break;
      case 'tool_result': {
        const block = toolStack.shift();
        if (block) {
          const pre = document.createElement('pre');
          pre.textContent = m.output;
          block.appendChild(pre);
          scrollBottom();
        }
        break;
      case 'editApplied': addEditBlock(m.file, m.diff); break;
      case 'status': addBubble('status', '', m.text); break;
      case 'error': addBubble('error', '⚠️ 出错了', m.text); break;
      case 'done': setBusy(false); break;
      case 'clear': messagesEl.innerHTML = ''; toolStack.length = 0; setBusy(false); break;
    }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
