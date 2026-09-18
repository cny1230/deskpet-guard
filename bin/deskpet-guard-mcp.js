#!/usr/bin/env node
/**
 * deskpet-guard MCP server（stdio）。
 *
 * 给别的 agent / MCP 客户端（Claude Desktop、Cline、其它 DSH 实例…）用：
 *
 *   {
 *     "mcpServers": {
 *       "deskpet-guard": {
 *         "command": "node",
 *         "args": ["D:/deskpet-guard/bin/deskpet-guard-mcp.js"]
 *       }
 *     }
 *   }
 *
 * 可选环境变量：
 *   DESKPET_GUARD_DIR       数据目录（默认 $DSH_HOME/super-injector/deskpet-guard）
 *   DESKPET_GUARD_ENDPOINT  host API 基址（默认读 endpoint.json，再退到 http://127.0.0.1:3080）
 *   DESKPET_GUARD_SECRET    确认密钥（默认读数据目录下 0600 的 confirm-secret.json）
 *
 * 只读工具在 host 不可达时降级本地；终止类工具必须 host 在跑（token 由 host 签发）。
 */
import { serveStdio } from '../lib/mcp.js'

serveStdio()
