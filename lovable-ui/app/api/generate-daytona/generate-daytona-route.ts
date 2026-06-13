import { NextRequest } from "next/server";
import { spawn } from "child_process";
import path from "path";

export async function POST(req: NextRequest) {
  try {
    const { prompt } = await req.json();

    if (!prompt) {
      return new Response(JSON.stringify({ error: "Prompt is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!process.env.DAYTONA_API_KEY || !process.env.ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: "Missing API keys: set DAYTONA_API_KEY and ANTHROPIC_API_KEY in .env.local" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    console.log("[API] Starting Daytona generation for prompt:", prompt);

    const encoder = new TextEncoder();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();

    let writerClosed = false;

    async function safeWrite(data: string) {
      if (!writerClosed) {
        try {
          await writer.write(encoder.encode(data));
        } catch (e) {
          // writer already closed
        }
      }
    }

    async function safeClose() {
      if (!writerClosed) {
        writerClosed = true;
        try {
          await writer.close();
        } catch (e) {
          // already closed
        }
      }
    }

    (async () => {
      try {
        // FIX: scripts path - in Next.js, process.cwd() is the lovable-ui directory
        const scriptPath = path.join(process.cwd(), "scripts", "generate-in-daytona.ts");

        // FIX: use npx tsx (now in devDependencies) to run the TypeScript script
        const child = spawn("npx", ["tsx", scriptPath, prompt], {
          env: {
            ...process.env,
            DAYTONA_API_KEY: process.env.DAYTONA_API_KEY!,
            ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
          },
        });

        let sandboxId = "";
        let previewUrl = "";
        let buffer = "";

        child.stdout.on("data", async (data: Buffer) => {
          buffer += data.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;

            if (line.includes("__CLAUDE_MESSAGE__")) {
              const jsonStart =
                line.indexOf("__CLAUDE_MESSAGE__") +
                "__CLAUDE_MESSAGE__".length;
              try {
                const message = JSON.parse(line.substring(jsonStart).trim());
                await safeWrite(
                  `data: ${JSON.stringify({
                    type: "claude_message",
                    content: message.content,
                  })}\n\n`
                );
              } catch (e) {}
            } else if (line.includes("__TOOL_USE__")) {
              const jsonStart =
                line.indexOf("__TOOL_USE__") + "__TOOL_USE__".length;
              try {
                const toolUse = JSON.parse(line.substring(jsonStart).trim());
                await safeWrite(
                  `data: ${JSON.stringify({
                    type: "tool_use",
                    name: toolUse.name,
                    input: toolUse.input,
                  })}\n\n`
                );
              } catch (e) {}
            } else if (line.includes("__TOOL_RESULT__")) {
              continue;
            } else {
              const output = line.trim();
              if (
                output &&
                !output.includes("[Claude]:") &&
                !output.includes("[Tool]:") &&
                !output.includes("__")
              ) {
                await safeWrite(
                  `data: ${JSON.stringify({
                    type: "progress",
                    message: output,
                  })}\n\n`
                );

                const sandboxMatch = output.match(
                  /Sandbox (?:created|ID): ([a-f0-9-]+)/
                );
                if (sandboxMatch) sandboxId = sandboxMatch[1];

                const previewMatch = output.match(
                  /Preview URL: (https?:\/\/[^\s]+)/
                );
                if (previewMatch) previewUrl = previewMatch[1];
              }
            }
          }
        });

        child.stderr.on("data", async (data: Buffer) => {
          const error = data.toString();
          console.error("[Daytona Error]:", error);
          if (error.includes("Error") || error.includes("Failed")) {
            await safeWrite(
              `data: ${JSON.stringify({
                type: "error",
                message: error.trim(),
              })}\n\n`
            );
          }
        });

        await new Promise<void>((resolve, reject) => {
          child.on("exit", (code: number | null) => {
            if (code === 0) resolve();
            else reject(new Error(`Process exited with code ${code}`));
          });
          child.on("error", reject);
        });

        if (previewUrl) {
          await safeWrite(
            `data: ${JSON.stringify({
              type: "complete",
              sandboxId,
              previewUrl,
            })}\n\n`
          );
          console.log(`[API] Generation complete. Preview URL: ${previewUrl}`);
        } else {
          throw new Error(
            "Failed to get preview URL — check that DAYTONA_API_KEY is valid and sandbox was created."
          );
        }

        await safeWrite("data: [DONE]\n\n");
      } catch (error: any) {
        console.error("[API] Error during generation:", error);
        await safeWrite(
          `data: ${JSON.stringify({
            type: "error",
            message: error.message,
          })}\n\n`
        );
        await safeWrite("data: [DONE]\n\n");
      } finally {
        await safeClose();
      }
    })();

    return new Response(stream.readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error: any) {
    console.error("[API] Error:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
