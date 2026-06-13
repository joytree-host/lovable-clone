import { Daytona } from "@daytonaio/sdk";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, "../../.env") });

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

const SANDBOX_LABELS = {
  app: "lovable-clone",
  purpose: "website-generation",
};

function isDiskLimitError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("disk limit exceeded");
}

async function prepareSandboxForReuse(
  sandbox: any,
  options: { allowStart: boolean; requireMarker: boolean }
) {
  if (sandbox.state && sandbox.state !== "started") {
    if (!options.allowStart) return undefined;
    console.log(`Starting reusable sandbox ${sandbox.id} (${sandbox.state})...`);
    await sandbox.start(120);
  }

  const rootDir = await sandbox.getUserRootDir();
  if (!options.requireMarker) return rootDir;

  const markerCheck = await sandbox.process.executeCommand(
    "test -d website-project && echo yes || echo no",
    rootDir
  );
  return markerCheck.result?.trim() === "yes" ? rootDir : undefined;
}

async function findReusableSandbox(daytona: Daytona) {
  const listResult: any = await daytona.list();
  const allSandboxes: any[] = Array.isArray(listResult)
    ? listResult
    : listResult?.items ?? listResult?.sandboxes ?? listResult?.data ?? [];
  const labeledSandboxes = allSandboxes.filter(
    (s: any) =>
      s.labels?.app === SANDBOX_LABELS.app &&
      s.labels?.purpose === SANDBOX_LABELS.purpose
  );

  for (const sandbox of labeledSandboxes) {
    try {
      await prepareSandboxForReuse(sandbox, { allowStart: true, requireMarker: false });
      return sandbox;
    } catch (e: any) {
      console.log(`Could not reuse sandbox ${sandbox.id}: ${e.message}`);
    }
  }

  for (const sandbox of allSandboxes) {
    if (labeledSandboxes.some((l: any) => l.id === sandbox.id)) continue;
    try {
      const rootDir = await prepareSandboxForReuse(sandbox, { allowStart: false, requireMarker: true });
      if (rootDir) {
        console.log(`✓ Reusing existing sandbox: ${sandbox.id}`);
        await sandbox.setLabels(SANDBOX_LABELS);
        return sandbox;
      }
    } catch (e: any) {
      console.log(`Skipping sandbox ${sandbox.id}: ${e.message}`);
    }
  }
  return undefined;
}

async function createOrReuseSandbox(daytona: Daytona, sandboxId?: string) {
  if (sandboxId) {
    console.log(`1. Using existing sandbox: ${sandboxId}`);
    const sandbox = await daytona.get(sandboxId);
    await prepareSandboxForReuse(sandbox, { allowStart: true, requireMarker: false });
    console.log(`✓ Connected to sandbox: ${sandbox.id}`);
    return sandbox;
  }

  console.log("1. Looking for an existing website-generation sandbox...");
  let reusableSandbox;
  try {
    reusableSandbox = await findReusableSandbox(daytona);
  } catch (e: any) {
    console.log(`Skipping sandbox reuse (${e.message}). Creating new sandbox instead.`);
  }
  if (reusableSandbox) {
    console.log(`✓ Reusing sandbox: ${reusableSandbox.id}`);
    return reusableSandbox;
  }

  console.log("1. Creating new Daytona sandbox...");
  try {
    const sandbox = await daytona.create({
      public: true,
      image: "node:20",
      labels: SANDBOX_LABELS,
      resources: { disk: 10 },
      autoStopInterval: 15,
      autoArchiveInterval: 60,
    });
    console.log(`✓ Sandbox created: ${sandbox.id}`);
    return sandbox;
  } catch (error) {
    if (isDiskLimitError(error)) {
      throw new Error(
        "Daytona disk limit exceeded. Open Daytona and delete old sandboxes, then try again."
      );
    }
    throw error;
  }
}

