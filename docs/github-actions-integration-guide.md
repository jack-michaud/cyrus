# Integrating Cyrus Components with GitHub Actions Claude Code

This guide shows you exactly which pieces from Cyrus you can reuse to:
1. Trigger your existing GitHub Actions Claude Code workflow from Linear issues
2. Use the Linear Agent Activity UI for real-time updates

## Architecture Overview

### Current Setup (Cyrus)
```
Linear Issue Assigned
  ↓
Webhook → EdgeWorker
  ↓
ClaudeRunner (local execution)
  ↓
Posts to Linear Agent Activity UI
```

### Your Target Setup
```
Linear Issue Assigned
  ↓
Webhook → Your Adapter
  ↓
Trigger GitHub Actions (your existing workflow)
  ↓
Stream updates to Linear Agent Activity UI
```

---

## Components You Should Take

### 1. **LinearEventTransport** (Take as-is ✅)

**Location**: `/home/user/cyrus/packages/linear-event-transport/`

**What it does**:
- Handles Linear webhook authentication
- Fastify endpoint for `/webhook`
- Supports two modes:
  - Direct mode: Verifies Linear's webhook signature
  - Proxy mode: Bearer token auth

**Usage**:
```typescript
import { LinearEventTransport } from 'cyrus-linear-event-transport';
import Fastify from 'fastify';

const app = Fastify();

const transport = new LinearEventTransport({
  fastifyServer: app,
  verificationMode: 'direct', // or 'proxy'
  secret: process.env.LINEAR_WEBHOOK_SECRET
});

transport.register();

transport.on('webhook', (payload) => {
  console.log('Received webhook:', payload);
  // Your GitHub Actions trigger logic here
});

await app.listen({ port: 3000 });
```

**Why take it**: Rock-solid webhook handling, already tested and working.

---

### 2. **AgentSessionManager** (Adapt 🔧)

**Location**: `/home/user/cyrus/packages/edge-worker/src/AgentSessionManager.ts`

**What it does**:
- Creates Linear Agent Activity Sessions
- Posts updates to Linear UI (thoughts, actions, responses, errors)
- Manages session lifecycle

**Key Methods to Extract**:

#### Create Session
```typescript
// From AgentSessionManager.ts:75
createLinearAgentSession(
  linearAgentActivitySessionId: string,
  issueId: string,
  issueMinimal: IssueMinimal,
  workspace: Workspace
): CyrusAgentSession
```

#### Post Updates to Linear
```typescript
// Core API call (line 1411-1417):
await this.linearClient.createAgentActivity({
  agentSessionId: linearAgentActivitySessionId,
  content: {
    type: "thought", // or "action", "response", "error"
    body: "Your message here"
  },
  ephemeral: false // true for transient messages
});
```

**Activity Types**:
- `thought` - Internal reasoning, status updates
- `action` - Tool/command execution (shows loading state)
- `response` - Final answer to user
- `error` - Error messages

**What to adapt**:
```typescript
// Your simplified version:
class GitHubActionsAdapter {
  constructor(private linearClient: LinearClient) {}

  async createSession(
    sessionId: string,
    issueId: string,
    issue: IssueMinimal
  ) {
    // Track session locally
    this.sessions.set(sessionId, {
      sessionId,
      issueId,
      issue,
      createdAt: Date.now()
    });
  }

  async postThought(sessionId: string, message: string) {
    await this.linearClient.createAgentActivity({
      agentSessionId: sessionId,
      content: { type: "thought", body: message }
    });
  }

  async postAction(sessionId: string, action: string, status: 'running' | 'complete') {
    await this.linearClient.createAgentActivity({
      agentSessionId: sessionId,
      content: {
        type: "action",
        action: action,
        parameter: status === 'running' ? 'Running...' : 'Complete'
      }
    });
  }

  async postResponse(sessionId: string, response: string) {
    await this.linearClient.createAgentActivity({
      agentSessionId: sessionId,
      content: { type: "response", body: response }
    });
  }

  async postError(sessionId: string, error: string) {
    await this.linearClient.createAgentActivity({
      agentSessionId: sessionId,
      content: { type: "error", body: error }
    });
  }
}
```

---

### 3. **Webhook Payload Types** (Take as-is ✅)

**Location**: `/home/user/cyrus/packages/core/src/webhook-types.ts`

**What it does**: TypeScript types for Linear webhook payloads

