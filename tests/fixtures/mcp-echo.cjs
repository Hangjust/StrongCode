const { writeFileSync } = require("node:fs");
const readline = require("node:readline");

const marker = process.argv[2];
if (marker) writeFileSync(marker, process.cwd(), "utf8");

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send(message.id, {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "strongcode-test-mcp", version: "1.0.0" }
    });
  } else if (message.method === "tools/list") {
    send(message.id, {
      tools: [
        {
          name: "echo",
          description: "Echo input for the StrongCode MCP integration test.",
          inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
          annotations: { readOnlyHint: true }
        },
        {
          name: "search",
          description: "Return a deterministic search result.",
          inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          annotations: { readOnlyHint: true }
        },
        {
          name: "delegate_task",
          description: "Delegation-shaped tool used to verify child policy.",
          inputSchema: { type: "object", properties: {} }
        }
      ]
    });
  } else if (message.method === "tools/call") {
    const args = message.params.arguments || {};
    const text = message.params.name === "search" ? `result:${args.query}` : String(args.value ?? "");
    send(message.id, { content: [{ type: "text", text }] });
  } else if (message.id !== undefined) {
    send(message.id, {});
  }
});