async function generateWebsiteInDaytona(sandboxIdArg?: string, prompt?: string) {
  console.log("🚀 Starting website generation in Daytona sandbox...\n");

  if (!process.env.DAYTONA_API_KEY || !process.env.ANTHROPIC_API_KEY) {
    console.error("ERROR: DAYTONA_API_KEY and ANTHROPIC_API_KEY must be set");
    process.exit(1);
  }

  const daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });

  let sandbox: any;
  let sandboxId = sandboxIdArg;

  try {
    sandbox = await createOrReuseSandbox(daytona, sandboxId);
    sandboxId = sandbox.id;

    const rootDir = await sandbox.getUserRootDir();
    console.log(`✓ Working directory: ${rootDir}`);

    const projectDir = `${rootDir}/website-project`;

    console.log("\n2. Setting up project directory...");
    await sandbox.process.executeCommand(
      `rm -rf ${shellQuote(projectDir)} && mkdir -p ${shellQuote(projectDir)}`,
      rootDir, undefined, 120
    );
    console.log(`✓ Created clean project directory: ${projectDir}`);

    // FIX: Install claude CLI globally (not as a Node.js module to import from)
    console.log("\n3. Installing Claude Code CLI...");
    const installResult = await sandbox.process.executeCommand(
      "npm install -g @anthropic-ai/claude-code@latest",
      rootDir, undefined, 180
    );
    if (installResult.exitCode !== 0) {
      throw new Error(`Failed to install Claude Code CLI: ${installResult.result}`);
    }
    console.log("✓ Claude Code CLI installed");

    console.log("\n4. Verifying Claude Code CLI...");
    const checkClaude = await sandbox.process.executeCommand("claude --version", rootDir);
    console.log(`✓ ${checkClaude.result?.trim()}`);

    console.log("\n5. Creating generation script...");

    const userPrompt = prompt ||
      "Create a modern blog website with markdown support and a dark theme";

    // FIX: The script uses `claude --print --output-format stream-json` via child_process
    // NOT `import { query } from '@anthropic-ai/claude-code'` (that import no longer exists)
    const generationScript = `const { spawn } = require('child_process');
const fs = require('fs');

async function generateWebsite() {
  const fullPrompt = ${JSON.stringify(`${userPrompt}

Important requirements:
- Create a NextJS app with TypeScript and Tailwind CSS
- Use the app directory structure
- Create all files in the current directory
- Include a package.json with all necessary dependencies
- Make the design modern and responsive
- Add at least a home page and one other page
- Include proper navigation between pages`)};

  console.log('Starting website generation with Claude Code CLI...');
  console.log('Working directory:', process.cwd());

  return new Promise((resolve, reject) => {
    const claude = spawn('claude', [
      '--print',
      '--output-format', 'stream-json',
      '--allowedTools', 'Read,Write,Edit,MultiEdit,Bash,LS,Glob,Grep',
      '--max-turns', '20',
      '--dangerously-skip-permissions',
      fullPrompt
    ], {
      env: { ...process.env, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
      cwd: process.cwd(),
    });

    let buffer = '';
    const messages = [];

    claude.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          messages.push(msg);
          if (msg.type === 'assistant') {
            const textBlock = (msg.message?.content || []).find(b => b.type === 'text');
            if (textBlock) {
              console.log('[Claude]:', textBlock.text.substring(0, 80) + '...');
              console.log('__CLAUDE_MESSAGE__' + JSON.stringify({ type: 'assistant', content: textBlock.text }));
            }
            for (const tool of (msg.message?.content || []).filter(b => b.type === 'tool_use')) {
              console.log('[Tool]:', tool.name, tool.input?.file_path || tool.input?.command || '');
              console.log('__TOOL_USE__' + JSON.stringify({ type: 'tool_use', name: tool.name, input: tool.input }));
            }
          }
        } catch (e) { /* non-JSON line */ }
      }
    });

    claude.stderr.on('data', (data) => {
      const err = data.toString().trim();
      if (err) console.error('[stderr]:', err);
    });

    claude.on('close', (code) => {
      console.log('\\nGeneration complete! Exit code:', code);
      console.log('Total messages:', messages.length);
      fs.writeFileSync('generation-log.json', JSON.stringify(messages, null, 2));
      const files = fs.readdirSync('.').filter(f => !f.startsWith('.'));
      console.log('\\nGenerated files:', files.join(', '));
      if (code === 0) resolve(messages);
      else reject(new Error('Claude CLI exited with code ' + code));
    });

    claude.on('error', (err) => reject(new Error('Failed to spawn claude: ' + err.message)));
  });
}

generateWebsite().catch((error) => {
  console.error('Generation error:', error);
  process.exit(1);
});`;

    await sandbox.process.executeCommand(
      `cat > generate.js << 'SCRIPT_EOF'\n${generationScript}\nSCRIPT_EOF`,
      projectDir
    );
    console.log("✓ Generation script written to generate.js");

    console.log("\n6. Running Claude Code generation...");
    console.log(`Prompt: "${userPrompt}"`);
    console.log("\nThis may take several minutes...\n");

    const genResult = await sandbox.process.executeCommand(
      "node generate.js",
      projectDir,
      { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
      600
    );

    console.log("\nGeneration output:");
    console.log(genResult.result);

    if (genResult.exitCode !== 0) throw new Error("Generation failed");

    console.log("\n7. Checking generated files...");
    const filesResult = await sandbox.process.executeCommand("ls -la", projectDir);
    console.log(filesResult.result);

    const hasNextJS = await sandbox.process.executeCommand(
      "test -f package.json && grep -q next package.json && echo yes || echo no",
      projectDir
    );

    if (hasNextJS.result?.trim() === "yes") {
      console.log("\n8. Installing project dependencies...");
      const npmInstall = await sandbox.process.executeCommand(
        "npm install", projectDir, undefined, 300
      );
      if (npmInstall.exitCode !== 0) {
        console.log("Warning: npm install had issues:", npmInstall.result);
      } else {
        console.log("✓ Dependencies installed");
      }

      console.log("\n9. Starting development server...");
      await sandbox.process.executeCommand(
        "nohup npm run dev > dev-server.log 2>&1 &",
        projectDir, { PORT: "3000" }
      );
      console.log("✓ Server started. Waiting 8s...");
      await new Promise((r) => setTimeout(r, 8000));

      const checkServer = await sandbox.process.executeCommand(
        "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000 || echo 'failed'",
        projectDir
      );
      console.log(checkServer.result?.trim() === "200" ? "✓ Server is running!" : "⚠️  Server still starting...");
    }

    console.log("\n10. Getting preview URL...");
    const preview = await sandbox.getPreviewLink(3000);

    console.log("\n✨ SUCCESS! Website generated!");
    console.log(`Sandbox ID: ${sandboxId}`);
    console.log(`Preview URL: ${preview.url}`);

    return { success: true, sandboxId, projectDir, previewUrl: preview.url };
  } catch (error: any) {
    console.error("\n❌ ERROR:", error.message);
    if (sandbox) {
      console.log(`\nSandbox ID: ${sandboxId}`);
      console.log("The sandbox is still running for debugging.");
      try {
        const debugInfo = await sandbox.process.executeCommand(
          "pwd && echo '---' && ls -la && echo '---'",
          `${await sandbox.getUserRootDir()}/website-project`
        );
        console.log("\nDebug info:", debugInfo.result);
      } catch (e) {}
    }
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  let sandboxId: string | undefined;
  let prompt: string | undefined;

  if (args.length > 0) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(args[0])) {
      sandboxId = args[0];
      prompt = args.slice(1).join(" ");
    } else {
      prompt = args.join(" ");
    }
  }

  if (!prompt) {
    prompt = "Create a modern blog website with markdown support and a dark theme. Include a home page, blog listing page, and individual blog post pages.";
  }

  console.log("📝 Configuration:");
  console.log(`- Sandbox: ${sandboxId ? `Using existing ${sandboxId}` : "Creating new"}`);
  console.log(`- Prompt: ${prompt}`);
  console.log();

  try {
    await generateWebsiteInDaytona(sandboxId, prompt);
  } catch (error) {
    console.error("Failed to generate website:", error);
    process.exit(1);
  }
}

main();
