# Cloudflare Worker Feasibility Analysis for Cyrus

## Executive Summary

**Can Cyrus run as a Cloudflare Worker?**
- ❌ **Not the full application** - too many Node.js dependencies and long-running operations
- ✅ **Simplified version possible** - webhook receiver + API-only interactions (no file ops, no git, no tools)
- ✅ **Hybrid architecture recommended** - CF Worker for webhooks, separate runtime for heavy lifting

**Can you implement your own Claude Agent runtime?**
- ✅ **Yes, absolutely!** The codebase already uses `@anthropic-ai/claude-agent-sdk`
- ✅ **Can bypass SDK** - Call Anthropic API directly for full control
- ✅ **Example provided** - See `/home/user/cyrus/docs/custom-claude-runtime-example.ts`

---

## Current Architecture Analysis

### What Cyrus Does Today

```
┌─────────────────────────────────────────────────────────────┐
│ Cyrus CLI / Electron App (runs on your machine)            │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ EdgeWorker (Node.js)                                 │  │
│  │  ├─ Fastify HTTP Server (webhooks)                   │  │
│  │  ├─ AgentSessionManager                              │  │
│  │  │  ├─ ClaudeRunner (uses @anthropic-ai/sdk)        │  │
│  │  │  └─ LinearClient (@linear/sdk)                    │  │
│  │  ├─ Git Operations (worktree, commit, push)          │  │
│  │  ├─ File System (logs, attachments, configs)         │  │
│  │  └─ MCP Servers (Linear, custom tools)               │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
│  Exposes webhooks via:                                      │
│  └─ Cloudflare Tunnel (tunnels local port to internet)     │
└─────────────────────────────────────────────────────────────┘
                      ▲
                      │ webhooks
                      │
                ┌─────┴──────┐
                │   Linear    │
                └────────────┘
```

**Key Dependencies:**
- **Node.js native modules**: `fs/promises`, `path`, `child_process`, `events`
- **Long-running processes**: Claude sessions can take minutes/hours
- **File system**: Git repos, worktrees, logs, attachments
- **Git CLI**: Creating branches, commits, PRs
- **Claude Agent SDK**: `@anthropic-ai/claude-agent-sdk` for agent capabilities

---

## Cloudflare Workers Constraints

### What CF Workers CAN'T Do

| Feature | CF Worker Limitation | Cyrus Requirement |
|---------|---------------------|-------------------|
| **File System** | No `fs` access | Needs git repos, logs, attachments |
| **Process Spawning** | No `child_process` | Needs git commands, possibly Claude CLI |
| **Long Duration** | 30s max (paid), 10ms CPU | Claude sessions can run indefinitely |
| **Native Modules** | V8 isolates only | Uses Node.js APIs heavily |
| **Persistent State** | Must use KV/R2/DO | Uses local file system |
| **Git Operations** | No git CLI | Core feature: worktrees, commits, PRs |

### What CF Workers CAN Do

| Feature | How It Works | Useful For |
|---------|--------------|------------|
| **HTTP Requests** | `fetch()` API | ✅ Calling Claude API directly |
| **Durable Objects** | Distributed state | ✅ Session tracking |
| **KV Storage** | Key-value store | ✅ Config, tokens |
| **R2 Storage** | Object storage | ✅ Attachments, logs |
| **Queues** | Async job processing | ✅ Triggering long operations |
| **Workers Analytics** | Monitoring | ✅ Usage tracking |

---

## Option 1: Pure Cloudflare Worker (Limited)

### What You Could Build

A **stateless webhook handler** that:
1. ✅ Receives Linear webhooks
2. ✅ Calls Claude API directly (no tools, no file access)
3. ✅ Posts simple responses back to Linear
4. ❌ **No git operations**
5. ❌ **No file system access**
6. ❌ **No multi-turn conversations** (30s timeout)
7. ❌ **No code editing**

### Implementation Sketch

```typescript
// worker.ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 1. Receive Linear webhook
    const { issue, type } = await request.json();

    if (type !== 'Issue' || issue.assignee?.id !== env.BOT_USER_ID) {
      return new Response('Ignored', { status: 200 });
    }

    // 2. Build prompt from issue
    const prompt = `
      Linear Issue: ${issue.title}
      Description: ${issue.description}

      Please provide implementation guidance.
    `;

    // 3. Call Claude API (simple, non-agentic)
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    const answer = data.content[0].text;

    // 4. Post back to Linear
    await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Authorization': env.LINEAR_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: `
          mutation CreateComment($issueId: String!, $body: String!) {
            commentCreate(input: {issueId: $issueId, body: $body}) {
              success
            }
          }
        `,
        variables: {
          issueId: issue.id,
          body: answer
        }
      })
    });

    return new Response('OK');
  }
};
```

