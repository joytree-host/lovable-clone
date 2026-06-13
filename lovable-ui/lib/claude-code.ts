import { spawn } from "child_process";

export interface SDKMessage {
  type: string;
  content?: string;
  name?: string;
  input?: Record<string, unknown>;
  subtype?: string;
}

export interface CodeGenerationResult {
  success: boolean;
  messages: SDKMessage[];
  error?: string;
}

// FIX: @anthropic-ai/claude-code no longer exports query() — it's now CLI-only.
// Use the `claude` CLI via child_process with --output-format stream-json.
export async function generateCodeWithClaude(
  prompt: string
): Promise<CodeGenerationResult> {
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
          env: { ...process.env },
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
              }
              for (const tool of (msg.message?.content || []).filter(
                (b: any) => b.type === "tool_use"
              )) {
                messages.push({ type: "tool_use", name: tool.name, input: tool.input });
              }
            } else if (msg.type === "result") {
              messages.push({ type: "result", subtype: msg.subtype });
            }
          } catch (e) {
            /* skip non-JSON */
          }
        }
      });

      claude.stderr.on("data", (data: Buffer) => {
        console.error("[claude stderr]:", data.toString().trim());
      });

      claude.on("close", (code: number) => {
        if (code === 0) resolve();
        else reject(new Error(`Claude CLI exited with code ${code}`));
      });

      claude.on("error", (err: Error) =>
        reject(new Error(`Failed to spawn claude CLI: ${err.message}`))
      );
    });

    return { success: true, messages };
  } catch (error: any) {
    console.error("Error generating code:", error);
    return { success: false, messages: [], error: error.message };
  }
}