**Usage**:
```typescript
import type { LinearWebhookPayload } from '@linear/sdk/webhooks';

transport.on('webhook', async (payload: LinearWebhookPayload) => {
  if (payload.type === 'Issue' && payload.action === 'update') {
    const issue = payload.data;

    // Check if assigned to your bot
    if (issue.assigneeId === YOUR_BOT_ID) {
      await triggerGitHubAction(issue);
    }
  }
});
```

---

### 4. **Linear Client Setup** (Adapt 🔧)

**Location**: See how EdgeWorker initializes Linear client

**What you need**:
```typescript
import { LinearClient } from '@linear/sdk';

const linearClient = new LinearClient({
  apiKey: process.env.LINEAR_API_KEY
});

// Or with OAuth token:
const linearClient = new LinearClient({
  accessToken: oauthAccessToken
});
```

---

## Complete Implementation Example

Here's a minimal working example combining these pieces:

### File: `github-actions-linear-bridge.ts`

```typescript
import { LinearClient } from '@linear/sdk';
import { LinearEventTransport } from 'cyrus-linear-event-transport';
import type { LinearWebhookPayload } from '@linear/sdk/webhooks';
import Fastify from 'fastify';
import { Octokit } from '@octokit/rest';

interface SessionInfo {
  sessionId: string;
  issueId: string;
  workflowRunId?: number;
  createdAt: number;
}

class GitHubActionsLinearBridge {
  private linearClient: LinearClient;
  private octokit: Octokit;
  private sessions = new Map<string, SessionInfo>();
  private botUserId: string;

  constructor(config: {
    linearApiKey: string;
    githubToken: string;
    botUserId: string;
    githubOwner: string;
    githubRepo: string;
  }) {
    this.linearClient = new LinearClient({ apiKey: config.linearApiKey });
    this.octokit = new Octokit({ auth: config.githubToken });
    this.botUserId = config.botUserId;
  }

  async start(port: number = 3000) {
    const app = Fastify();

    // Setup webhook transport
    const transport = new LinearEventTransport({
      fastifyServer: app,
      verificationMode: 'direct',
      secret: process.env.LINEAR_WEBHOOK_SECRET!
    });

    transport.register();

    // Handle incoming webhooks
    transport.on('webhook', async (payload: LinearWebhookPayload) => {
      await this.handleWebhook(payload);
    });

    await app.listen({ port, host: '0.0.0.0' });
    console.log(`Bridge listening on port ${port}`);
  }

  private async handleWebhook(payload: LinearWebhookPayload) {
    // Only handle Issue updates
    if (payload.type !== 'Issue') return;

    const issue = payload.data;

    // Check if assigned to bot
    if (issue.assigneeId !== this.botUserId) return;

    // Extract Agent Session ID from webhook
    const sessionId = payload.agentSessionId;
    if (!sessionId) {
      console.warn('No agent session ID in webhook');
      return;
    }

    console.log(`Processing issue ${issue.identifier} (session ${sessionId})`);

    // Track session
    this.sessions.set(sessionId, {
      sessionId,
      issueId: issue.id,
      createdAt: Date.now()
    });

    // Post initial thought
    await this.postThought(sessionId, 'Triggering GitHub Actions workflow...');

    // Trigger GitHub Actions
    try {
      const workflowRunId = await this.triggerWorkflow(issue, sessionId);

      // Update session with run ID
      const session = this.sessions.get(sessionId)!;
      session.workflowRunId = workflowRunId;

      await this.postAction(
        sessionId,
        'GitHub Actions',
        `Workflow #${workflowRunId} started`
      );

      // Poll for results (or use GitHub webhooks)
      await this.pollWorkflowStatus(sessionId, workflowRunId);

    } catch (error) {
      await this.postError(
        sessionId,
        `Failed to trigger workflow: ${(error as Error).message}`
      );
    }
  }

  private async triggerWorkflow(
    issue: any,
    sessionId: string
  ): Promise<number> {
    // Trigger your existing GitHub Actions workflow
    const response = await this.octokit.actions.createWorkflowDispatch({
      owner: process.env.GITHUB_OWNER!,
      repo: process.env.GITHUB_REPO!,
      workflow_id: 'claude-code.yml', // Your workflow file
      ref: 'main',
      inputs: {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        issue_title: issue.title,
        issue_description: issue.description || '',
        linear_session_id: sessionId
      }
    });

    // Get the workflow run ID
    // (GitHub doesn't return it directly, so we need to fetch recent runs)
    const runs = await this.octokit.actions.listWorkflowRuns({
      owner: process.env.GITHUB_OWNER!,
      repo: process.env.GITHUB_REPO!,
      workflow_id: 'claude-code.yml',
      per_page: 1
    });

    return runs.data.workflow_runs[0].id;
  }

  private async pollWorkflowStatus(
    sessionId: string,
    runId: number
  ) {
    const maxPolls = 120; // 10 minutes with 5s intervals
    let polls = 0;

    while (polls < maxPolls) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      polls++;

      const run = await this.octokit.actions.getWorkflowRun({
        owner: process.env.GITHUB_OWNER!,
        repo: process.env.GITHUB_REPO!,
        run_id: runId
      });

      if (run.data.status === 'completed') {
        if (run.data.conclusion === 'success') {
          // Fetch workflow outputs (you'll need to implement this)
          const output = await this.getWorkflowOutput(runId);

          await this.postResponse(sessionId, output);
        } else {
          await this.postError(
            sessionId,
            `Workflow failed with conclusion: ${run.data.conclusion}`
          );
        }
        break;
      } else {
        // Post periodic updates
        await this.postThought(
          sessionId,
          `Workflow status: ${run.data.status}...`
        );
      }
    }
  }

  private async getWorkflowOutput(runId: number): Promise<string> {
    // Fetch workflow logs or artifacts
    // This depends on how your workflow outputs results

    // Option 1: Read from workflow logs
    const jobs = await this.octokit.actions.listJobsForWorkflowRun({
      owner: process.env.GITHUB_OWNER!,
      repo: process.env.GITHUB_REPO!,
      run_id: runId
    });

    // Parse logs to extract Claude's output
    // (You'll need to implement this based on your workflow)

    return 'Workflow completed successfully!';
  }

  // Linear Activity Posting Methods
  private async postThought(sessionId: string, message: string) {
    await this.linearClient.createAgentActivity({
      agentSessionId: sessionId,
      content: { type: 'thought', body: message },
      ephemeral: false
    });
  }

  private async postAction(sessionId: string, action: string, status: string) {
    await this.linearClient.createAgentActivity({
      agentSessionId: sessionId,
      content: {
        type: 'action',
        action: action,
        parameter: status
      },
      ephemeral: false
    });
  }

  private async postResponse(sessionId: string, message: string) {
    await this.linearClient.createAgentActivity({
      agentSessionId: sessionId,
      content: { type: 'response', body: message },
      ephemeral: false
    });
  }

  private async postError(sessionId: string, message: string) {
    await this.linearClient.createAgentActivity({
      agentSessionId: sessionId,
      content: { type: 'error', body: message },
      ephemeral: false
    });
  }
}

