#!/usr/bin/env bun
// FoxAgent MCP Server：把 -p 模式包装成 MCP 工具，供 Claude Code 等客户端全局调用。
// 协议：stdio 上的 JSON-RPC 2.0（MCP 规范），手写不引 SDK，极简。
import { spawn } from "child_process";
import * as path from "path";
import * as readline from "readline";

const CLI_PATH = path.join(__dirname, "cli.ts");

const TOOLS = [
  {
    name: "foxagent",
    description:
      "派任务给 FoxAgent（轻量 coding agent）。它会在指定目录里自主读代码、改文件、跑命令，干完返回完整轨迹。" +
      "适合机械性执行任务（批量修改、按模板铺文件、跑构建验证），不适合需要现场判断的硬仗。",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "任务描述（会作为用户消息发给 FoxAgent）",
        },
        cwd: {
          type: "string",
          description: "工作目录（FoxAgent 在哪个项目里干活），必须是绝对路径",
        },
        continueSession: {
          type: "boolean",
          description: "是否续上最近一次会话（默认 false，开新会话）",
        },
      },
      required: ["task", "cwd"],
    },
  },
];

function send(msg: any) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id: any, result: any) {
  send({ jsonrpc: "2.0", id, result });
}

function error(id: any, code: number, message: string) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function runFoxAgent(task: string, cwd: string, cont: boolean): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve) => {
    const args = [CLI_PATH, "-p", task];
    if (cont) args.push("--continue");
    const child = spawn("bun", args, {
      cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => chunks.push(d));
    child.on("close", (code) => {
      resolve({ output: Buffer.concat(chunks).toString("utf-8"), exitCode: code ?? 1 });
    });
    child.on("error", (e) => {
      resolve({ output: String(e.message), exitCode: 1 });
    });
  });
}

async function handleMessage(msg: any) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "foxagent", version: "0.1.0" },
      });
      break;
    case "notifications/initialized":
      break; // 通知，无需回复
    case "tools/list":
      reply(id, { tools: TOOLS });
      break;
    case "tools/call": {
      const { name, arguments: args } = params ?? {};
      if (name !== "foxagent") {
        error(id, -32601, `未知工具：${name}`);
        break;
      }
      const task = args?.task;
      const cwd = args?.cwd;
      if (!task || !cwd) {
        error(id, -32602, "缺少 task 或 cwd 参数");
        break;
      }
      const result = await runFoxAgent(task, cwd, !!args?.continueSession);
      reply(id, {
        content: [
          {
            type: "text",
            text: result.output || "（无输出）",
          },
        ],
        isError: result.exitCode !== 0,
      });
      break;
    }
    default:
      if (id !== undefined) {
        error(id, -32601, `不支持的方法：${method}`);
      }
  }
}

// MCP stdio 传输层：每行一条 JSON（不是 LSP 的 Content-Length 分帧）
const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const body = line.trim();
  if (!body) return;
  try {
    handleMessage(JSON.parse(body));
  } catch {}
});

rl.on("close", () => process.exit(0));
