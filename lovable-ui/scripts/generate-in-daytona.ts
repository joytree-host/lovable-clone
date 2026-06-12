import { Daytona } from "@daytona/sdk";
import * as dotenv from "dotenv";
import * as path from "path";

// Load environment variables
dotenv.config({ path: path.join(__dirname, "../../.env") });

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
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
    if (!options.allowStart) {
      return undefined;
    }

    console.log(`Starting reusable sandbox ${sandbox.id} (${sandbox.state})...`);
    await sandbox.start(120);
  }

  const rootDir = await sandbox.getUserRootDir();
  if (!options.requireMarker) {
    return rootDir;
  }

  const markerCheck = await sandbox.process.executeCommand(
    "test -d website-project -o -d .claude-code-runner && echo yes || echo no",
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
    (sandbox: any) =>
      sandbox.labels?.app === SANDBOX_LABELS.app &&
      sandbox.labels?.purpose === SANDBOX_LABELS.purpose
  );

  for (const sandbox of labeledSandboxes) {
    try {
      await prepareSandboxForReuse(sandbox, {
        allowStart: true,
        requireMarker: false,
      });
      return sandbox;
    } catch (error: any) {
      console.log(
        `Could not reuse labeled sandbox ${sandbox.id}: ${error.message}`
      );
    }
  }

  // Older versions of this flow created unlabeled sandboxes. Only adopt one if it
  // already contains our known project/runner directories.
  for (const sandbox of allSandboxes) {
    if (labeledSandboxes.some((labeled: any) => labeled.id === sandbox.id)) {
      continue;
    }

    try {
      const rootDir = await prepareSandboxForReuse(sandbox, {
        allowStart: false,
        requireMarker: true,
      });
      if (rootDir) {
        console.log(`✓ Reusing existing generated-site sandbox: ${sandbox.id}`);
        await sandbox.setLabels(SANDBOX_LABELS);
        return sandbox;
      }
    } catch (error: any) {
      console.log(`Skipping sandbox ${sandbox.id}: ${error.message}`);
    }
  }

  return undefined;
}

async function createOrReuseSandbox(daytona: Daytona, sandboxId?: string) {
  if (sandboxId) {
    console.log(`1. Using existing sandbox: ${sandboxId}`);
    const sandbox = await daytona.get(sandboxId);
    await prepareSandboxForReuse(sandbox, {
      allowStart: true,
      requireMarker: false,
    });
    console.log(`✓ Connected to sandbox: ${sandbox.id}`);
    return sandbox;
  }

  console.log("1. Looking for an existing website-generation sandbox...");
  const reusableSandbox = await findReusableSandbox(daytona);
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
      resources: {
        disk: 10,
      },
      autoStopInterval: 15,
      autoArchiveInterval: 60,
    });
    console.log(`✓ Sandbox created: ${sandbox.id}`);
    return sandbox;
  } catch (error) {
    if (isDiskLimitError(error)) {
      throw new Error(
        "Daytona disk limit exceeded and no reusable generated-site sandbox was found. " +
          "Open Daytona and delete old/unused sandboxes, then try again."
      );
    }
    throw error;
  }
}