// Start the bridge
const bridge = new GitHubActionsLinearBridge({
  linearApiKey: process.env.LINEAR_API_KEY!,
  githubToken: process.env.GITHUB_TOKEN!,
  botUserId: process.env.LINEAR_BOT_USER_ID!,
  githubOwner: process.env.GITHUB_OWNER!,
  githubRepo: process.env.GITHUB_REPO!
});

bridge.start(3000);
```

---

## Alternative: GitHub Actions Posts Directly to Linear

Instead of polling, your GitHub Actions workflow can post updates directly:

### In your GitHub Actions workflow:

```yaml
name: Claude Code

on:
  workflow_dispatch:
    inputs:
      linear_session_id:
        description: 'Linear Agent Session ID'
        required: true
      issue_title:
        description: 'Issue Title'
        required: true

jobs:
  run-claude:
    runs-on: ubuntu-latest
    steps:
      - name: Post Start to Linear
        run: |
          curl -X POST https://api.linear.app/graphql \
            -H "Authorization: ${{ secrets.LINEAR_API_KEY }}" \
            -H "Content-Type: application/json" \
            -d '{
              "query": "mutation CreateAgentActivity($sessionId: String!, $content: AgentActivityContentInput!) { agentActivityCreate(input: { agentSessionId: $sessionId, content: $content }) { success } }",
              "variables": {
                "sessionId": "${{ inputs.linear_session_id }}",
                "content": {
                  "type": "thought",
                  "body": "Starting Claude Code execution..."
                }
              }
            }'

      - name: Run Claude Code
        run: |
          # Your existing Claude Code logic
          claude code --prompt "Fix issue: ${{ inputs.issue_title }}"

      - name: Post Result to Linear
        run: |
          # Read Claude's output
          OUTPUT=$(cat claude_output.txt)

          curl -X POST https://api.linear.app/graphql \
            -H "Authorization: ${{ secrets.LINEAR_API_KEY }}" \
            -H "Content-Type: application/json" \
            -d "{
              \"query\": \"mutation CreateAgentActivity(\$sessionId: String!, \$content: AgentActivityContentInput!) { agentActivityCreate(input: { agentSessionId: \$sessionId, content: \$content }) { success } }\",
              \"variables\": {
                \"sessionId\": \"${{ inputs.linear_session_id }}\",
                \"content\": {
                  \"type\": \"response\",
                  \"body\": \"$OUTPUT\"
                }
              }
            }"
