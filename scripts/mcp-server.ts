/**
 * mcp-server.ts — a working MCP surface over stdio.
 *
 * Three read tools and one write tool. The write tool creates a PROPOSAL that a
 * human must approve; it moves no money, writes no journal entry, and places no
 * order. There is deliberately no tool on this surface that can approve,
 * execute, trade, or write to the ledger — see NEVER_FOR_AGENTS in
 * src/lib/agent/tools.ts for the full list and the reasoning.
 *
 * Every call is stamped with an `agent:` identity, so the approval queue and
 * the audit trail can always tell a proposal from a human request.
 *
 * Run:  npm run mcp
 * Wire into a client (e.g. Claude Desktop / Claude Code) with:
 *
 *   {
 *     "mcpServers": {
 *       "ledgerly": {
 *         "command": "npx",
 *         "args": ["tsx", "scripts/mcp-server.ts"],
 *         "cwd": "/absolute/path/to/corgi_assignment"
 *       }
 *     }
 *   }
 */

import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

import '../src/lib/pg-types';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { withClient } from '../src/lib/db';
import {
  explainBalance,
  getPortfolio,
  listBreaks,
  proposeWithdrawal,
  NEVER_FOR_AGENTS,
} from '../src/lib/agent/tools';
import type { MarketDate } from '../src/lib/calendar';

const AGENT_ID = process.env.MCP_AGENT_ID ?? 'agent:mcp';

const server = new McpServer({
  name: 'ledgerly',
  version: '1.0.0',
});

function text(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function failed(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          { error: error instanceof Error ? error.message : String(error) },
          null,
          2,
        ),
      },
    ],
  };
}

// -----------------------------------------------------------------------------
// READ 1
// -----------------------------------------------------------------------------
server.registerTool(
  'get_portfolio',
  {
    title: 'Get a customer portfolio',
    description:
      'Positions, cost basis, market value, the three cash buckets and the ' +
      'time-weighted return for one customer. Read-only. Cash is reported as ' +
      'settled / unsettled proceeds / pending deposits separately, because they ' +
      'are genuinely different money.',
    inputSchema: {
      customer: z.string().describe('customer email, legal name, or id'),
      asOf: z.string().optional().describe('YYYY-MM-DD, defaults to today'),
    },
  },
  async ({ customer, asOf }) => {
    try {
      return text(
        await withClient((c) =>
          getPortfolio(c, { customer, asOf: asOf as MarketDate | undefined }),
        ),
      );
    } catch (error) {
      return failed(error);
    }
  },
);

// -----------------------------------------------------------------------------
// READ 2
// -----------------------------------------------------------------------------
server.registerTool(
  'explain_balance',
  {
    title: 'Explain a balance from the journal',
    description:
      'The journal entries behind a balance. Every figure in this system is a ' +
      'fold over these lines, so this is how an agent checks a number rather ' +
      'than trusting it. Each line carries effective_at (when it economically ' +
      'happened) and recorded_at (when we learned it). Read-only.',
    inputSchema: {
      customer: z.string().optional().describe('customer email, name or id'),
      account: z
        .string()
        .optional()
        .describe('e.g. assets:cash:settled, assets:positions, income:realized_gain'),
      limit: z.number().optional().describe('max entries, default 25, cap 100'),
    },
  },
  async ({ customer, account, limit }) => {
    try {
      return text(await withClient((c) => explainBalance(c, { customer, account, limit })));
    } catch (error) {
      return failed(error);
    }
  },
);

// -----------------------------------------------------------------------------
// READ 3
// -----------------------------------------------------------------------------
server.registerTool(
  'list_reconciliation_breaks',
  {
    title: 'List reconciliation breaks',
    description:
      'Open breaks between our ledger and the custodian, classified as timing ' +
      '(clears itself), unbooked (action required) or genuine (escalate), with ' +
      'age in days. Read-only: an agent cannot resolve a break, because closing ' +
      'breaks is how a genuine one gets buried.',
    inputSchema: {
      includeResolved: z.boolean().optional(),
    },
  },
  async ({ includeResolved }) => {
    try {
      return text(await withClient((c) => listBreaks(c, { includeResolved })));
    } catch (error) {
      return failed(error);
    }
  },
);

// -----------------------------------------------------------------------------
// WRITE — and it does not move money
// -----------------------------------------------------------------------------
server.registerTool(
  'propose_withdrawal',
  {
    title: 'Propose a withdrawal for human approval',
    description:
      'Creates a PENDING approval. This does NOT move money: no journal entry ' +
      'is written, no transfer is created. A human with a different identity ' +
      'must approve it, and the database refuses self-approval as a CHECK ' +
      'constraint. The proposal records the withdrawable balance at the time it ' +
      'was raised so the reviewer does not have to go and look.',
    inputSchema: {
      customer: z.string().describe('customer email, legal name, or id'),
      amount: z.string().describe('dollar amount, e.g. "250.00"'),
      reason: z.string().optional().describe('why, shown to the human reviewer'),
    },
  },
  async ({ customer, amount, reason }) => {
    try {
      return text(
        await withClient((c) =>
          proposeWithdrawal(c, { customer, amount, reason, agentId: AGENT_ID }),
        ),
      );
    } catch (error) {
      return failed(error);
    }
  },
);

// -----------------------------------------------------------------------------
// The refusal list, exposed as a resource so a client can read it
// -----------------------------------------------------------------------------
server.registerResource(
  'agent-boundaries',
  'ledgerly://agent/boundaries',
  {
    title: 'Operations never delegated to an autonomous agent',
    description:
      'What this surface deliberately cannot do, and why. The general rule: an ' +
      'agent may READ anything and PROPOSE anything, but may not DECIDE, MOVE ' +
      'or ERASE.',
    mimeType: 'application/json',
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(
          {
            rule: 'An agent may READ anything and PROPOSE anything, but may not DECIDE, MOVE or ERASE.',
            neverDelegated: NEVER_FOR_AGENTS,
            enforcedIn: [
              'the tool surface — no function here can post an entry, trade, or approve',
              "the queue — proposals are stamped requested_by_kind = 'agent'",
              'the database — approvals_no_self_approval is a CHECK constraint',
              'the executor — any decider or executor identity prefixed "agent:" is refused',
            ],
          },
          null,
          2,
        ),
      },
    ],
  }),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr, so it cannot corrupt the JSON-RPC stream on stdout.
  console.error(`ledgerly MCP server ready — identity ${AGENT_ID}`);
  console.error('tools: get_portfolio, explain_balance, list_reconciliation_breaks, propose_withdrawal');
}

main().catch((error) => {
  console.error('mcp server failed:', error);
  process.exit(1);
});
