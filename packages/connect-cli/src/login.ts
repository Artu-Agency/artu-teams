// packages/connect-cli/src/login.ts
import { post, get, authHeaders } from "./http.js";

interface LoginResult {
  apiKey: string;
  userId: string;
  companyIds: string[];
  userName: string;
  userEmail: string;
}

export async function browserLogin(serverBase: string): Promise<LoginResult> {
  // Step 1: Create challenge
  console.log("  Creating auth challenge...");
  const challengeRes = await post(`${serverBase}/cli-auth/challenges`, {
    command: "artu-teams connect",
    clientName: "artu-teams-cli",
    requestedAccess: "board",
  });

  if (challengeRes.status !== 201) {
    const err = challengeRes.data as { error?: string } | null;
    throw new Error(`Failed to create auth challenge: ${err?.error ?? challengeRes.status}`);
  }

  const challenge = challengeRes.data as {
    id: string;
    token: string;
    boardApiToken: string;
    approvalUrl: string | null;
    approvalPath: string;
    pollPath: string;
    expiresAt: string;
  };

  // Step 2: Open browser
  const approvalUrl = challenge.approvalUrl
    ?? `${serverBase.replace(/\/api\/?$/, "")}${challenge.approvalPath}`;

  console.log(`\n  Opening browser for authentication...`);
  console.log(`  If it doesn't open, visit: ${approvalUrl}\n`);

  try {
    const open = await import("open");
    await open.default(approvalUrl);
  } catch {
    // Browser didn't open — user can visit manually
  }

  // Step 3: Poll until approved or timeout
  const pollUrl = `${serverBase}${challenge.pollPath}?token=${encodeURIComponent(challenge.token)}`;
  const timeoutMs = 10 * 60 * 1000; // 10 min
  const pollIntervalMs = 2000;
  const startedAt = Date.now();

  const spinner = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
  let spinIdx = 0;

  while (Date.now() - startedAt < timeoutMs) {
    await sleep(pollIntervalMs);

    const pollRes = await get(pollUrl);
    if (pollRes.status !== 200) continue;

    const data = pollRes.data as { status: string; approvedAt?: string };

    if (data.status === "approved") {
      process.stdout.write("\r  ✓ Approved!                    \n");
      break;
    }
    if (data.status === "cancelled" || data.status === "expired") {
      throw new Error(`Auth challenge ${data.status}`);
    }

    process.stdout.write(`\r  Waiting for approval... ${spinner[spinIdx++ % spinner.length]}`);
  }

  if (Date.now() - startedAt >= timeoutMs) {
    throw new Error("Auth challenge timed out (10 min)");
  }

  // Step 4: Use the board API token to fetch user info
  const apiKey = challenge.boardApiToken;
  const meRes = await get(`${serverBase}/cli-auth/me`, authHeaders(apiKey));

  if (meRes.status !== 200) {
    throw new Error(`Failed to fetch user info: ${meRes.status}`);
  }

  const me = meRes.data as {
    userId: string;
    user: { name: string; email: string };
    companyIds: string[];
  };

  return {
    apiKey,
    userId: me.userId,
    companyIds: me.companyIds,
    userName: me.user.name,
    userEmail: me.user.email,
  };
}

export async function selectCompany(
  serverBase: string,
  apiKey: string,
  companyIds: string[],
): Promise<{ companyId: string; companyName: string }> {
  if (companyIds.length === 0) {
    throw new Error("No companies found. Create a company first at the web UI.");
  }

  // Fetch company names
  const companies: { id: string; name: string }[] = [];
  for (const id of companyIds) {
    const res = await get(`${serverBase}/companies/${id}`, authHeaders(apiKey));
    if (res.status === 200) {
      const data = res.data as { id: string; name: string };
      companies.push({ id: data.id, name: data.name });
    }
  }

  if (companies.length === 0) {
    throw new Error("No accessible companies found.");
  }

  if (companies.length === 1) {
    console.log(`  Company: ${companies[0].name}`);
    return { companyId: companies[0].id, companyName: companies[0].name };
  }

  // Multiple companies — prompt user to select
  console.log("\n  Select company:");
  for (let i = 0; i < companies.length; i++) {
    console.log(`    ${i + 1}. ${companies[i].name}`);
  }

  // Read from stdin
  const choice = await readLine("  > ");
  const idx = parseInt(choice, 10) - 1;
  if (idx < 0 || idx >= companies.length) {
    throw new Error("Invalid selection");
  }

  return { companyId: companies[idx].id, companyName: companies[idx].name };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.setEncoding("utf-8");
    process.stdin.once("data", (data: string) => {
      resolve(data.trim());
    });
  });
}