async function generateWebsiteInDaytona(
  sandboxIdArg?: string,
  prompt?: string
) {
  console.log("🚀 Starting website generation in Daytona sandbox...\n");

  if (!process.env.DAYTONA_API_KEY || !process.env.ANTHROPIC_API_KEY) {
    console.error("ERROR: DAYTONA_API_KEY and ANTHROPIC_API_KEY must be set");
    process.exit(1);
  }

  const daytona = new Daytona({
    apiKey: process.env.DAYTONA_API_KEY,
  });

  let sandbox;
  let sandboxId = sandboxIdArg;

  try {
    sandbox = await createOrReuseSandbox(daytona, sandboxId);
    sandboxId = sandbox.id;

    const rootDir = await sandbox.getUserRootDir();
    console.log(`✓ Working directory: ${rootDir}`);

    // Keep the Claude Code SDK outside the generated app. Claude can safely rewrite
    // the app's package.json without deleting the runner dependency mid-flow.
    const runnerDir = `${rootDir}/.claude-code-runner`;
    const projectDir = `${rootDir}/website-project`;

    // Step 2: Create project and runner directories
    console.log("\n2. Setting up project directory...");
    await sandbox.process.executeCommand(
      `rm -rf ${shellQuote(projectDir)} && mkdir -p ${shellQuote(projectDir)} ${shellQuote(runnerDir)}`,
      rootDir,
      undefined,
      120
    );
    console.log(`✓ Created clean project directory: ${projectDir}`);

    // Step 3: Initialize SDK runner package
    console.log("\n3. Initializing Claude Code runner...");
    await sandbox.process.executeCommand(
      "test -f package.json || npm init -y",
      runnerDir
    );
    console.log("✓ Runner package.json ready");

    // Step 4: Install Claude Code SDK in the isolated runner directory
    console.log("\n4. Installing Claude Code SDK locally...");
    const installResult = await sandbox.process.executeCommand(
      "npm install @anthropic-ai/claude-code@latest",
      runnerDir,
      undefined,
      180
    );

    if (installResult.exitCode !== 0) {
      console.error("Installation failed:", installResult.result);
      throw new Error("Failed to install Claude Code SDK");
    }
    console.log("✓ Claude Code SDK installed");

    // Verify installation and resolve the concrete SDK entrypoint up front.
    console.log("\n5. Verifying installation...");
    const checkInstall = await sandbox.process.executeCommand(
      "node -e \"console.log(require.resolve('@anthropic-ai/claude-code'))\"",
      runnerDir
    );

    if (checkInstall.exitCode !== 0 || !checkInstall.result?.trim()) {
      console.error("Installation check failed:", checkInstall.result);
      throw new Error("Claude Code SDK is installed but could not be resolved");
    }

    const sdkPath = checkInstall.result.trim().split("\n").pop()!;
    console.log(`✓ Claude Code SDK resolved: ${sdkPath}`);

    // Step 6: Create the generation script file
    console.log("\n6. Creating generation script file...");

    const userPrompt =
      prompt || "Create a modern blog website with markdown support and a dark theme";

    const generationScript = `const fs = require('fs');

async function loadClaudeCode() {
  return await import(${JSON.stringify(sdkPath)});
}

async function generateWebsite() {
  const { query } = await loadClaudeCode();
  const prompt = ${JSON.stringify(`${userPrompt}
  
  Important requirements:
  - Create a NextJS app with TypeScript and Tailwind CSS
  - Use the app directory structure
  - Create all files in the current directory
  - Include a package.json with all necessary dependencies
  - Make the design modern and responsive
  - Add at least a home page and one other page
  - Include proper navigation between pages
  `)};

  console.log('Starting website generation with Claude Code...');
  console.log('Working directory:', process.cwd());
  
  const messages = [];
  const abortController = new AbortController();
  
  try {
    for await (const message of query({
      prompt: prompt,
      abortController: abortController,
      options: {
        maxTurns: 20,
        allowedTools: [
          'Read',
          'Write',
          'Edit',
          'MultiEdit',
          'Bash',
          'LS',
          'Glob',
          'Grep'
        ]
      }
    })) {
      messages.push(message);
      
      if (message.type === 'text') {
        console.log('[Claude]:', (message.text || '').substring(0, 80) + '...');
        console.log('__CLAUDE_MESSAGE__', JSON.stringify({ type: 'assistant', content: message.text }));
      } else if (message.type === 'tool_use') {
        console.log('[Tool]:', message.name, message.input?.file_path || '');
        console.log('__TOOL_USE__', JSON.stringify({ 
          type: 'tool_use', 
          name: message.name, 
          input: message.input 
        }));
      } else if (message.type === 'result') {
        console.log('__TOOL_RESULT__', JSON.stringify({ 
          type: 'tool_result', 
          result: message.result 
        }));
      }
    }
    
    console.log('\\nGeneration complete!');
    console.log('Total messages:', messages.length);
    
    fs.writeFileSync('generation-log.json', JSON.stringify(messages, null, 2));
    
    const files = fs.readdirSync('.').filter(f => !f.startsWith('.'));
    console.log('\\nGenerated files:', files.join(', '));
    
  } catch (error) {
    console.error('Generation error:', error);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

generateWebsite().catch((error) => {
  console.error(error);
  process.exit(1);
});`;

    await sandbox.process.executeCommand(
      `cat > generate.js << 'SCRIPT_EOF'\n${generationScript}\nSCRIPT_EOF`,
      projectDir
    );
    console.log("✓ Generation script written to generate.js");

    const checkScript = await sandbox.process.executeCommand(
      "ls -la generate.js && head -12 generate.js",
      projectDir
    );
    console.log("Script verification:", checkScript.result);

    // Step 7: Run the generation script
    console.log("\n7. Running Claude Code generation...");
    console.log(`Prompt: "${userPrompt}"`);
    console.log("\nThis may take several minutes...\n");

    const genResult = await sandbox.process.executeCommand(
      "node generate.js",
      projectDir,
      {
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        NODE_PATH: `${runnerDir}/node_modules`,
      },
      600
    );

    console.log("\nGeneration output:");
    console.log(genResult.result);

    if (genResult.exitCode !== 0) {
      throw new Error("Generation failed");
    }

    // Step 8: Check generated files
    console.log("\n8. Checking generated files...");
    const filesResult = await sandbox.process.executeCommand("ls -la", projectDir);
    console.log(filesResult.result);

    // Step 9: Install dependencies if package.json was updated
    const hasNextJS = await sandbox.process.executeCommand(
      "test -f package.json && grep -q next package.json && echo yes || echo no",
      projectDir
    );

    if (hasNextJS.result?.trim() === "yes") {
      console.log("\n9. Installing project dependencies...");
      const npmInstall = await sandbox.process.executeCommand(
        "npm install",
        projectDir,
        undefined,
        300
      );

      if (npmInstall.exitCode !== 0) {
        console.log("Warning: npm install had issues:", npmInstall.result);
      } else {
        console.log("✓ Dependencies installed");
      }

      // Step 10: Start dev server in background
      console.log("\n10. Starting development server in background...");

      await sandbox.process.executeCommand(
        `nohup npm run dev > dev-server.log 2>&1 &`,
        projectDir,
        { PORT: "3000" }
      );

      console.log("✓ Server started in background");

      console.log("Waiting for server to start...");
      await new Promise((resolve) => setTimeout(resolve, 8000));

      const checkServer = await sandbox.process.executeCommand(
        "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000 || echo 'failed'",
        projectDir
      );

      if (checkServer.result?.trim() === "200") {
        console.log("✓ Server is running!");
      } else {
        console.log("⚠️  Server might still be starting...");
        console.log("You can check logs with: cat dev-server.log");
      }
    }

    // Step 11: Get preview URL
    console.log("\n11. Getting preview URL...");
    const preview = await sandbox.getPreviewLink(3000);

    console.log("\n✨ SUCCESS! Website generated!");
    console.log("\n📊 SUMMARY:");
    console.log("===========");
    console.log(`Sandbox ID: ${sandboxId}`);
    console.log(`Project Directory: ${projectDir}`);
    console.log(`Preview URL: ${preview.url}`);
    if (preview.token) {
      console.log(`Access Token: ${preview.token}`);
    }

    console.log("\n🌐 VISIT YOUR WEBSITE:");
    console.log(preview.url);

    console.log("\n💡 TIPS:");
    console.log("- The sandbox will stay active for debugging");
    console.log("- Server logs: SSH in and run 'cat website-project/dev-server.log'");
    console.log(
      `- To get preview URL again: npx tsx scripts/get-preview-url.ts ${sandboxId}`
    );
    console.log(
      `- To reuse this sandbox: npx tsx scripts/generate-in-daytona.ts ${sandboxId}`
    );
    console.log(`- To remove: npx tsx scripts/remove-sandbox.ts ${sandboxId}`);

    return {
      success: true,
      sandboxId: sandboxId,
      projectDir: projectDir,
      previewUrl: preview.url,
    };
  } catch (error: any) {
    console.error("\n❌ ERROR:", error.message);

    if (sandbox) {
      console.log(`\nSandbox ID: ${sandboxId}`);
      console.log("The sandbox is still running for debugging.");

      try {
        const debugInfo = await sandbox.process.executeCommand(
          "pwd && echo '---' && ls -la && echo '---' && test -f generate.js && cat generate.js | head -20 || echo 'No script'",
          `${await sandbox.getUserRootDir()}/website-project`
        );
        console.log("\nDebug info:");
        console.log(debugInfo.result);
      } catch (e) {
        // Ignore debug collection failures
      }
    }

    throw error;
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  let sandboxId: string | undefined;
  let prompt: string | undefined;

  if (args.length > 0) {
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(args[0])) {
      sandboxId = args[0];
      prompt = args.slice(1).join(" ");
    } else {
      prompt = args.join(" ");
    }
  }

  if (!prompt) {
    prompt =
      "Create a modern blog website with markdown support and a dark theme. Include a home page, blog listing page, and individual blog post pages.";
  }

  console.log("📝 Configuration:");
  console.log(
    `- Sandbox: ${sandboxId ? `Using existing ${sandboxId}` : "Creating new"}`
  );
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