### Limitations

- 🚫 **No actual code changes** - Claude can only provide guidance
- 🚫 **No file reading** - Can't see existing codebase
- 🚫 **No git operations** - Can't create branches/commits/PRs
- 🚫 **No tool use** - No bash, edit, read, etc.
- 🚫 **No MCP servers** - Unless HTTP-based
- 🚫 **Single-turn only** - Can't have back-and-forth conversation
- 🚫 **30s timeout** - Complex issues would fail

**Verdict: This would be a severely limited version, basically just a chatbot**

---

## Option 2: Hybrid Architecture (Recommended)

### Split Responsibilities

```
┌─────────────────────────────────────────────┐
│ Cloudflare Worker (Edge)                    │
│  ├─ Receive webhooks from Linear            │
│  ├─ Validate & authenticate                 │
│  ├─ Store in Durable Objects                │
│  ├─ Enqueue job to Worker Queue             │
│  └─ Return 200 OK immediately               │
└────────────┬────────────────────────────────┘
             │
             │ (via queue or webhook)
             ▼
┌─────────────────────────────────────────────┐
│ Long-Running Worker                          │
│ (Your machine, VM, or Cloudflare Workers AI) │
│                                              │
│  ├─ Polls queue / receives webhook          │
│  ├─ Runs full EdgeWorker (Node.js)          │
│  ├─ Git operations (worktree, commit, PR)   │
│  ├─ Full file system access                 │
│  ├─ Claude Agent SDK with all tools         │
│  └─ Posts results back to Linear            │
└──────────────────────────────────────────────┘
```

### Benefits

- ✅ **Reliable webhook handling** - CF Worker never times out
- ✅ **Full agent capabilities** - Long-running worker has no constraints
- ✅ **Scalable** - CF Worker handles traffic spikes
- ✅ **Simple** - Long-running worker can be your existing Cyrus CLI
- ✅ **Cost-effective** - CF Worker is cheap, run worker only when needed

### Implementation

**Cloudflare Worker:**
```typescript
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const webhook = await request.json();

    // Store in Durable Object for state tracking
    const id = env.SESSIONS.idFromName(webhook.issue.id);
    const session = env.SESSIONS.get(id);
    await session.fetch(request);

    // Enqueue job
    await env.ISSUE_QUEUE.send({
      issueId: webhook.issue.id,
      type: webhook.type,
      timestamp: Date.now()
    });

    return new Response('Queued', { status: 202 });
  }
};
```

**Long-Running Worker (Node.js):**
```typescript
// This is essentially your existing Cyrus CLI
// Just add a queue consumer:

import { EdgeWorker } from 'cyrus-edge-worker';

const worker = new EdgeWorker({ /* config */ });
await worker.start();

// Poll Cloudflare Queue
while (true) {
  const jobs = await pollQueue(env.ISSUE_QUEUE);

  for (const job of jobs) {
    // EdgeWorker already handles this!
    worker.emit('webhook', {
      issueId: job.issueId,
      type: job.type
    });
  }

  await sleep(1000);
}
```

---

## Option 3: Cloudflare Workers AI (Experimental)

