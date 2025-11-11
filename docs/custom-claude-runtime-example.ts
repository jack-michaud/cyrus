/**
 * Example: Custom Claude Agent Runtime
 *
 * This demonstrates how you could implement your own Claude agent runtime
 * without using @anthropic-ai/claude-agent-sdk
 */

import Anthropic from '@anthropic-ai/sdk';

interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string | Array<{
    type: 'text' | 'tool_use' | 'tool_result';
    text?: string;
    name?: string;
    input?: unknown;
    tool_use_id?: string;
    content?: string;
  }>;
}

class CustomClaudeRuntime {
  private client: Anthropic;
  private conversationHistory: ClaudeMessage[] = [];

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  /**
   * Define available tools (same concept as Claude Code tools)
   */
  private getTools() {
    return [
      {
        name: 'read_file',
        description: 'Read contents of a file',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to read' }
          },
          required: ['path']
        }
      },
      {
        name: 'write_file',
        description: 'Write content to a file',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to write' },
            content: { type: 'string', description: 'Content to write' }
          },
          required: ['path', 'content']
        }
      },
      {
        name: 'bash',
        description: 'Execute bash command',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Bash command to execute' }
          },
          required: ['command']
        }
      }
    ];
  }

  /**
   * Execute a tool call
   */
  private async executeTool(toolName: string, toolInput: any): Promise<string> {
    switch (toolName) {
      case 'read_file':
        // In real implementation, use fs.readFile
        return `Contents of ${toolInput.path}: ...`;

      case 'write_file':
        // In real implementation, use fs.writeFile
        return `Successfully wrote to ${toolInput.path}`;

      case 'bash':
        // In real implementation, use child_process.exec
        return `Executed: ${toolInput.command}\nOutput: ...`;

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  /**
   * Main query method - similar to SDK's query()
   */
  async *query(prompt: string): AsyncGenerator<{
    type: 'message' | 'tool_use' | 'tool_result' | 'complete';
    content?: any;
  }> {
    // Add user prompt to history
    this.conversationHistory.push({
      role: 'user',
      content: prompt
    });

    let continueConversation = true;

    while (continueConversation) {
      // Call Claude API
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8096,
        system: 'You are a helpful coding assistant with access to file operations and bash commands.',
        tools: this.getTools(),
        messages: this.conversationHistory
      });

      // Yield the message
      yield {
        type: 'message',
        content: response.content
      };

      // Check if Claude wants to use tools
      const toolUses = response.content.filter(block => block.type === 'tool_use');

      if (toolUses.length > 0) {
        // Execute each tool
        const toolResults = [];

        for (const toolUse of toolUses) {
          if (toolUse.type !== 'tool_use') continue;

          yield {
            type: 'tool_use',
            content: {
              name: toolUse.name,
              input: toolUse.input
            }
          };

          // Execute the tool
          const result = await this.executeTool(toolUse.name, toolUse.input);

          toolResults.push({
            type: 'tool_result' as const,
            tool_use_id: toolUse.id,
            content: result
          });

          yield {
            type: 'tool_result',
            content: {
              tool_use_id: toolUse.id,
              result
            }
          };
        }

        // Add assistant response and tool results to history
        this.conversationHistory.push({
          role: 'assistant',
          content: response.content
        });

        this.conversationHistory.push({
          role: 'user',
          content: toolResults
        });

        // Continue the loop to get Claude's response after tool execution

      } else {
        // No more tools to use, conversation complete
        this.conversationHistory.push({
          role: 'assistant',
          content: response.content
        });

        continueConversation = false;

        yield {
          type: 'complete',
          content: response.content
        };
      }

      // Stop reason check
      if (response.stop_reason === 'end_turn') {
        continueConversation = false;
      }
    }
  }
}

// Usage example:
async function main() {
  const runtime = new CustomClaudeRuntime(process.env.ANTHROPIC_API_KEY!);

  const prompt = `
    Please help me with the following Linear issue:

    Title: Add user authentication
    Description: Implement JWT-based authentication for the API

    Steps:
    1. Read the current user model
    2. Add authentication middleware
    3. Write tests
  `;

  for await (const event of runtime.query(prompt)) {
    switch (event.type) {
      case 'message':
        console.log('Claude says:', event.content);
        break;

      case 'tool_use':
        console.log('Using tool:', event.content.name, event.content.input);
        break;

      case 'tool_result':
        console.log('Tool result:', event.content.result);
        break;

      case 'complete':
        console.log('Conversation complete!');
        break;
    }
  }
}

// For Cloudflare Workers, you'd need to adapt this:
// - Remove file system operations
// - Use KV/R2 for state
// - Handle timeout constraints
// - Use fetch instead of Anthropic SDK (or check if SDK works in Workers)

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Simplified version for CF Workers
    const { issue } = await request.json();

    // Direct API call (no streaming, no tools, no file access)
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
        messages: [{
          role: 'user',
          content: `Linear Issue: ${issue.title}\n\n${issue.description}\n\nProvide guidance.`
        }]
      })
    });

    const data = await response.json();

    // Post back to Linear
    await postToLinear(issue.id, data.content[0].text);

    return new Response('OK');
  }
};