```

This approach is simpler because:
- ✅ No polling needed
- ✅ GitHub Actions posts updates directly
- ✅ Your bridge just triggers the workflow

---

## Minimal Package Dependencies

To keep it lightweight, you only need:

```json
{
  "dependencies": {
    "@linear/sdk": "^60.0.0",
    "@octokit/rest": "^20.0.0",
    "fastify": "^5.2.0",
    "cyrus-linear-event-transport": "workspace:*"
  }
}
```

Or install the linear-event-transport from npm once published.

---

## Key Cyrus Files to Reference

### Must Read:
1. `/home/user/cyrus/packages/linear-event-transport/src/LinearEventTransport.ts` - Webhook handling
2. `/home/user/cyrus/packages/edge-worker/src/AgentSessionManager.ts` - Linear Activity posting
3. `/home/user/cyrus/packages/core/src/CyrusAgentSession.ts` - Session types

### Optional (for deeper understanding):
4. `/home/user/cyrus/packages/edge-worker/src/EdgeWorker.ts` - How it all connects
5. `/home/user/cyrus/packages/edge-worker/src/SharedApplicationServer.ts` - Server setup

---

## Summary: What to Take vs What to Skip

### ✅ **Take These Components**

1. **`linear-event-transport` package** - Webhook handling (complete package)
2. **Linear Activity posting methods** - From `AgentSessionManager` (extract methods)
3. **Session tracking pattern** - Simple Map-based tracking
4. **Linear Client setup** - Standard `@linear/sdk` usage

### ❌ **Skip These Components**

1. **ClaudeRunner** - You have GitHub Actions instead
2. **Git worktree management** - GitHub Actions handles this
3. **Procedure/Subroutine system** - Overkill for your use case
4. **MCP servers** - Not needed
5. **Prompt assembly** - Not needed
6. **OAuth flow** - Unless you want user OAuth (simple API key is fine)

---

## Implementation Steps

1. **Week 1**: Setup webhook bridge
   - Copy `linear-event-transport` package
   - Setup Fastify server
   - Verify webhook reception

2. **Week 2**: GitHub Actions integration
   - Add workflow dispatch trigger
   - Pass Linear session ID as input
   - Test workflow trigger

3. **Week 3**: Linear Activity posting
   - Extract posting methods from `AgentSessionManager`
   - Post thoughts, actions, responses
   - Test full flow

4. **Week 4**: Polish
   - Error handling
   - Logging
   - Deploy

---

## FAQ

**Q: Do I need to deploy the proxy?**
A: No! Use Linear's direct webhooks if your bridge is publicly accessible, or use ngrok/cloudflare tunnel for local dev.

**Q: Can I reuse Cyrus's OAuth flow?**
A: Yes, but for a single bot, a simple API key is easier. OAuth is only needed for multi-user installs.

**Q: Do I need git worktrees?**
A: No, GitHub Actions already has workspace management.

**Q: How do I handle long-running workflows?**
A: Either poll GitHub API (as shown) or have GitHub Actions post updates directly to Linear.

**Q: Can this run on Vercel/Netlify?**
A: Yes! The webhook bridge is just a simple HTTP server. Deploy it anywhere that supports Node.js.

---

## Next Steps

1. Read `LinearEventTransport.ts` to understand webhook handling
2. Study `AgentSessionManager.ts` lines 1411-1500 for Linear Activity posting
3. Start with the complete example above
4. Adapt to your GitHub Actions workflow

Good luck! You're essentially building a thin translation layer between Linear and GitHub Actions, which is much simpler than running Claude locally.