Cloudflare recently launched [Workers AI](https://ai.cloudflare.com/) which removes some constraints:

### What's Different

- ✅ **Longer execution time** - Up to 15 minutes
- ✅ **Access to AI models** - Including Claude via API
- ✅ **Still no file system** - But could use R2
- ✅ **Still no git** - Would need to implement via API (GitHub API)

### Feasibility

You could potentially build:
1. ✅ Webhook handler
2. ✅ Long-running Claude conversations (15 min limit)
3. ✅ GitHub API integration (instead of git CLI)
4. ❌ **No local git worktrees** - would need to work directly with GitHub
5. ❌ **No local codebase reading** - would need to fetch via API

**Verdict: Possible but requires significant rearchitecture**

---

## Implementing Your Own Claude Agent Runtime

Good news! **The codebase already shows you exactly how.**

### Current Implementation Uses SDK

```typescript
// packages/claude-runner/src/ClaudeRunner.ts
import { query } from "@anthropic-ai/claude-agent-sdk";

const queryOptions = {
  prompt: "Your task here",
  options: {
    model: "sonnet",
    cwd: process.cwd(),
    allowedTools: ["bash", "edit", "read"],
    mcpServers: {
      linear: {
        type: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: `Bearer ${token}` }
      }
    }
  }
};

// Stream messages from Claude
for await (const message of query(queryOptions)) {
  if (message.type === "assistant") {
    // Handle text, tool use
  }
  if (message.type === "result") {
    // Session complete
    break;
  }
}
```

### Building Your Own Runtime

**Two approaches:**

#### 1. Use Anthropic SDK Directly (No Agent SDK)

```typescript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Define tools
const tools = [
  {
    name: 'bash',
    description: 'Execute bash command',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string' }
      },
      required: ['command']
    }
  }
];

// Multi-turn conversation with tool use
let messages = [
  { role: 'user', content: 'Read package.json and list dependencies' }
];

while (true) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8096,
    tools,
    messages
  });

  // Check for tool use
  const toolUse = response.content.find(block => block.type === 'tool_use');

  if (toolUse) {
    // Execute tool
    const result = await executeTool(toolUse.name, toolUse.input);

    // Add to conversation
    messages.push({ role: 'assistant', content: response.content });
    messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result
      }]
    });
  } else {
    // Done
    console.log(response.content[0].text);
    break;
  }
}
```

#### 2. Custom Implementation (Full Control)

See `/home/user/cyrus/docs/custom-claude-runtime-example.ts` for complete example.

### Advantages of Custom Runtime

- ✅ **Full control** over conversation flow
- ✅ **Custom tools** specific to your use case
- ✅ **Different backends** - could even use non-Claude models
- ✅ **Custom state management** - works with KV, Durable Objects, etc.
- ✅ **Fine-grained logging** and monitoring
- ✅ **Cost optimization** - choose exactly when to call API

### Disadvantages vs SDK

- ❌ **More code to maintain**
- ❌ **Need to implement tool execution yourself**
- ❌ **Miss out on SDK features** (hooks, settings, etc.)
- ❌ **Authentication handling**

---

## Recommendations

### For Cloudflare Workers Deployment

**Go with Hybrid Architecture (Option 2):**

1. **CF Worker** handles webhooks:
   ```typescript
   // Receives Linear webhooks
   // Validates & enqueues
   // Returns 202 Accepted immediately
   ```

2. **Your machine/VM** runs Cyrus:
   ```bash
   # Existing Cyrus CLI with queue consumer
   cyrus --mode worker --queue-url $QUEUE_URL
   ```

3. **Benefits:**
   - ✅ Reliable webhook delivery
   - ✅ Full Cyrus capabilities
   - ✅ Easy to implement
   - ✅ Low cost

### For Custom Runtime

**Start with SDK, customize as needed:**

1. **Use `@anthropic-ai/sdk`** for API calls
2. **Implement your own tool execution** layer
3. **Add custom state management** for your environment
4. **Gradually replace** SDK components as needed

### Migration Path

```
Phase 1: Current State
├─ Cyrus CLI (local machine)
└─ Cloudflare Tunnel (expose webhooks)

Phase 2: Hybrid (Recommended Next Step)
├─ Cloudflare Worker (webhook receiver)
├─ Cloudflare Queue (job queue)
└─ Cyrus CLI (queue consumer, unchanged logic)

Phase 3: Fully Cloud (Future)
├─ Cloudflare Worker (webhooks)
├─ Cloudflare Workers AI (limited agent)
└─ GitHub API (replace local git)

Phase 4: Custom Runtime (If needed)
└─ Your own implementation
    ├─ Anthropic API (direct)
    ├─ Custom tools
    └─ Any backend (Durable Objects, Postgres, etc.)
```

---

## Conclusion

### Can it run as Cloudflare Worker?

**Partially.** You can:
- ✅ Run webhook receiver in CF Worker
- ✅ Use CF Queue to trigger long-running operations
- ✅ Build a simplified, chatbot-like version (no git, no tools)
- ❌ Cannot run full EdgeWorker with git/file operations

### Can you implement your own runtime?

**Absolutely!** You can:
- ✅ Use Anthropic SDK directly (skip Claude Agent SDK)
- ✅ Implement custom tool execution
- ✅ Control conversation flow completely
- ✅ Adapt to any environment (CF Workers, Lambda, etc.)

### Best Path Forward

**Hybrid architecture** is the sweet spot:
1. CF Worker for reliable webhook handling
2. Existing Cyrus on your machine/VM for heavy lifting
3. Migrate gradually to cloud as needed
4. Custom runtime only if you need special features

---

## Additional Resources

- **Custom Runtime Example**: `/home/user/cyrus/docs/custom-claude-runtime-example.ts`
- **Current EdgeWorker**: `/home/user/cyrus/packages/edge-worker/src/EdgeWorker.ts`
- **ClaudeRunner Implementation**: `/home/user/cyrus/packages/claude-runner/src/ClaudeRunner.ts`
- **Anthropic SDK Docs**: https://docs.anthropic.com/
- **Cloudflare Workers Docs**: https://developers.cloudflare.com/workers/
- **MCP Protocol**: https://code.claude.com/docs/en/mcp
