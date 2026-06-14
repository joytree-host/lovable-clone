import { spawn } from "child_process";

export interface SDKMessage {
  type: string;
  content?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface CodeGenerationResult {
  success: boolean;
  messages: SDKMessage[];
  error?: string;
}

export async function generateCodeWithClaude(
  prompt: string
): Promise<CodeGenerationResult> {
  // FIX: @anthropic-ai/claude-code no longer exports a query() function.
  // The package is now only a CLI binary. Use the `claude` CLI via subprocess
  // with --print --output-format stream-json for programmatic use.
  try {
    const messages: SDKMessage[] = [];

    await new Promise<void>((resolve, reject) => {
      const claude = spawn(
        "claude",
        [
          "--print",
          "--output-format",
          "stream-json",
          "--allowedTools",
          "Read,Write,Edit,MultiEdit,Bash,LS,Glob,Grep",
          "--max-turns",
          "10",
          "--dangerously-skip-permissions",
          prompt,
        ],
        {
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
          },
          cwd: process.cwd(),
        }
      );

      let buffer = "";

      claude.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);

            if (msg.type === "assistant") {
              const textBlock = (msg.message?.content || []).find(
                (b: any) => b.type === "text"
              );
              if (textBlock) {
                messages.push({ type: "assistant", content: textBlock.text });
                console.log(`[assistant]`, textBlock.text.substring(0, 80));
              }
              for (const tool of (msg.message?.content || []).filter(
                (b: any) => b.type === "tool_use"
              )) {
                messages.push({
                  type: "tool_use",
                  name: tool.name,
                  input: tool.input,
                });
                console.log(
                  `[tool_use]`,
                  tool.name,
                  tool.input?.file_path || tool.input?.command || ""
                );
              }
            } else if (msg.type === "result") {
              console.log(`[result]`, msg.subtype);
            }
          } catch (e) {
            /* skip non-JSON */
          }
        }
      });

      claude.stderr.on("data", (data: Buffer) => {
        const err = data.toString().trim();
        if (err) console.error("[claude stderr]:", err);
      });

      claude.on("close", (code: number) => {
        if (code === 0) resolve();
        else reject(new Error(`Claude CLI exited with code ${code}`));
      });

      claude.on("error", (err: Error) => {
        reject(
          new Error(
            `Failed to spawn claude CLI: ${err.message}. Make sure @anthropic-ai/claude-code is installed globally.`
          )
        );
      });
    });

    return { success: true, messages };
  } catch (error: any) {
    console.error("Error generating code:", error);
    return { success: false, messages: [], error: error.message };
  }
}
